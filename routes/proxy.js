/**
 * /proxy?url=<encoded>
 *
 * Generic transparent relay. Pipes ANY media content through with:
 *  - Original Content-Type preserved
 *  - CORS headers injected
 *  - Range requests forwarded (for MP4 seek)
 *  - Custom request headers via ?headers=<base64 JSON>
 */
const express = require('express');
const axios   = require('axios');
const chalk   = require('chalk');
const http    = require('http');
const https   = require('https');
const mutex   = require('../middleware/mutex');
const router  = express.Router();

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch (_) {}
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch (_) {}
  return raw;
};

const BLOCKED_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
]);

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  const isCompanionMode = req.query.stremio === 'true' || req.query.video_error === 'true';

  // Optional extra headers
  let extraHeaders = {};
  if (req.query.headers) {
    try { extraHeaders = JSON.parse(Buffer.from(req.query.headers, 'base64').toString()); } catch (_) {}
  }

  console.log(chalk.yellow('[PROXY]'), targetUrl.slice(0, 100));

  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL format', url: targetUrl });
  }

  await mutex.acquire(host);

  try {
    // Strip default Accept/Accept-Language headers to bypass Cloudflare/CDN bot detection
    // which blocks requests with incomplete browser signatures (522/523 errors).
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': new URL(targetUrl).origin,
      ...extraHeaders,
    };

    if (req.headers['range']) {
      requestHeaders['Range'] = req.headers['range'];
    }

    console.log(chalk.gray('  ↳ request headers:'), JSON.stringify(requestHeaders));

    const upstream = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      timeout: 20000,
      httpAgent,
      httpsAgent,
      headers: requestHeaders,
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      if (upstream.data) {
        try { upstream.data.destroy(); } catch (_) {}
      }
      if (isCompanionMode) {
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const msg = encodeURIComponent(`Upstream returned status ${upstream.status}`);
        return res.redirect(`${hostUrl}/stream/error.m3u8?msg=${msg}`);
      }
    }

    // Forward status
    res.status(upstream.status);

    // Forward response headers — strip CORS-blocking ones
    Object.entries(upstream.headers).forEach(([k, v]) => {
      if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
        let val = v;
        // Override generic application/octet-stream with video/mp4 for media URLs
        // to ensure HTML5 players parse and render the streams correctly.
        if (k.toLowerCase() === 'content-type' && v.toLowerCase() === 'application/octet-stream') {
          const lowerUrl = targetUrl.toLowerCase();
          if (lowerUrl.includes('.mp4') || lowerUrl.includes('/video') || lowerUrl.includes('/play') || lowerUrl.includes('mp4upload') || lowerUrl.includes('kraken')) {
            val = 'video/mp4';
          }
        }
        res.setHeader(k, val);
      }
    });

    // Log upstream headers for inspection
    console.log(chalk.gray('  ↳ upstream status:'), upstream.status);
    console.log(chalk.gray('  ↳ content-type:'), upstream.headers['content-type']);

    upstream.data.pipe(res);

    req.on('close', () => {
      if (upstream.data && !upstream.data.destroyed) {
        upstream.data.destroy();
      }
    });
  } catch (err) {
    console.error(chalk.red('[PROXY ERROR]'), err.message);
    if (isCompanionMode) {
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      const msg = encodeURIComponent(`Upstream error: ${err.message}`);
      return res.redirect(`${hostUrl}/stream/error.m3u8?msg=${msg}`);
    }
    res.status(502).json({ error: `Upstream error: ${err.message}`, url: targetUrl });
  } finally {
    mutex.release(host);
  }
});

module.exports = router;
