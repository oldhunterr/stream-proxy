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
  
  console.log(chalk.cyan('[DOOD] resolving via browser:'), embedUrl.slice(0, 100));

  try {
    const { pageTitle, poster, doodResolved } = await extractWithBrowser(embedUrl, 8000, true);
    
    if (!doodResolved || doodResolved.length === 0) {
      return res.status(502).json({
        error: 'No DoodStream resolution found. Page did not call pass_md5.',
        url: embedUrl
      });
    }

    const d = doodResolved[0];
    const proxyBase = `${req.protocol}://${req.get('host')}`;
    const enc = (u) => Buffer.from(u).toString('base64');
    
    const headersObj = {
      'Referer': origin || 'https://doodstream.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    };
    const b64Headers = Buffer.from(JSON.stringify(headersObj)).toString('base64');
    
    const proxyUrl = `${proxyBase}/proxy?url=${enc(d.finalUrl)}&headers=${b64Headers}`;

    res.json({
      url:        proxyUrl, // For redirectFallback
      proxyUrl:   proxyUrl,
      source:     embedUrl,
      title:      pageTitle,
      poster:     poster,
      pass_md5Url: d.pass_md5Url,
      baseVideoUrl: d.baseUrl,
      finalUrl:   d.finalUrl,
      token:      d.token,
      expiry:     new Date(d.expiry * 1000).toISOString(),
      inspectUrl: `${proxyBase}/inspect?url=${enc(d.finalUrl)}`,
    });
  } catch (err) {
    console.error(chalk.red('[DOOD ERR]'), err.message);
    res.status(502).json({ error: `Browser resolution failed: ${err.message}`, url: embedUrl });
  }
});

module.exports = router;
