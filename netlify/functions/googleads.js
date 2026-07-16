const https = require('https');

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
}

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v24';
const TARGET_CUSTOMER_ID = '2801560311';
const LOGIN_CUSTOMER_ID = '1510947200';

function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Google auth ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad token response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const res = await postForm('https://oauth2.googleapis.com/token', {
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  return res.access_token;
}

function gaqlSearch(token, query) {
  const body = JSON.stringify({ query });
  return new Promise((resolve, reject) => {
    const url = new URL(`https://googleads.googleapis.com/${API_VERSION}/customers/${TARGET_CUSTOMER_ID}/googleAds:search`);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': LOGIN_CUSTOMER_ID,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Google Ads API ${res.statusCode}: ${data.slice(0, 600)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON from Google Ads: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function accountMetrics(token, dateRangeLiteral) {
  const query = `SELECT metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date DURING ${dateRangeLiteral}`;
  const res = await gaqlSearch(token, query);
  const row = res.results && res.results[0];
  if (!row) return { clicks: 0, impressions: 0, cost: 0, conversions: 0 };
  const m = row.metrics;
  return {
    clicks: Number(m.clicks || 0),
    impressions: Number(m.impressions || 0),
    cost: Number(m.costMicros || 0) / 1e6,
    conversions: Number(m.conversions || 0)
  };
}

function ymd(d) { return d.toISOString().slice(0, 10); }
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

async function monthlyTrend(token) {
  const now = new Date();
  const from = `${now.getFullYear()}-01-01`;
  const to = ymd(now);
  const query = `SELECT segments.month, metrics.cost_micros, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}' ORDER BY segments.month`;
  const res = await gaqlSearch(token, query);
  const cost = new Array(12).fill(null);
  const clicks = new Array(12).fill(null);
  const conversions = new Array(12).fill(null);
  for (const r of (res.results || [])) {
    const m = parseInt(r.segments.month.slice(5, 7), 10) - 1;
    cost[m] = Number(r.metrics.costMicros || 0) / 1e6;
    clicks[m] = Number(r.metrics.clicks || 0);
    conversions[m] = Number(r.metrics.conversions || 0);
  }
  return { labels: MONTH_NAMES, cost, clicks, conversions };
}

async function topCampaigns(token) {
  const query = `SELECT campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 5`;
  const res = await gaqlSearch(token, query);
  return (res.results || []).map(r => ({
    name: r.campaign.name,
    cost: Number(r.metrics.costMicros || 0) / 1e6,
    clicks: Number(r.metrics.clicks || 0),
    conversions: Number(r.metrics.conversions || 0)
  }));
}

function pctChange(cur, prev) { return prev ? ((cur - prev) / prev) * 100 : (cur ? 100 : 0); }

// Monthly KPI view: cost/clicks/impressions from the account, plus orders and
// order value restricted to PURCHASE-category conversions only (per spec:
// no add-to-cart, checkout, calls, forms, or other non-purchase conversions).
async function monthlyKpis(token, year) {
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();
  const from = `${year}-01-01`;
  const to = isCurrentYear ? ymd(now) : `${year}-12-31`;
  const nMonths = isCurrentYear ? now.getMonth() + 1 : 12;

  // Resolve the real order trackers first: enabled PURCHASE actions that are
  // primary for goals. This account also has legacy page-load "Purchase"
  // counters recording ~$1 junk values, which were primary until June, so
  // neither metrics.conversions nor a category filter alone gives clean
  // history — the actions must be pinned by name.
  const actionsRes = await gaqlSearch(token, `SELECT conversion_action.name FROM conversion_action WHERE conversion_action.category = 'PURCHASE' AND conversion_action.status = 'ENABLED' AND conversion_action.primary_for_goal = true`);
  const actionNames = (actionsRes.results || []).map(r => r.conversionAction.name);
  const purchaseConfigured = actionNames.length > 0;
  const nameList = actionNames.map(n => `'${n.replace(/'/g, "\\'")}'`).join(', ');

  const [base, purchases] = await Promise.all([
    gaqlSearch(token, `SELECT segments.month, metrics.cost_micros, metrics.clicks, metrics.impressions FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}' ORDER BY segments.month`),
    purchaseConfigured
      ? gaqlSearch(token, `SELECT segments.month, segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}' AND segments.conversion_action_name IN (${nameList}) ORDER BY segments.month`)
      : Promise.resolve({ results: [] })
  ]);
  const cost = new Array(nMonths).fill(null);
  const clicks = new Array(nMonths).fill(null);
  const impressions = new Array(nMonths).fill(null);
  // The account reports zero activity by omitting the month row, so months
  // inside a period the account reported on are confirmed zeros, not gaps.
  const hasBaseData = !!(base.results && base.results.length);
  if (hasBaseData) { cost.fill(0); clicks.fill(0); impressions.fill(0); }
  for (const r of (base.results || [])) {
    const m = parseInt(r.segments.month.slice(5, 7), 10) - 1;
    if (m >= nMonths) continue;
    cost[m] = Number(r.metrics.costMicros || 0) / 1e6;
    clicks[m] = Number(r.metrics.clicks || 0);
    impressions[m] = Number(r.metrics.impressions || 0);
  }
  const purchaseOrders = new Array(nMonths).fill(purchaseConfigured && hasBaseData ? 0 : null);
  const purchaseValue = new Array(nMonths).fill(purchaseConfigured && hasBaseData ? 0 : null);
  if (purchaseConfigured) {
    for (const r of (purchases.results || [])) {
      const m = parseInt(r.segments.month.slice(5, 7), 10) - 1;
      if (m >= nMonths) continue;
      purchaseOrders[m] = (purchaseOrders[m] || 0) + Number(r.metrics.allConversions || 0);
      purchaseValue[m] = (purchaseValue[m] || 0) + Number(r.metrics.allConversionsValue || 0);
    }
  }
  return {
    connected: true,
    year,
    monthLabels: MONTH_NAMES.slice(0, nMonths),
    currentMonthIsMtd: isCurrentYear,
    cost, clicks, impressions, purchaseOrders, purchaseValue,
    purchaseConfigured,
    generatedAt: new Date().toISOString()
  };
}

exports.handler = async function (event) {
  if (!process.env.GOOGLE_ADS_CLIENT_ID || !process.env.GOOGLE_ADS_CLIENT_SECRET || !process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false }) };
  }
  try {
    const token = await getAccessToken();
    const qs = (event && event.queryStringParameters) || {};
    if (qs.view === 'diag') {
      const now = new Date();
      const [actions, byName] = await Promise.all([
        gaqlSearch(token, `SELECT conversion_action.name, conversion_action.category, conversion_action.status, conversion_action.type, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status = 'ENABLED'`),
        gaqlSearch(token, `SELECT segments.conversion_action_name, segments.conversion_action_category, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE segments.date BETWEEN '${now.getFullYear()}-01-01' AND '${ymd(now)}'`)
      ]);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: true, actions: actions.results || [], byName: byName.results || [] }) };
    }
    if (qs.view === 'monthly') {
      const year = Math.min(Math.max(parseInt(qs.year, 10) || new Date().getFullYear(), 2015), new Date().getFullYear());
      return { statusCode: 200, headers: cors(), body: JSON.stringify(await monthlyKpis(token, year)) };
    }
    const [thisMonth, lastMonth, campaigns, trend] = await Promise.all([
      accountMetrics(token, 'THIS_MONTH'),
      accountMetrics(token, 'LAST_MONTH'),
      topCampaigns(token),
      monthlyTrend(token)
    ]);
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        connected: true,
        costThisMonth: thisMonth.cost,
        costGrowthPct: pctChange(thisMonth.cost, lastMonth.cost),
        clicksThisMonth: thisMonth.clicks,
        clicksGrowthPct: pctChange(thisMonth.clicks, lastMonth.clicks),
        conversionsThisMonth: thisMonth.conversions,
        conversionsGrowthPct: pctChange(thisMonth.conversions, lastMonth.conversions),
        topCampaigns: campaigns,
        monthlyTrend: trend
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ connected: false, error: e.message }) };
  }
};
