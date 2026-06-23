const express = require('express');
const chalk = require('chalk');
const browserModule = require('./browser');
const extractWithBrowser = browserModule.extractWithBrowser;
const router = express.Router();

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch (_) {}
  try { return decodeURIComponent(raw); } catch (_) {}
  return raw;
};

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const embedUrl = decodeUrl(rawUrl);
  const origin = (() => { try { return new URL(embedUrl).origin; } catch(_) { return ''; } })();

  console.log(chalk.cyan('[KRAKEN] resolving via browser:'), embedUrl.slice(0, 100));

  try {
    const { pageTitle, poster, found, cookieStr } = await extractWithBrowser(embedUrl, 3000, true);
    
    // Find the first video stream candidate
    const candidate = found.find(c => c.type === 'MP4' || c.type === 'WEBM' || c.type === 'stream');
    
    if (!candidate) {
      return res.status(502).json({
        error: 'No video stream candidate found for Krakenfiles',
        url: embedUrl
      });
    }

    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const enc = (u) => Buffer.from(u).toString('base64');
    
    const embedOrigin = origin ? (origin.endsWith('/') ? origin : origin + '/') : 'https://krakenfiles.com/';
    const extraHeaders = {
      'Referer': embedOrigin,
      'Accept': '*/*',
      'Accept-Encoding': 'identity;q=1, *;q=0',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };
    const b64Headers = Buffer.from(JSON.stringify(extraHeaders)).toString('base64');
    
    const proxyUrl = `${proxyBase}/proxy?url=${enc(candidate.url)}&headers=${b64Headers}`;

    res.json({
      url: proxyUrl, // For redirectFallback
      source: embedUrl,
      title: pageTitle,
      poster: poster,
      streamUrl: candidate.url,
    });
  } catch (err) {
    console.error(chalk.red('[KRAKEN ERR]'), err.message);
    res.status(502).json({ error: `Browser resolution failed: ${err.message}`, url: embedUrl });
  }
});

module.exports = router;
