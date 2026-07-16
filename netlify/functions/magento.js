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

exports.handler = async function () {
  if (!process.env.MAGENTO_TOKEN) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false }) };
  }
  try {
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
