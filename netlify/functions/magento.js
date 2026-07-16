const https = require('https');

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
}

const BASE = process.env.MAGENTO_BASE_URL || 'https://kingenginebuilders.com';

function salesSummaryUrl(from, to, fields, manufacturer) {
  const parts = [
    ['searchCriteria[filterGroups][1][filters][0][field]', 'created_at'],
    ['searchCriteria[filterGroups][1][filters][0][conditionType]', 'gteq'],
    ['searchCriteria[filterGroups][1][filters][0][value]', from],
    ['searchCriteria[filterGroups][2][filters][0][field]', 'created_at'],
    ['searchCriteria[filterGroups][2][filters][0][conditionType]', 'lteq'],
    ['searchCriteria[filterGroups][2][filters][0][value]', to]
  ];
  if (manufacturer) {
    parts.push(
      ['searchCriteria[filterGroups][3][filters][0][field]', 'manufacturer'],
      ['searchCriteria[filterGroups][3][filters][0][conditionType]', 'eq'],
      ['searchCriteria[filterGroups][3][filters][0][value]', manufacturer]
    );
  }
  parts.push(['fields', fields]);
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

// Exact manufacturer labels as they exist in Magento. The server's own "revenue"
// field is inflated when a manufacturer filter is applied, so brand revenue is
// summed from the (already brand-filtered) order_items row_totals instead.
const BRANDS = [
  { name: 'King Bearings', manufacturer: 'King Engine Bearings' },
  { name: 'UEM Pistons', manufacturer: 'UEM Pistons & Rings' },
  { name: 'CP Carrillo', manufacturer: 'CP-Carrillo' },
  { name: 'Turbosmart', manufacturer: 'Turbosmart' }
];

// One brand per invocation: the four YTD queries together exceed Netlify's
// 10s function timeout on a cold Magento cache, so the frontend fetches each
// brand in parallel instead.
async function brandView(brandName) {
  const brand = BRANDS.find(b => b.name === brandName);
  if (!brand) throw new Error('Unknown brand: ' + brandName);
  const now = new Date();
  const curMonth = now.getMonth();
  const from = `${now.getFullYear()}-01-01 00:00:00`;
  const to = `${now.getFullYear()}-${pad(curMonth + 1)}-${pad(now.getDate())} 23:59:59`;
  const FIELDS = 'orders[items[date,status,order_items[row_total]]]';
  const data = await apiGet(salesSummaryUrl(from, to, FIELDS, brand.manufacturer));
  const monthly = new Array(curMonth + 1).fill(0);
  for (const o of ((data.orders && data.orders.items) || [])) {
    if (o.status === 'canceled' || o.status === 'closed') continue;
    const m = parseInt(String(o.date).slice(5, 7), 10) - 1;
    if (m < 0 || m > curMonth) continue;
    for (const p of (o.order_items || [])) monthly[m] += p.row_total || 0;
  }
  const rounded = monthly.map(v => Math.round(v * 100) / 100);
  return {
    connected: true,
    labels: MONTH_NAMES.slice(0, curMonth + 1),
    name: brand.name,
    monthly: rounded,
    total: Math.round(rounded.reduce((s, v) => s + v, 0) * 100) / 100
  };
}

exports.handler = async function (event) {
  if (!process.env.MAGENTO_TOKEN) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false }) };
  }
  try {
    const qs = (event && event.queryStringParameters) || {};
    if (qs.view === 'brand') {
      return { statusCode: 200, headers: cors(), body: JSON.stringify(await brandView(qs.brand)) };
    }
    if (qs.view === 'brandlist') {
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: true, brands: BRANDS.map(b => b.name) }) };
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
