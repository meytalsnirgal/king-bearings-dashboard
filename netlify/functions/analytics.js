const https = require('https');
const crypto = require('crypto');

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  const sig = signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad token response: ' + data.slice(0, 200))); }
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
  const jwt = signJwt(clientEmail, privateKey);
  const res = await postForm('https://oauth2.googleapis.com/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });
  return res.access_token;
}

function postJson(url, token, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GA4 ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON from GA4: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function ymd(d) { return d.toISOString().slice(0, 10); }

function monthWindow(monthsAgo) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const end = monthsAgo === 0 ? now : new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 0);
  return { from: ymd(start), to: ymd(end) };
}

async function sessionsFor(token, propertyId, from, to) {
  const res = await postJson(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    metrics: [{ name: 'sessions' }]
  });
  const row = res.rows && res.rows[0];
  return row ? Number(row.metricValues[0].value) : 0;
}

function pctChange(cur, prev) { return prev ? ((cur - prev) / prev) * 100 : (cur ? 100 : 0); }

exports.handler = async function () {
  if (!process.env.GA_CLIENT_EMAIL || !process.env.GA_PRIVATE_KEY || !process.env.GA_PROPERTY_ID) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ connected: false }) };
  }
  try {
    const token = await getAccessToken();
    const thisMonth = monthWindow(0);
    const lastMonth = monthWindow(1);
    const [sessionsThis, sessionsLast] = await Promise.all([
      sessionsFor(token, process.env.GA_PROPERTY_ID, thisMonth.from, thisMonth.to),
      sessionsFor(token, process.env.GA_PROPERTY_ID, lastMonth.from, lastMonth.to)
    ]);
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        connected: true,
        sessionsThisMonth: sessionsThis,
        sessionsLastMonth: sessionsLast,
        sessionsGrowthPct: pctChange(sessionsThis, sessionsLast)
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ connected: false, error: e.message }) };
  }
};
