/**
 * /hls?url=<encoded>
 *
 * HLS Manifest Rewriter.
 * Fetches a .m3u8 file and rewrites ALL segment URLs and sub-playlist URLs
 * to route through this proxy, enabling CORS-free playback in any browser.
 *
 * Supports:
 *  - Master playlists (EXT-X-STREAM-INF)
 *  - Media playlists (EXT-X-TARGETDURATION, segments)
 *  - Absolute & relative segment URLs
 *  - Live / rolling playlists
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

const encodeUrl = (url) => Buffer.from(url).toString('base64');

/**
 * Given a possibly-relative segment URL and the base URL of the manifest,
 * return a fully qualified absolute URL.
 */
const resolveUrl = (segUrl, baseUrl) => {
  if (segUrl.startsWith('http://') || segUrl.startsWith('https://')) return segUrl;
  try {
    return new URL(segUrl, baseUrl).href;
  } catch (_) {
    return segUrl;
  }
};

/**
 * Rewrite one line of an M3U8 manifest.
 * Lines that are URIs (not starting with #) become proxy URLs.
 * URI= attributes inside tags are also rewritten.
 */
const rewriteLine = (line, baseUrl, proxyBase, headersParam = '') => {
  const trimmed = line.trim();

  // Comment / tag lines that contain URI="..." attributes
  if (trimmed.startsWith('#')) {
    // Rewrite URI="..." inside EXT-X-KEY, EXT-X-MAP, etc.
    return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
      const abs = resolveUrl(uri, baseUrl);
      return `URI="${proxyBase}/proxy?url=${encodeUrl(abs)}${headersParam}"`;
    });
  }

  // Blank line
  if (!trimmed) return line;

  // Segment / sub-playlist URI line
  const abs = resolveUrl(trimmed, baseUrl);
  const pathPart = abs.split('?')[0].split('#')[0].toLowerCase();

  // Known segment extensions → route through /proxy (raw passthrough)
  const SEGMENT_EXTS = ['.ts', '.mp4', '.m4s', '.aac', '.m4a', '.webm', '.mkv', '.flv', '.mp3', '.ac3', '.eac3'];
  if (SEGMENT_EXTS.some(ext => pathPart.endsWith(ext))) {
    return `${proxyBase}/proxy?url=${encodeUrl(abs)}${headersParam}`;
  }

  // Everything else (playlists, manifests, unknown extensions, no extension)
  // → route through /hls for recursive manifest rewriting
  return `${proxyBase}/hls?url=${encodeUrl(abs)}${headersParam}`;
};

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  const isCompanionMode = req.query.stremio === 'true' || req.query.video_error === 'true';
  let companionParam = '';
  if (req.query.stremio === 'true') companionParam += '&stremio=true';
  if (req.query.video_error === 'true') companionParam += '&video_error=true';

  console.log(chalk.blue('[HLS]'), targetUrl.slice(0, 100));

  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL format', url: targetUrl });
  }

  await mutex.acquire(host);

  try {
    let extraHeaders = {};
    let headersParam = '';
    if (req.query.headers) {
      headersParam = `&headers=${encodeURIComponent(req.query.headers)}`;
      try { extraHeaders = JSON.parse(Buffer.from(req.query.headers, 'base64').toString()); } catch (_) {}
    }

    const upstream = await axios.get(targetUrl, {
      timeout: 15000,
      responseType: 'text',
      httpAgent,
      httpsAgent,
      // Avoid default Accept headers to keep request signature clean and bypass CDN blocks.
      headers: {
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome=125',
        'Referer': new URL(targetUrl).origin,
        ...extraHeaders,
      },
      validateStatus: () => true,
    });

    if (upstream.status !== 200) {
      if (isCompanionMode) {
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const msg = encodeURIComponent(`Upstream HLS returned status ${upstream.status}`);
        return res.redirect(`${hostUrl}/stream/error.m3u8?msg=${msg}`);
      }
      return res.status(upstream.status).json({
        error: `Upstream returned ${upstream.status}`,
        url: targetUrl,
      });
    }

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const lines = upstream.data.split('\n');

    // If max_res=true, filter master playlist to only the highest bandwidth variant
    if (req.query.max_res === 'true' || req.query.max_res === '1') {
      const masterLineIdx = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
      if (masterLineIdx !== -1) {
        let bestIdx = -1;
        let bestBw = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
            if (bwMatch) {
              const bw = parseInt(bwMatch[1]);
              if (bw > bestBw) { bestBw = bw; bestIdx = i; }
            }
          }
        }
        if (bestIdx !== -1 && bestIdx + 1 < lines.length) {
          const bestUrl = lines[bestIdx + 1].trim();
          if (bestUrl) {
            const absUrl = resolveUrl(bestUrl, targetUrl);
            const redirectUrl = `${proxyBase}/hls?url=${encodeUrl(absUrl)}${headersParam + companionParam}`;
            return res.redirect(redirectUrl);
          }
        }
      }
    }

    const rewritten = lines.map(line => rewriteLine(line, targetUrl, proxyBase, headersParam + companionParam)).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Original-Url', targetUrl);
    res.send(rewritten);

    console.log(chalk.gray(`  ↳ rewrote ${lines.length} lines`));
  } catch (err) {
    console.error(chalk.red('[HLS ERROR]'), err.message);
    if (isCompanionMode) {
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      const msg = encodeURIComponent(`HLS fetch failed: ${err.message}`);
      return res.redirect(`${hostUrl}/stream/error.m3u8?msg=${msg}`);
    }
    res.status(502).json({ error: `HLS fetch failed: ${err.message}`, url: targetUrl });
  } finally {
    mutex.release(host);
  }
});

module.exports = router;
