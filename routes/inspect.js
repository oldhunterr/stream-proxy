/**
 * /inspect?url=<encoded>
 *
 * Traffic Inspector — proxies the request AND stores a full log entry
 * including request headers, response headers, timing, and size.
 *
 * GET /inspect?url=<enc>     → proxy + log
 * GET /inspect/log           → return all log entries as JSON
 * GET /inspect/clear         → clear the log
 */
const express = require('express');
const axios   = require('axios');
const chalk   = require('chalk');
const router  = express.Router();

const MAX_LOG_ENTRIES = 100;
const log = [];

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch (_) {}
  try { return decodeURIComponent(raw); } catch (_) {}
  return raw;
};

const BLOCKED_HEADERS = new Set([
  'access-control-allow-origin',
  'content-security-policy',
  'x-frame-options',
  'strict-transport-security',
]);

// ── GET /inspect/log ─────────────────────────────────────────────────────────
router.get('/log', (req, res) => {
  res.json({ count: log.length, entries: [...log].reverse() });
});

// ── GET /inspect/clear ───────────────────────────────────────────────────────
router.get('/clear', (req, res) => {
  log.length = 0;
  res.json({ ok: true, message: 'Log cleared' });
});

// ── GET /inspect?url=<enc> ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  const startTime = Date.now();

  console.log(chalk.cyan('[INSPECT]'), targetUrl.slice(0, 100));

  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125',
    'Accept': '*/*',
    'Referer': (() => { try { return new URL(targetUrl).origin; } catch(_) { return ''; } })(),
  };

  try {
    const upstream = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: requestHeaders,
      validateStatus: () => true,
    });

    const elapsed  = Date.now() - startTime;
    const bodySize = upstream.data.byteLength;

    // Build log entry
    const entry = {
      id:              log.length + 1,
      timestamp:       new Date().toISOString(),
      url:             targetUrl,
      status:          upstream.status,
      method:          'GET',
      requestHeaders,
      responseHeaders: upstream.headers,
      contentType:     upstream.headers['content-type'] || 'unknown',
      sizeBytes:       bodySize,
      durationMs:      elapsed,
    };

    // Keep log bounded
    if (log.length >= MAX_LOG_ENTRIES) log.shift();
    log.push(entry);

    console.log(chalk.gray(`  ↳ status=${upstream.status} size=${bodySize} time=${elapsed}ms`));

    // Forward response
    Object.entries(upstream.headers).forEach(([k, v]) => {
      if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });
    res.status(upstream.status);
    res.setHeader('X-Inspect-Duration-Ms', elapsed);
    res.setHeader('X-Inspect-Size-Bytes', bodySize);
    res.send(Buffer.from(upstream.data));

  } catch (err) {
    const elapsed = Date.now() - startTime;
    const entry = {
      id:         log.length + 1,
      timestamp:  new Date().toISOString(),
      url:        targetUrl,
      status:     0,
      error:      err.message,
      durationMs: elapsed,
    };
    if (log.length >= MAX_LOG_ENTRIES) log.shift();
    log.push(entry);

    console.error(chalk.red('[INSPECT ERROR]'), err.message);
    res.status(502).json({ error: err.message, url: targetUrl });
  }
});

module.exports = router;
