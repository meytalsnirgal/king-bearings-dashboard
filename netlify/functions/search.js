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
        httpsGet(`${BASE}/${IG_ID}/media?fields=caption,media_type,like_count,comments_count,media_url,permalink,timestamp&limit=100&access_token=${TOKEN}`)
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
    // Account insights for the last 28 days. Requires instagram_manage_insights.
    // Each metric is fetched INDEPENDENTLY because Meta accepts different
    // period/metric_type combinations per metric, and one rejected metric would
    // otherwise fail the whole call. Whatever succeeds is returned; the rest is
    // reported in `failed` so a broken metric is visible instead of silent.
    const DAY = 24 * 60 * 60;
    const until = Math.floor(Date.now() / 1000);
    const since = until - 28 * DAY;
    const METRICS = [
      'reach', 'profile_views', 'website_clicks',
      'accounts_engaged', 'total_interactions', 'saves', 'shares', 'likes', 'comments'
    ];

    async function tryMetric(name) {
      // total_value over an explicit window is the combination Meta accepts for
      // these account metrics; days_28 as a `period` is rejected for reach.
      const url = `${BASE}/${IG_ID}/insights?metric=${name}&metric_type=total_value&period=day`
        + `&since=${since}&until=${until}&access_token=${TOKEN}`;
      try {
        const parsed = JSON.parse(await httpsGet(url));
        if (parsed.error) return { name, error: parsed.error.message };
        const row = (parsed.data || [])[0];
        if (!row) return { name, error: 'no data returned' };
        const value = row.total_value ? row.total_value.value
          : (row.values && row.values.length ? row.values.reduce((s, v) => s + (v.value || 0), 0) : null);
        return { name, value };
      } catch (e) {
        return { name, error: e.message };
      }
    }

    const results = await Promise.all(METRICS.map(tryMetric));
    const metrics = {};
    const failed = {};
    for (const r of results) {
      if (r.error) failed[r.name] = r.error;
      else if (r.value != null) metrics[r.name] = r.value;
    }
    const available = Object.keys(metrics).length > 0;
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ available, windowDays: 28, metrics, failed })
    };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown type' }) };
};
