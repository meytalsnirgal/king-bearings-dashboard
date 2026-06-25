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

  if (type === 'instagram') {
    const TOKEN = process.env.IG_TOKEN;
    const IG_ID = '17841402254973060';
    const BASE = 'https://graph.facebook.com/v19.0';
    try {
      const [account, media] = await Promise.all([
        httpsGet(`${BASE}/${IG_ID}?fields=username,followers_count,media_count&access_token=${TOKEN}`),
        httpsGet(`${BASE}/${IG_ID}/media?fields=caption,media_type,like_count,comments_count,media_url,timestamp&limit=20&access_token=${TOKEN}`)
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

  if (type === 'search') {
    const query = event.queryStringParameters.q;
    if (!query) return { statusCode: 400, body: JSON.stringify({ error: 'No query' }) };
    const apiKey = process.env.SERPAPI_KEY;
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${apiKey}&num=10&tbs=qdr:m1`;
    try {
      const data = await httpsGet(url);
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
        body: data
      };
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown type' }) };
};
