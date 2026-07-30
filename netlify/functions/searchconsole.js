const https = require('https');
const crypto = require('crypto');

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Search Console needs its own scope, so this cannot reuse the GA4 token.
function signJwt(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return signingInput + '.' + sig;
}

function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Google auth ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const clientEmail = process.env.GA_CLIENT_EMAIL;
  const privateKey = (process.env.GA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const res = await postForm('https://oauth2.googleapis.com/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signJwt(clientEmail, privateKey)
  });
  return res.access_token;
}

function apiRequest(method, url, token, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve, reject) => {
    const headers = { 'Authorization': `Bearer ${token}` };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Search Console ${res.statusCode}: ${data.slice(0, 400)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON from Search Console')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// The property identifier differs by how it was verified: a domain property is
// "sc-domain:example.com", a URL-prefix property is the full URL. Rather than
// guess, ask the API which properties this service account can actually see.
async function resolveSite(token, preferred) {
  const list = await apiRequest('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites', token);
  const entries = (list.siteEntry || []).map(s => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
  if (preferred && entries.some(e => e.siteUrl === preferred)) return { site: preferred, entries };
  const king = entries.find(e => /kingenginebuilders/i.test(e.siteUrl));
  return { site: king ? king.siteUrl : null, entries };
}

async function queryRows(token, site, dimensions, from, to, rowLimit) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await apiRequest('POST', url, token, {
    startDate: from, endDate: to, dimensions, rowLimit: rowLimit || 250, dataState: 'all'
  });
  return (res.rows || []).map(r => ({
    keys: r.keys,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: Math.round((r.ctr || 0) * 10000) / 100,
    position: Math.round((r.position || 0) * 10) / 10
  }));
}

exports.handler = async function (event) {
  if (!process.env.GA_CLIENT_EMAIL || !process.env.GA_PRIVATE_KEY) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false, error: 'GA service account not configured' }) };
  }
  try {
    const qs = (event && event.queryStringParameters) || {};
    const token = await getAccessToken();
    const { site, entries } = await resolveSite(token, qs.site);

    if (qs.view === 'sites' || !site) {
      return {
        statusCode: 200, headers: cors(),
        body: JSON.stringify({
          connected: !!site, resolvedSite: site, accessibleProperties: entries,
          hint: site ? undefined : 'The service account can see no property matching kingenginebuilders. It needs adding as a user with Full permission in Search Console.'
        })
      };
    }

    // Search Console data lags roughly 2 to 3 days, so end the window short of today.
    const now = new Date();
    const to = qs.to || ymd(new Date(now.getTime() - 3 * 864e5));
    const from = qs.from || ymd(new Date(now.getTime() - 93 * 864e5));

    const [queries, pages, byDate] = await Promise.all([
      queryRows(token, site, ['query'], from, to, 500),
      queryRows(token, site, ['page'], from, to, 250),
      queryRows(token, site, ['date'], from, to, 100)
    ]);

    const brandRe = /king/i;
    const nonBranded = queries.filter(q => !brandRe.test(q.keys[0]));
    const branded = queries.filter(q => brandRe.test(q.keys[0]));
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);

    // The two opportunity sets that actually change what to do next.
    const highImpLowCtr = nonBranded
      .filter(q => q.impressions >= 100 && q.ctr < 2)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 30);
    const pageTwo = nonBranded
      .filter(q => q.position >= 8 && q.position <= 25 && q.impressions >= 20)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 30);

    return {
      statusCode: 200, headers: cors(),
      body: JSON.stringify({
        connected: true, site, dateRange: { from, to },
        totals: {
          clicks: sum(queries, 'clicks'), impressions: sum(queries, 'impressions'),
          brandedClicks: sum(branded, 'clicks'), nonBrandedClicks: sum(nonBranded, 'clicks'),
          brandedImpressions: sum(branded, 'impressions'), nonBrandedImpressions: sum(nonBranded, 'impressions'),
          queryCount: queries.length
        },
        topQueries: queries.sort((a, b) => b.clicks - a.clicks).slice(0, 50),
        topNonBrandedQueries: nonBranded.sort((a, b) => b.clicks - a.clicks).slice(0, 50),
        highImpressionsLowCtr: highImpLowCtr,
        pageTwoOpportunities: pageTwo,
        topPages: pages.sort((a, b) => b.clicks - a.clicks).slice(0, 40),
        dailyTrend: byDate.sort((a, b) => a.keys[0].localeCompare(b.keys[0])),
        generatedAt: new Date().toISOString()
      })
    };
  } catch (e) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false, error: e.message }) };
  }
};
