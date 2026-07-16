const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

exports.handler = async function(event) {
  const type = event.queryStringParameters && event.queryStringParameters.type;

  const TOKEN = process.env.IG_TOKEN;
  const IG_ID = '17841402254973060';
  const BASE = 'https://graph.facebook.com/v19.0';

  if (type === 'instagram') {
    try {
      // 100 posts back so the frontend can chart engagement by month.
      const [account, media] = await Promise.all([
        httpsGet(`${BASE}/${IG_ID}?fields=username,followers_count,media_count&access_token=${TOKEN}`),
        httpsGet(`${BASE}/${IG_ID}/media?fields=caption,media_type,like_count,comments_count,media_url,timestamp&limit=100&access_token=${TOKEN}`)
      ]);
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ account: JSON.parse(account), media: JSON.parse(media) })
      };
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (type === 'ig-insights') {
    // Account insights for the last 28 days. Requires instagram_manage_insights
    // on the token; reports { available: false } rather than failing the page.
    try {
      const raw = await httpsGet(`${BASE}/${IG_ID}/insights?metric=reach,profile_views,website_clicks&period=days_28&metric_type=total_value&access_token=${TOKEN}`);
      const parsed = JSON.parse(raw);
      if (parsed.error) {
        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ available: false, error: parsed.error.message }) };
      }
      const out = {};
      for (const m of (parsed.data || [])) {
        out[m.name] = m.total_value ? m.total_value.value : (m.values && m.values.length ? m.values[m.values.length - 1].value : null);
      }
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ available: true, metrics: out }) };
    } catch(e) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ available: false, error: e.message }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown type' }) };
};
