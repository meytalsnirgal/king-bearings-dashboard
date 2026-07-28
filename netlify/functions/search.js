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

  if (type === 'ig-post-insights') {
    // Per-post reach, saves and shares. This is what makes tracking a single
    // post's success possible, rather than only account-level totals.
    // Metric availability differs by media type (Reels report plays, images do
    // not), so each post is queried for a permissive set and whatever comes
    // back is kept.
    const limit = Math.min(Math.max(parseInt((event.queryStringParameters || {}).limit, 10) || 12, 1), 30);
    try {
      const mediaRaw = await httpsGet(`${BASE}/${IG_ID}/media?fields=id,caption,media_type,like_count,comments_count,permalink,timestamp&limit=${limit}&access_token=${TOKEN}`);
      const media = JSON.parse(mediaRaw);
      if (media.error) {
        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ available: false, error: media.error.message }) };
      }
      const posts = media.data || [];

      async function postInsights(p) {
        const wanted = p.media_type === 'VIDEO'
          ? 'reach,saved,shares,total_interactions,views'
          : 'reach,saved,shares,total_interactions';
        const base = {
          id: p.id, permalink: p.permalink, media_type: p.media_type,
          timestamp: p.timestamp,
          caption: (p.caption || '').slice(0, 180),
          likes: p.like_count, comments: p.comments_count
        };
        try {
          const parsed = JSON.parse(await httpsGet(`${BASE}/${p.id}/insights?metric=${wanted}&access_token=${TOKEN}`));
          if (parsed.error) return { ...base, insightsError: parsed.error.message };
          for (const m of (parsed.data || [])) {
            const v = m.total_value ? m.total_value.value
              : (m.values && m.values.length ? m.values[0].value : null);
            if (v != null) base[m.name] = v;
          }
          // Engagement against people actually reached, the metric that matters.
          if (base.reach) {
            base.engagementOnReachPct = Math.round(((base.total_interactions != null
              ? base.total_interactions
              : (base.likes || 0) + (base.comments || 0)) / base.reach) * 10000) / 100;
          }
          return base;
        } catch (e) {
          return { ...base, insightsError: e.message };
        }
      }

      const enriched = await Promise.all(posts.map(postInsights));
      const withReach = enriched.filter(p => p.reach != null);
      const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({
          available: withReach.length > 0,
          count: enriched.length,
          benchmarks: {
            medianReach: median(withReach.map(p => p.reach)),
            medianSaves: median(withReach.map(p => p.saved || 0)),
            medianShares: median(withReach.map(p => p.shares || 0)),
            medianEngagementOnReachPct: median(withReach.map(p => p.engagementOnReachPct || 0))
          },
          posts: enriched
        })
      };
    } catch (e) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ available: false, error: e.message }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown type' }) };
};
