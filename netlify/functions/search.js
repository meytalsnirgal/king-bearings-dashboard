const https = require('https');

exports.handler = async function(event) {
  const query = event.queryStringParameters && event.queryStringParameters.q;
  if (!query) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No query provided' }) };
  }

  const apiKey = process.env.SERPAPI_KEY;
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${apiKey}&num=10&tbs=qdr:m3`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: data
        });
      });
    }).on('error', (e) => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
  });
};
