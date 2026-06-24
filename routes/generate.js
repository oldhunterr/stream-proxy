const express = require('express');
const crypto = require('../utils/crypto');
const router = express.Router();

const encodeUrl = (u) => Buffer.from(u).toString('base64');

router.post('/url', (req, res) => {
  const { destination_url, expiration, api_password, ip, mediaflow_proxy_url, endpoint, query_params } = req.body;
  if (!destination_url) return res.status(400).json({ error: 'Missing destination_url' });

  const params = new URLSearchParams(query_params || {});
  params.set('d', encodeUrl(destination_url));

  if (api_password) {
    const token = crypto.generateToken(destination_url, api_password, expiration, ip);
    params.set('token', token);
  }
  if (expiration) params.set('exp', expiration);

  const baseUrl = mediaflow_proxy_url || `${req.protocol}://${req.get('host')}`;
  const ep = endpoint || '/proxy/stream';
  const url = `${baseUrl}${ep}?${params.toString()}`;

  res.json({ url });
});

router.post('/urls', async (req, res) => {
  const { mediaflow_proxy_url, api_password, expiration, ip, urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Missing urls array' });

  const results = urls.map(item => {
    const params = new URLSearchParams(item.query_params || {});
    params.set('d', encodeUrl(item.destination_url));
    if (api_password) {
      const token = crypto.generateToken(item.destination_url, api_password, expiration, ip);
      params.set('token', token);
    }
    if (expiration) params.set('exp', expiration);

    const baseUrl = mediaflow_proxy_url || `${req.protocol}://${req.get('host')}`;
    const ep = item.endpoint || '/proxy/stream';
    return `${baseUrl}${ep}?${params.toString()}`;
  });

  res.json({ urls: results });
});

module.exports = router;
