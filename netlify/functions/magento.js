const https = require('https');

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
}

const BASE = process.env.MAGENTO_BASE_URL || 'https://kingenginebuilders.com';

function salesSummaryUrl(from, to, fields) {
  const parts = [
    ['searchCriteria[filterGroups][1][filters][0][field]', 'created_at'],
    ['searchCriteria[filterGroups][1][filters][0][conditionType]', 'gteq'],
    ['searchCriteria[filterGroups][1][filters][0][value]', from],
    ['searchCriteria[filterGroups][2][filters][0][field]', 'created_at'],
    ['searchCriteria[filterGroups][2][filters][0][conditionType]', 'lteq'],
    ['searchCriteria[filterGroups][2][filters][0][value]', to],
    ['fields', fields]
  ];
  return `${BASE}/rest/V1/dashboard/sales-summary?` + parts.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function apiGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Authorization': `Bearer ${process.env.MAGENTO_TOKEN}` } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Magento ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON from Magento: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
  });
}

function pad(n) { return String(n).padStart(2, '0'); }

// Month window in Magento admin timezone terms: plain calendar dates, no TZ math.
function monthWindow(monthsAgo) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 0);
  const from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01 00:00:00`;
  const to = `${endOfMonth.getFullYear()}-${pad(endOfMonth.getMonth() + 1)}-${pad(endOfMonth.getDate())} 23:59:59`;
  return { from, to, label: MONTH_NAMES[start.getMonth()] };
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function orderStats(data) {
  const items = (data.orders && data.orders.items) || [];
  const live = items.filter(o => o.status !== 'canceled' && o.status !== 'closed');
  return { revenue: data.revenue || 0, orders: live.length, items: live };
}

function topProducts(items, limit) {
  const byName = {};
  for (const o of items) {
    for (const p of (o.order_items || [])) {
      byName[p.product_name] = (byName[p.product_name] || 0) + (p.row_total || 0);
    }
  }
  return Object.entries(byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }));
}

function pctChange(cur, prev) { return prev ? ((cur - prev) / prev) * 100 : (cur ? 100 : 0); }

// Brand revenue is classified per ORDER ITEM by product line, from one
// unfiltered query. The API's manufacturer filter is unusable for this:
// its "revenue" field is inflated by a broken join (a single day's King
// "revenue" exceeds the whole store's revenue that day), its order_items
// are whole orders rather than brand-filtered items, and products missing
// the manufacturer attribute escape it entirely. Item-level name rules were
// validated against the data: the UEM rule reconciles to the cent with the
// server's own UEM figure once KB Forged pistons are included.
// First matching rule wins. UEM covers its product lines (ICON, Silv-O-Lite,
// KB, Dualoy); Turbosmart products often omit the brand from the name, so its
// rule matches the product types it sells here (boost controllers, BOVs,
// wastegate parts). King is a positive match on its very regular naming;
// anything left (drill bits, apparel, unknown part numbers) is Merch & Other.
const BRAND_RULES = [
  { name: 'UEM Pistons & Rings', re: /\b(icon|silv-?o-?lite|kb|dualoy|milwaukee 8|s9901hc)\b/i },
  { name: 'CP Carrillo', re: /carrillo/i },
  { name: 'Turbosmart', re: /(turbosmart|boost tee|boost controller|\bbov\b|raceport|genv|wg\d{2}|v-band|vac hose|oil drain)/i },
  { name: 'Merch & Other', re: /(t-?shirt|\bhat\b|\bcap\b|hoodie|sticker|banner|beanie|keychain|lanyard|long sleeve)/i },
  { name: 'King Bearings', re: /(bearing|thrust washer|polymer|bushing|\bmb\s?\d|\bcr\s?\d|\btw\s?\d|king)/i },
  { name: 'Merch & Other', re: null }
];
const BRAND_ORDER = ['King Bearings', 'UEM Pistons & Rings', 'CP Carrillo', 'Turbosmart', 'Merch & Other'];

async function brandsView() {
  const now = new Date();
  const curMonth = now.getMonth();
  // One request per calendar month, in parallel: a single YTD query takes
  // ~10s uncached (right at the Netlify function timeout), while parallel
  // month queries finish in the time of the slowest single month.
  const FIELDS = 'orders[items[status,order_items[product_name,row_total]]]';
  const windows = [];
  for (let m = curMonth; m >= 0; m--) windows.push(monthWindow(m));
  const perMonth = await Promise.all(windows.map(w => apiGet(salesSummaryUrl(w.from, w.to, FIELDS))));
  const monthlyByBrand = {};
  for (const r of BRAND_RULES) monthlyByBrand[r.name] = new Array(curMonth + 1).fill(0);
  perMonth.forEach((data, m) => {
    for (const o of ((data.orders && data.orders.items) || [])) {
      if (o.status === 'canceled' || o.status === 'closed') continue;
      for (const p of (o.order_items || [])) {
        const rule = BRAND_RULES.find(r => !r.re || r.re.test(p.product_name || ''));
        monthlyByBrand[rule.name][m] += p.row_total || 0;
      }
    }
  });
  const brands = BRAND_ORDER.map(name => {
    const monthly = monthlyByBrand[name].map(v => Math.round(v * 100) / 100);
    return { name, monthly, total: Math.round(monthly.reduce((s, v) => s + v, 0) * 100) / 100 };
  });
  return { connected: true, labels: MONTH_NAMES.slice(0, curMonth + 1), brands };
}

// Monthly eCommerce KPIs. AOV = sum of completed orders' grand totals divided
// by the completed-order count for the month (completed = not canceled/closed).
// Returning Buyers is reported as unavailable: the sales-summary API exposes
// no customer identity (customer_email/customer_id are silently dropped), so
// actual repeat-purchaser counts cannot be computed from it.
async function monthlyKpis(year) {
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();
  const nMonths = isCurrentYear ? now.getMonth() + 1 : 12;
  const windows = [];
  for (let m = 0; m < nMonths; m++) {
    const endOfMonth = new Date(year, m + 1, 0);
    windows.push({
      from: `${year}-${pad(m + 1)}-01 00:00:00`,
      to: `${year}-${pad(m + 1)}-${pad(endOfMonth.getDate())} 23:59:59`
    });
  }
  const FIELDS = 'orders[items[status,grand_total]]';
  const perMonth = await Promise.all(windows.map(w => apiGet(salesSummaryUrl(w.from, w.to, FIELDS))));
  const orders = new Array(nMonths).fill(null);
  const amount = new Array(nMonths).fill(null);
  const aov = new Array(nMonths).fill(null);
  perMonth.forEach((data, m) => {
    const items = ((data.orders && data.orders.items) || []).filter(o => o.status !== 'canceled' && o.status !== 'closed');
    orders[m] = items.length;
    amount[m] = Math.round(items.reduce((s, o) => s + (o.grand_total || 0), 0) * 100) / 100;
    aov[m] = items.length ? Math.round(amount[m] / items.length * 100) / 100 : null;
  });
  return {
    connected: true,
    year,
    monthLabels: MONTH_NAMES.slice(0, nMonths),
    currentMonthIsMtd: isCurrentYear,
    orders, amount, aov,
    returningBuyers: null,
    returningBuyersAvailable: false,
    generatedAt: new Date().toISOString()
  };
}

exports.handler = async function (event) {
  if (!process.env.MAGENTO_TOKEN) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false }) };
  }
  try {
    const qs = (event && event.queryStringParameters) || {};
    if (qs.view === 'brands') {
      return { statusCode: 200, headers: cors(), body: JSON.stringify(await brandsView()) };
    }
    if (qs.view === 'monthly') {
      const year = Math.min(Math.max(parseInt(qs.year, 10) || new Date().getFullYear(), 2015), new Date().getFullYear());
      return { statusCode: 200, headers: cors(), body: JSON.stringify(await monthlyKpis(year)) };
    }
    const ORDER_FIELDS = 'revenue,orders[items[status,grand_total,order_items[product_name,row_total]]]';
    const thisMonth = monthWindow(0);
    const lastMonth = monthWindow(1);

    // Rolling 12 months of revenue-only queries (months 11..1 ago); current month comes from the orders query.
    const pastWindows = [];
    for (let m = 11; m >= 1; m--) pastWindows.push(monthWindow(m));

    const [thisData, lastData, ...pastRevenues] = await Promise.all([
      apiGet(salesSummaryUrl(thisMonth.from, thisMonth.to, ORDER_FIELDS)),
      apiGet(salesSummaryUrl(lastMonth.from, lastMonth.to, ORDER_FIELDS)),
      ...pastWindows.map(w => apiGet(salesSummaryUrl(w.from, w.to, 'revenue')))
    ]);

    const cur = orderStats(thisData);
    const prev = orderStats(lastData);
    const aovCur = cur.orders ? cur.revenue / cur.orders : 0;
    const aovPrev = prev.orders ? prev.revenue / prev.orders : 0;

    const labels = pastWindows.map(w => w.label).concat(thisMonth.label);
    const revenue = pastRevenues.map(r => r.revenue || 0).concat(cur.revenue);

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        connected: true,
        revenueThisMonth: cur.revenue,
        revenueGrowthPct: pctChange(cur.revenue, prev.revenue),
        ordersThisMonth: cur.orders,
        ordersGrowthPct: pctChange(cur.orders, prev.orders),
        aovThisMonth: aovCur,
        aovGrowthPct: pctChange(aovCur, aovPrev),
        monthlyTrend: { labels, revenue },
        topProducts: topProducts(cur.items, 5)
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ connected: false, error: e.message }) };
  }
};
