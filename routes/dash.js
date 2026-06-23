/**
 * /dash?url=<encoded>
 *
 * DASH (MPEG-DASH) manifest rewriter.
 * Fetches an .mpd file and rewrites:
 *  - <BaseURL> elements
 *  - SegmentTemplate media/initialization attributes
 *  - SegmentList/SegmentURL @media attributes
 * so all segments route through /proxy.
 */
const express = require('express');
const axios   = require('axios');
const chalk   = require('chalk');
const router  = express.Router();

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch (_) {}
  try { return decodeURIComponent(raw); } catch (_) {}
  return raw;
};

const encodeUrl = (url) => Buffer.from(url).toString('base64');

const resolveUrl = (rel, base) => {
  if (!rel) return rel;
  if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
  try { return new URL(rel, base).href; } catch(_) { return rel; }
};

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  console.log(chalk.magenta('[DASH]'), targetUrl.slice(0, 100));

  try {
    const upstream = await axios.get(targetUrl, {
      timeout: 15000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/125',
        'Accept': 'application/dash+xml, */*',
      },
      validateStatus: () => true,
    });

    if (upstream.status !== 200) {
      return res.status(upstream.status).json({ error: `Upstream ${upstream.status}`, url: targetUrl });
    }

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    let mpd = upstream.data;

    // Rewrite <BaseURL>...</BaseURL>
    mpd = mpd.replace(/<BaseURL>([\s\S]*?)<\/BaseURL>/g, (_, url) => {
      const abs = resolveUrl(url.trim(), targetUrl);
      return `<BaseURL>${proxyBase}/proxy?url=${encodeUrl(abs)}/</BaseURL>`;
    });

    // Rewrite initialization="..." and media="..." in SegmentTemplate
    mpd = mpd.replace(/(initialization|media)="([^"]+)"/g, (match, attr, url) => {
      if (url.startsWith('http')) {
        return `${attr}="${proxyBase}/proxy?url=${encodeUrl(url)}"`;
      }
      // relative — prepend base
      const abs = resolveUrl(url, targetUrl);
      return `${attr}="${proxyBase}/proxy?url=${encodeUrl(abs)}"`;
    });

    // Rewrite SegmentURL media="..."
    mpd = mpd.replace(/(<SegmentURL[^>]*media=")([^"]+)(")/g, (_, pre, url, post) => {
      const abs = resolveUrl(url, targetUrl);
      return `${pre}${proxyBase}/proxy?url=${encodeUrl(abs)}${post}`;
    });

    res.setHeader('Content-Type', 'application/dash+xml');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Original-Url', targetUrl);
    res.send(mpd);

    console.log(chalk.gray('  ↳ DASH manifest rewritten'));
  } catch (err) {
    console.error(chalk.red('[DASH ERROR]'), err.message);
    res.status(502).json({ error: err.message, url: targetUrl });
  }
});

module.exports = router;
