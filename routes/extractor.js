const express = require('express');
const chalk = require('chalk');
const router = express.Router();
const registry = require('../utils/extractor_registry');
const browser = require('./browser');

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  } catch (_) {}
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  } catch (_) {}
  return raw;
};

const encodeUrl = (u) => Buffer.from(u).toString('base64');

router.get('/video', async (req, res) => {
  const { host, d, url: urlParam, redirect_stream, quality } = req.query;
  const rawUrl = d || urlParam;
  if (!host || !rawUrl) return res.status(400).json({ error: 'Missing required parameters: host, d (or url)' });

  const targetUrl = decodeUrl(rawUrl);
  const wantRedirect = redirect_stream === 'true';

  console.log(chalk.magenta(`[EXTRACTOR] ${host}:`), targetUrl.slice(0, 100));

  // Pass quality preference to the extractor
  const extractOptions = { useBrowser: false, quality };

  // 1. Try specific extractor
  let result = await registry.extractByName(host, targetUrl, extractOptions);

  // 2. Fallback to Puppeteer deep scan
  if (!result.ok) {
    console.log(chalk.yellow(`  ↳ ${host} extractor failed, falling back to browser...`));
    try {
      const scan = await browser.deepScanPage(targetUrl, 15000);
      if (scan && scan.url) {
        result = { ok: true, url: scan.url, headers: { Referer: scan.referer || targetUrl, Cookie: scan.cookieStr || '' }, source: `${host}/browser` };
      }
    } catch (_) {}
  }

  if (!result.ok) {
    return res.status(502).json({ error: result.error, host, url: targetUrl });
  }

  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const isHls = result.url.includes('.m3u8');
  const endpoint = isHls ? 'hls' : 'proxy';
  const headersB64 = Buffer.from(JSON.stringify(result.headers || {})).toString('base64');
  const streamUrl = `${hostUrl}/${endpoint}?url=${encodeUrl(result.url)}&headers=${headersB64}`;

  if (wantRedirect) return res.redirect(streamUrl);

  res.json({
    destination_url: result.url,
    request_headers: result.headers || {},
    mediaflow_proxy_url: hostUrl,
    endpoint: `/${endpoint}`,
    query_params: { headers: headersB64 },
    source: result.source,
  });
});

router.get('/video.:ext', async (req, res) => {
  req.query.redirect_stream = 'true';
  const baseUrl = req.originalUrl.replace(/\/video\.\w+(\?|$)/, '/video$1');
  return res.redirect(baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'redirect_stream=true');
});

module.exports = router;
