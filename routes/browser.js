/**
 * /browser?url=<encoded>
 * /browser/deepscan?url=<encoded>
 *
 * Headless Chromium extractor via Puppeteer + Stealth plugin.
 * Stealth patches ~20 Chromium fingerprint leaks so Cloudflare cannot
 * detect the headless browser.
 *
 * /browser?url=       — standard extraction (intercept + DOM scan)
 * /browser/deepscan?url= — full diagnostic: verify each URL with a Range
 *                          request and report exact content-type + file size
 */
const express     = require('express');
const puppeteer   = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios       = require('axios');
const chalk       = require('chalk');
const fs          = require('fs');
const path        = require('path');
const zlib        = require('zlib');
const router      = express.Router();

puppeteer.use(StealthPlugin());

const decodeUrl = (raw) => {
  try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch (_) {}
  try { return decodeURIComponent(raw); } catch (_) {}
  return raw;
};
const encodeUrl = (u) => Buffer.from(u).toString('base64');

// ── Stream detection helpers ──────────────────────────────────────────────
const VIDEO_CT = ['video/mp4', 'video/webm', 'video/ogg', 'application/vnd.apple.mpegurl',
                  'application/x-mpegurl', 'application/dash+xml', 'video/mp2t'];
const STREAM_EXTS = ['.m3u8', '.mpd', '.mp4', '.webm', '.ts', '.mkv', '.flv'];
const STREAM_KEYS = ['pass_md5', '/stream', '/video', '/media', '/play', '/hls', '/file', '/playlist.m3u8', '/get_video', '?file=', '&stream=', '?video='];
const EXCLUDED_EXTS = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.map', '.html', '.htm', '.vtt', '.srt'];

const isStreamLike = (url) => {
  const u = url.toLowerCase();
  const pathPart = u.split('?')[0].split('#')[0];
  if (EXCLUDED_EXTS.some(ext => pathPart.endsWith(ext))) {
    return false;
  }
  if (pathPart.includes('.vtt') || pathPart.includes('.srt')) {
    return false;
  }
  return STREAM_EXTS.some(e => u.includes(e)) || STREAM_KEYS.some(k => u.includes(k));
};

const isVideoContentType = (ct = '') =>
  VIDEO_CT.some(t => ct.toLowerCase().includes(t));

const guessType = (url = '', ct = '') => {
  const u = url.toLowerCase();
  if (ct.includes('mpegurl') || u.includes('.m3u8')) return 'HLS';
  if (ct.includes('dash')    || u.includes('.mpd'))  return 'DASH';
  if (ct.includes('mp4')     || u.includes('.mp4'))  return 'MP4';
  if (ct.includes('webm')    || u.includes('.webm')) return 'WEBM';
  if (ct.includes('mp2t')    || u.includes('.ts'))   return 'MPEG-TS';
  if (u.includes('pass_md5'))                        return 'DoodStream-token';
  return 'stream';
};

const randomToken = (n = 10) => {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length: n}, () => c[Math.floor(Math.random() * c.length)]).join('');
};

// ── Browser pool (one instance, kept warm) ────────────────────────────────
let _browser = null;

const getBrowser = async () => {
  if (_browser) {
    try { await _browser.version(); return _browser; } catch (_) { _browser = null; }
  }
  console.log(chalk.green('[BROWSER] Launching stealth Chromium…'));
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1280,800',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
};

// ── Core extraction logic ─────────────────────────────────────────────────
const extractWithBrowser = async (targetUrl, extraWait = 8000, skipWarmup = false) => {
  const browser  = await getBrowser();
  const page     = await browser.newPage();

  const found    = new Map(); // url → entry
  const doodResolved = [];

  try {
    // ── Real browser headers ──────────────────────────────────────────────
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

    // ── Warm-up pass: visit root domain to pick up CF clearance cookie ───
    if (!skipWarmup) {
      const origin = (() => { try { return new URL(targetUrl).origin; } catch(_) { return targetUrl; } })();
      console.log(chalk.gray('  ↳ warm-up: visiting root domain…'));
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));
      } catch(_) {}
    }

    // ── Universal HTMLMediaElement Hooking (Zero-Day Player Detection) ───
    await page.evaluateOnNewDocument(() => {
      window.__caughtStreams = window.__caughtStreams || [];
      const pushStream = (src, sourceStr) => {
        if (src && typeof src === 'string' && src.startsWith('http')) {
          window.__caughtStreams.push({ url: src, source: sourceStr });
        }
      };

      // Hook HTMLMediaElement.prototype.play
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        pushStream(this.src || this.currentSrc, 'hook/play');
        return originalPlay.apply(this, arguments);
      };

      // Hook HTMLMediaElement.prototype.load
      const originalLoad = HTMLMediaElement.prototype.load;
      HTMLMediaElement.prototype.load = function() {
        pushStream(this.src || this.currentSrc, 'hook/load');
        return originalLoad.apply(this, arguments);
      };

      // Hook HTMLVideoElement.prototype.src setter
      const originalSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      if (originalSrcDesc && originalSrcDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          set: function(val) {
            pushStream(val, 'hook/src-setter');
            return originalSrcDesc.set.call(this, val);
          },
          get: originalSrcDesc.get
        });
      }
    });

    // ── Network interception ──────────────────────────────────────────────
    await page.setRequestInterception(true);

    page.on('request', req => { req.continue(); });

    page.on('response', async (resp) => {
      const url    = resp.url();
      const status = resp.status();
      const ct     = resp.headers()['content-type'] || '';
      const cl     = resp.headers()['content-length'];
      const cr     = resp.headers()['content-range'];

      // ── Video content-type response ──────────────────────────────────
      if (isVideoContentType(ct)) {
        const entry = {
          url, status,
          contentType: ct.split(';')[0].trim(),
          contentLength: cl ? parseInt(cl) : null,
          contentRange:  cr || null,
          type:   guessType(url, ct),
          source: 'network/content-type',
          confidence: 'verified',
        };
        found.set(url, entry);
        console.log(chalk.green('  [VIDEO RESP]'), entry.type, entry.contentType,
          cl ? `${(parseInt(cl)/1024/1024).toFixed(2)}MB` : '', url.slice(0,80));
      }

      // ── XHR / Fetch JSON Scraping ──────────────────────────────────────
      if (ct.includes('application/json')) {
        try {
          const bodyBuf = await resp.buffer();
          const bodyStr = bodyBuf.toString('utf-8');
          const regex = /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4|webm|mkv|ts)(?:\?[^\s"'<>]+)?)/gi;
          let match;
          while ((match = regex.exec(bodyStr)) !== null) {
            const extractedUrl = match[1].replace(/\\/g, ''); // Clean escaped slashes
            if (!found.has(extractedUrl)) {
              found.set(extractedUrl, {
                url: extractedUrl, status: 200,
                contentType: 'unknown',
                type: guessType(extractedUrl),
                source: 'network/json-scrape',
                confidence: 'scraped'
              });
              console.log(chalk.yellow('  [JSON SCRAPE]'), extractedUrl.slice(0,80));
            }
          }
        } catch (_) {} // Ignore aborted requests
      }

      // ── DoodStream pass_md5 ───────────────────────────────────────────
      if (url.includes('pass_md5') && status === 200) {
        try {
          const body = (await resp.text()).trim();
          if (body.startsWith('http') && body.length > 10) {
            const token  = randomToken(10);
            const expiry = Math.floor(Date.now() / 1000) + 3600;
            const final  = `${body}?token=${token}&expiry=${expiry}`;
            doodResolved.push({ baseUrl: body, finalUrl: final, pass_md5Url: url, token, expiry });
            console.log(chalk.cyan('  [DOOD RESOLVED]'), final.slice(0,80));
          }
        } catch (_) {}
      }

      // ── HLS / DASH manifests ──────────────────────────────────────────
      if (ct.includes('mpegurl') || ct.includes('dash') || url.includes('.m3u8') || url.includes('.mpd')) {
        if (!found.has(url)) {
          found.set(url, {
            url, status,
            contentType: ct.split(';')[0].trim(),
            type:   guessType(url, ct),
            source: 'network/manifest',
            confidence: 'verified',
          });
          console.log(chalk.blue('  [MANIFEST]'), guessType(url, ct), url.slice(0,80));
        }
      }
    });

    // ── Main navigation ───────────────────────────────────────────────────
    console.log(chalk.gray('  ↳ navigating to embed page…'));
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(chalk.gray(`  ↳ waiting ${extraWait}ms for player to fire requests…`));
    await new Promise(r => setTimeout(r, extraWait));


    // ── DOM scan after JS runs (Cross-Origin Iframe Traversal) ─────────
    const frames = page.frames();
    const domStreams = [];
    
    for (const frame of frames) {
      try {
        const frameStreams = await frame.evaluate(() => {
          const res = [];
          
          // 1. Gather streams caught by our Universal Hooks
          if (window.__caughtStreams) {
            res.push(...window.__caughtStreams);
          }

          // 2. <video src> / <source src>
          document.querySelectorAll('video[src],source[src]').forEach(el => {
            const src = el.src || el.getAttribute('src');
            if (src && src.startsWith('http')) res.push({ url: src, source: 'DOM/video' });
          });
          
          // 3. currentSrc of all video elements
          document.querySelectorAll('video').forEach(el => {
            if (el.currentSrc && el.currentSrc.startsWith('http'))
              res.push({ url: el.currentSrc, source: 'video.currentSrc' });
          });
          
          // 4. Known player variables (fallback)
          ['dsplayer','player','videoPlayer','jwplayer'].forEach(name => {
            try {
              const p = window[name];
              if (!p) return;
              const src = typeof p.src === 'function' ? p.src() : null;
              if (src && typeof src === 'string' && src.startsWith('http'))
                res.push({ url: src, source: `window.${name}.src()` });
              if (src && src.src) res.push({ url: src.src, source: `window.${name}.src().src` });
              const cs = typeof p.currentSrc === 'function' ? p.currentSrc() : p.currentSrc;
              if (cs && typeof cs === 'string' && cs.startsWith('http'))
                res.push({ url: cs, source: `window.${name}.currentSrc` });
            } catch (_) {}
          });
          return res;
        });
        
        domStreams.push(...frameStreams);
      } catch (err) {
        // Ignore cross-origin frame access errors if they occur
      }
    }

    domStreams.forEach(r => {
      if (!found.has(r.url)) {
        found.set(r.url, { url: r.url, type: guessType(r.url), source: r.source, confidence: 'dom' });
      }
    });

    const pageTitle = await page.title().catch(() => null);
    const poster    = await page.$eval('video[poster]', el => el.poster).catch(() => null);

    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await page.close();

    return { pageTitle, poster, found: [...found.values()], doodResolved, cookieStr };

  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
};

// ── Verify a URL by making a Range request ────────────────────────────────
const verifyUrl = async (url, referer = '', cookieStr = '') => {
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch (_) {
    pathname = url.toLowerCase().split('?')[0].split('#')[0];
  }
  const cleanPath = pathname.split('#')[0];
  if (cleanPath.endsWith('.vtt') || cleanPath.endsWith('.srt') || cleanPath.includes('.vtt') || cleanPath.includes('.srt')) {
    return { ok: false, error: 'Forbidden path: WebVTT/SRT' };
  }

  let r;
  try {
    let refererUrl = referer;
    if (!refererUrl) {
      try {
        refererUrl = new URL(url).origin;
      } catch (_) {
        refererUrl = url;
      }
    }
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer':    refererUrl,
    };
    
    const isPlaylist = url.toLowerCase().includes('.m3u8') || 
                       url.toLowerCase().includes('.mpd');

    if (!isPlaylist) {
      headers['Range'] = 'bytes=0-8191';
    }
    if (cookieStr) headers['Cookie'] = cookieStr;

    r = await axios.get(url, {
      responseType: 'stream',
      timeout: 12000,
      headers,
      validateStatus: () => true,
    });

    const isSuccess = r.status === 200 || r.status === 206;
    if (!isSuccess) {
      if (r && r.data) r.data.destroy();
      return { ok: false, status: r.status };
    }

    const h = r.headers;
    const contentType = (h['content-type'] || '').split(';')[0].trim().toLowerCase();

    // Reject content-types containing 'vtt', 'subtitle', or 'subtitles'
    if (contentType.includes('vtt') || contentType.includes('subtitle') || contentType.includes('subtitles')) {
      if (r && r.data) r.data.destroy();
      return { ok: false, status: r.status, contentType, error: 'Forbidden content type: Subtitles' };
    }

    // Strict verification of content-type to filter out JavaScript, HTML, CSS, JSON and images
    const forbiddenTypes = [
      'application/javascript',
      'application/x-javascript',
      'text/javascript',
      'text/html',
      'text/css',
      'application/json',
    ];
    const isForbidden = forbiddenTypes.includes(contentType) || contentType.startsWith('image/');
    if (isForbidden) {
      if (r && r.data) r.data.destroy();
      return { ok: false, status: r.status, contentType, error: 'Forbidden content type' };
    }

    // Handle compression (gzip, deflate, br) prior to reading the first chunk
    const contentEncoding = (h['content-encoding'] || '').trim().toLowerCase();
    let stream = r.data;
    if (contentEncoding === 'gzip') {
      stream = stream.pipe(zlib.createGunzip());
    } else if (contentEncoding === 'deflate') {
      stream = stream.pipe(zlib.createInflate());
    } else if (contentEncoding === 'br') {
      stream = stream.pipe(zlib.createBrotliDecompress());
    }

    // Read the first chunk of the response stream
    const firstChunk = await new Promise((resolve) => {
      let resolved = false;
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (!resolved) {
          try { r.data.destroy(); } catch (_) {}
          try { stream.destroy(); } catch (_) {}
          resolved = true;
          resolve(buffer);
        }
      }, 5000);

      stream.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const limit = isPlaylist ? 65536 : 8192;
        if (buffer.length >= limit) {
          clearTimeout(timer);
          try { r.data.destroy(); } catch (_) {}
          try { stream.destroy(); } catch (_) {}
          resolved = true;
          resolve(buffer);
        }
      });
      stream.on('end', () => {
        if (!resolved) {
          clearTimeout(timer);
          resolved = true;
          resolve(buffer);
        }
      });
      stream.on('error', () => {
        if (!resolved) {
          clearTimeout(timer);
          resolved = true;
          resolve(buffer);
        }
      });
    });

    try { r.data.destroy(); } catch (_) {}
    try { stream.destroy(); } catch (_) {}

    if (firstChunk.length === 0) {
      return { ok: false, status: r.status, contentType, error: 'Empty response body' };
    }

    // Determine if the body is text/plain / HTML / JS etc.
    const isTextBuffer = (buf) => {
      const limit = Math.min(buf.length, 512);
      let textChars = 0;
      for (let i = 0; i < limit; i++) {
        const byte = buf[i];
        if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
          textChars++;
        } else if (byte < 7 || (byte > 14 && byte < 32)) {
          return false;
        }
      }
      return (textChars / limit) > 0.9;
    };

    const isText = isTextBuffer(firstChunk);
    
    let bodyString;
    if (firstChunk[0] === 0xFF && firstChunk[1] === 0xFE) {
      bodyString = firstChunk.toString('utf16le');
    } else if (firstChunk[0] === 0xFE && firstChunk[1] === 0xFF) {
      const len = firstChunk.length;
      for (let i = 0; i < len - 1; i += 2) {
        const tmp = firstChunk[i];
        firstChunk[i] = firstChunk[i+1];
        firstChunk[i+1] = tmp;
      }
      bodyString = firstChunk.toString('utf16le');
    } else {
      bodyString = firstChunk.toString('utf8');
    }

    // Perform an explicit check for the 'WEBVTT' signature (with/without UTF-8 BOM)
    if (bodyString.includes('WEBVTT') || bodyString.includes('\ufeffWEBVTT')) {
      return { ok: false, status: r.status, contentType, error: 'Forbidden content: WebVTT signature detected' };
    }

    const trimmedBody = bodyString.trim();
    const lowerBody = trimmedBody.toLowerCase();

    // Block HTML/XML/JSON signatures
    const isHtmlOrXml = lowerBody.startsWith('<!doctype html') || 
                        lowerBody.includes('<html') || 
                        lowerBody.includes('<head') || 
                        lowerBody.includes('<body') || 
                        lowerBody.startsWith('<?xml') ||
                        lowerBody.includes('<rss') ||
                        (lowerBody.includes('<mpd') && lowerBody.includes('<html')); // DASH tag inside HTML
                        
    if (isHtmlOrXml) {
      return { ok: false, status: r.status, contentType, error: 'Forbidden content: HTML or XML document detected' };
    }

    if (lowerBody.startsWith('{"') || lowerBody.startsWith('[')) {
      return { ok: false, status: r.status, contentType, error: 'Forbidden content: JSON detected' };
    }

    const isM3u8 = url.toLowerCase().includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegurl');
    const isDASH = url.toLowerCase().includes('.mpd') || contentType.includes('dash');

    if (isM3u8) {
      // Must contain #EXTM3U AND either #EXTINF or #EXT-X-STREAM-INF
      const hasM3u8Tags = bodyString.includes('#EXTM3U') && (
        bodyString.includes('#EXTINF') || 
        bodyString.includes('#EXT-X-STREAM-INF')
      );
      if (!hasM3u8Tags) {
        return { ok: false, status: r.status, contentType, error: 'Invalid or empty M3U8 playlist contents' };
      }
    } else if (isDASH) {
      const hasDashTags = (bodyString.includes('<MPD') || bodyString.includes('urn:mpeg:dash:schema:mpd')) && bodyString.includes('<Period');
      if (!hasDashTags) {
        return { ok: false, status: r.status, contentType, error: 'Invalid DASH manifest contents' };
      }
    } else {
      // For non-playlist files (e.g. MP4, TS), if the content is text, it is a false positive
      if (isText) {
        return { ok: false, status: r.status, contentType, error: 'Forbidden content: Plain text or script detected for binary media' };
      }
    }

    const cr = h['content-range'] || '';
    const totalMatch = cr.match(/\/(\d+)$/);
    return {
      ok:            true,
      status:        r.status,
      contentType:   h['content-type'] ? h['content-type'].split(';')[0].trim() : '',
      contentLength: h['content-length'] ? parseInt(h['content-length']) : null,
      totalBytes:    totalMatch ? parseInt(totalMatch[1]) : null,
      acceptRanges:  h['accept-ranges'],
      contentRange:  cr,
      server:        h['server'],
      lastModified:  h['last-modified'],
      etag:          h['etag'],
    };
  } catch (err) {
    if (r && r.data) {
      try { r.data.destroy(); } catch (_) {}
    }
    return { ok: false, error: err.message };
  }
};

// ── Routes ────────────────────────────────────────────────────────────────

// GET /browser?url=<enc>&wait=<ms>
router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  const wait      = Math.min(parseInt(req.query.wait) || 8000, 30000);

  console.log(chalk.magenta('[BROWSER]'), targetUrl.slice(0,100));

  try {
    const { pageTitle, poster, found, doodResolved, cookieStr } = await extractWithBrowser(targetUrl, wait);

    // Merge dood results in front
    const doodCandidates = doodResolved.map(d => ({
      url:          d.finalUrl,
      baseUrl:      d.baseUrl,
      pass_md5Url:  d.pass_md5Url,
      token:        d.token,
      expiry:       new Date(d.expiry * 1000).toISOString(),
      type:         'MP4',
      source:       'browser/doodstream',
      confidence:   'high',
    }));

    const allCandidates = [...doodCandidates, ...found.filter(f => !f.url.includes('pass_md5'))];
    const proxyBase = `${req.protocol}://${req.get('host')}`;
    
    const extraHeaders = { Referer: targetUrl };
    if (cookieStr) extraHeaders['Cookie'] = cookieStr;
    const b64Headers = Buffer.from(JSON.stringify(extraHeaders)).toString('base64');

    res.json({
      source: targetUrl, pageTitle, poster,
      count:  allCandidates.length,
      candidates: allCandidates.map(c => ({
        ...c,
        proxyUrl:   `${proxyBase}/proxy?url=${encodeUrl(c.url)}&headers=${b64Headers}`,
        hlsUrl:     c.type === 'HLS' ? `${proxyBase}/hls?url=${encodeUrl(c.url)}&headers=${b64Headers}` : null,
        inspectUrl: `${proxyBase}/inspect?url=${encodeUrl(c.url)}`,
      })),
    });
  } catch (err) {
    console.error(chalk.red('[BROWSER ERR]'), err.message);
    res.status(502).json({ error: err.message, url: targetUrl });
  }
});

// GET /browser/deepscan?url=<enc>&wait=<ms>
// Full diagnostic: browser extraction + verify each candidate with Range request
router.get('/deepscan', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  const wait      = Math.min(parseInt(req.query.wait) || 9000, 30000);

  console.log(chalk.magenta('[DEEPSCAN]'), targetUrl.slice(0,100));

  try {
    const { pageTitle, poster, found, doodResolved, cookieStr } = await extractWithBrowser(targetUrl, wait);
    const proxyBase = `${req.protocol}://${req.get('host')}`;

    const extraHeaders = { Referer: targetUrl };
    if (cookieStr) extraHeaders['Cookie'] = cookieStr;
    const b64Headers = Buffer.from(JSON.stringify(extraHeaders)).toString('base64');

    // Build candidate list (dood first)
    const candidates = [];

    for (const d of doodResolved) {
      console.log(chalk.cyan('  [VERIFY DOOD]'), d.finalUrl.slice(0,80));
      const verify = await verifyUrl(d.finalUrl, targetUrl, cookieStr);
      candidates.push({
        url:         d.finalUrl,
        baseUrl:     d.baseUrl,
        token:       d.token,
        expiry:      new Date(d.expiry * 1000).toISOString(),
        type:        'MP4',
        source:      'browser/doodstream',
        confidence:  verify.ok ? 'verified' : 'unverified',
        verify,
        proxyUrl:    `${proxyBase}/proxy?url=${encodeUrl(d.finalUrl)}&headers=${b64Headers}`,
        inspectUrl:  `${proxyBase}/inspect?url=${encodeUrl(d.finalUrl)}`,
      });
    }

    for (const f of found) {
      if (f.url.includes('pass_md5')) continue;
      
      let candidate = { ...f };
      
      if (candidate.confidence !== 'verified') {
        console.log(chalk.cyan('  [VERIFY]'), candidate.url.slice(0,80));
        const verify = await verifyUrl(candidate.url, targetUrl, cookieStr);
        candidate.verify = verify;
        if (verify.ok) {
          candidate.confidence = 'verified';
          candidate.status = verify.status;
          candidate.contentType = verify.contentType;
          candidate.contentLength = verify.contentLength;
        } else {
          candidate.confidence = 'unverified';
        }
      }

      // We push verified and unverified, so user can see them in dashboard
      candidates.push({
        ...candidate,
        proxyUrl:   `${proxyBase}/proxy?url=${encodeUrl(candidate.url)}&headers=${b64Headers}`,
        hlsUrl:     candidate.type === 'HLS' ? `${proxyBase}/hls?url=${encodeUrl(candidate.url)}&headers=${b64Headers}` : null,
        inspectUrl: `${proxyBase}/inspect?url=${encodeUrl(candidate.url)}`,
      });
    }

    // Summarise
    const playable = candidates.filter(c => c.verify?.ok || c.confidence === 'verified');

    console.log(chalk.green('[DEEPSCAN]'),
      `${candidates.length} candidates, ${playable.length} verified playable`);

    res.json({
      source:    targetUrl,
      pageTitle,
      poster,
      summary: {
        total:     candidates.length,
        playable:  playable.length,
      },
      candidates,
    });

  } catch (err) {
    console.error(chalk.red('[DEEPSCAN ERR]'), err.message);
    res.status(502).json({ error: err.message, url: targetUrl });
  }
});

// GET /browser/close
router.get('/close', async (req, res) => {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
  res.json({ ok: true });
});

// GET /browser/status
router.get('/status', async (req, res) => {
  let running = false;
  if (_browser) { try { await _browser.version(); running = true; } catch(_) {} }
  res.json({ running });
});

const logToHistory = async (targetUrl, resolvedUrl, type, timeline) => {
  try {
    const historyPath = path.join(__dirname, '../deepscan_history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
      try {
        const fileContent = fs.readFileSync(historyPath, 'utf8');
        history = JSON.parse(fileContent);
      } catch (_) {
        history = [];
      }
    }
    const newEntry = {
      timestamp: new Date().toISOString(),
      targetUrl,
      domain: (() => { try { return new URL(targetUrl).hostname; } catch(_) { return 'unknown'; } })(),
      resolvedUrl,
      type,
      timeline
    };
    history.push(newEntry);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
    console.log(chalk.green(`  [HISTORY] Saved scan entry to deepscan_history.json`));
  } catch (err) {
    console.error(chalk.red(`  [HISTORY ERR] Failed to write history: ${err.message}`));
  }
};

const deepScanPage = async (targetUrl, timeoutMs = 25000) => {
  const timeline = [];
  const addLog = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const line = `${elapsed}s: ${msg}`;
    timeline.push(line);
    console.log(chalk.cyan(`  [DEEPSCAN TIMER] ${line}`));
  };

  const startTime = Date.now();
  addLog(`Initiating deep scan for: ${targetUrl}`);

  const browser = await getBrowser();
  const page = await browser.newPage();
  addLog('Chromium stealth page opened');

  const candidates = new Map();
  let resolvedResult = null;
  let finished = false;

  // Track if we need to close popups
  const closePopups = async (target) => {
    if (finished) return;
    try {
      // Small delay lets the Stealth plugin finish initializing its evasions
      // on the new target before we close it, preventing TargetCloseError crashes.
      await new Promise(r => setTimeout(r, 100));
      const newPage = await target.page();
      if (newPage && newPage !== page) {
        addLog(`Ad tab detected, closing: ${newPage.url().slice(0, 60)}`);
        await newPage.close().catch(() => {});
      }
    } catch (_) {}
  };
  browser.on('targetcreated', closePopups);

  // Set real browser headers for navigation
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  });

  await page.setRequestInterception(true);

  page.on('request', req => {
    if (finished) {
      req.abort().catch(() => {});
      return;
    }
    req.continue();
  });

  const processCandidate = async (url, sourceName, cookieStr) => {
    if (finished || !url || !url.startsWith('http')) return;
    if (!isStreamLike(url)) return;
    if (candidates.has(url)) return;
    candidates.set(url, { url, source: sourceName, verified: false });

    addLog(`Captured candidate from [${sourceName}]: ${url.slice(0, 90)}`);
    addLog(`Validating candidate via Range request...`);
    
    const verify = await verifyUrl(url, targetUrl, cookieStr);
    if (verify.ok && !finished) {
      finished = true;
      resolvedResult = {
        url,
        type: guessType(url, verify.contentType),
        contentType: verify.contentType,
        cookieStr,
        referer: targetUrl,
      };
      addLog(`Validation succeeded! Playable stream: ${url.slice(0, 90)} (Type: ${resolvedResult.type})`);
      
      // Save timeline to history
      await logToHistory(targetUrl, url, resolvedResult.type, timeline);
    } else {
      addLog(`Validation failed or status invalid: ${verify.status || 'Error'} (${verify.error || 'not playable'})`);
    }
  };

  // Intercept responses for media files
  page.on('response', async resp => {
    if (finished) return;
    const url = resp.url();
    const headers = resp.headers();
    const ct = headers['content-type'] || '';
    
    if (isVideoContentType(ct) || isStreamLike(url)) {
      const cookies = await page.cookies().catch(() => []);
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      // Run async process
      processCandidate(url, 'network-response', cookieStr).catch(() => {});
    }
  });

  try {
    // Inject scripts to intercept video play, video load, setting src descriptor, fetch, and XHR
    await page.evaluateOnNewDocument(() => {
      window.__capturedSrcs = [];
      const logCaptured = (url, sourceName) => {
        if (url && typeof url === 'string') {
          let resolved = url;
          if (!url.startsWith('http') && !url.startsWith('data:') && !url.startsWith('blob:')) {
            try {
              resolved = new URL(url, document.baseURI).href;
            } catch (_) {}
          }
          if (resolved.startsWith('http')) {
            if (!window.__capturedSrcs.some(x => x.url === resolved)) {
              window.__capturedSrcs.push({ url: resolved, source: sourceName });
            }
          }
        }
      };

      const getDescriptor = (proto, prop) => {
        let p = proto;
        while (p) {
          const desc = Object.getOwnPropertyDescriptor(p, prop);
          if (desc) return desc;
          p = Object.getPrototypeOf(p);
        }
        return null;
      };

      // 1. Hijack HTMLMediaElement prototypes (play/load) instead of HTMLVideoElement to avoid prototype shadowing
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        logCaptured(this.src, 'HTMLMediaElement.play() [src]');
        logCaptured(this.currentSrc, 'HTMLMediaElement.play() [currentSrc]');
        return originalPlay.apply(this, arguments);
      };

      const originalLoad = HTMLMediaElement.prototype.load;
      HTMLMediaElement.prototype.load = function() {
        logCaptured(this.src, 'HTMLMediaElement.load() [src]');
        logCaptured(this.currentSrc, 'HTMLMediaElement.load() [currentSrc]');
        return originalLoad.apply(this, arguments);
      };

      // Hook HTMLMediaElement.prototype.src property setter
      const mediaSrcDesc = getDescriptor(HTMLMediaElement.prototype, 'src');
      if (mediaSrcDesc && mediaSrcDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          ...mediaSrcDesc,
          set: function(val) {
            logCaptured(val, 'HTMLMediaElement.src descriptor setter');
            mediaSrcDesc.set.call(this, val);
          }
        });
      }

      // Hook HTMLSourceElement.prototype.src property setter (for <source src="..."> elements)
      const sourceSrcDesc = getDescriptor(HTMLSourceElement.prototype, 'src');
      if (sourceSrcDesc && sourceSrcDesc.set) {
        Object.defineProperty(HTMLSourceElement.prototype, 'src', {
          ...sourceSrcDesc,
          set: function(val) {
            logCaptured(val, 'HTMLSourceElement.src setter');
            sourceSrcDesc.set.call(this, val);
          }
        });
      }

      // Hook Element.prototype.setAttribute to catch src/data-src changes
      const originalSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        if (name === 'src' || name === 'data-src') {
          const tagName = this.tagName ? this.tagName.toLowerCase() : '';
          if (tagName === 'video' || tagName === 'source' || tagName === 'audio' || tagName === 'iframe') {
            logCaptured(value, `Element.setAttribute(${name})`);
          }
        }
        return originalSetAttribute.apply(this, arguments);
      };

      // 2. Hijack window.fetch
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
        logCaptured(requestUrl, 'window.fetch()');
        try {
          const resp = await originalFetch.apply(this, args);
          // If the response is text, check if it contains common media endpoints
          const cloned = resp.clone();
          const contentType = cloned.headers.get('content-type') || '';
          if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml')) {
            cloned.text().then(text => {
              const regex = /https?:\/\/[^\s"'`]+\.(?:mp4|m3u8|mpd|webm|ts)[^\s"'`]*/gi;
              let m;
              while ((m = regex.exec(text)) !== null) {
                logCaptured(m[0], 'fetch-response-body');
              }
            }).catch(() => {});
          }
          return resp;
        } catch (err) {
          return originalFetch.apply(this, args);
        }
      };

      // 3. Hijack XMLHttpRequest
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        logCaptured(url, 'XMLHttpRequest.open()');
        return originalOpen.apply(this, [method, url, ...args]);
      };
      
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
          try {
            const ct = this.getResponseHeader('content-type') || '';
            if (ct.includes('json') || ct.includes('text') || ct.includes('xml')) {
              const text = this.responseText;
              const regex = /https?:\/\/[^\s"'`]+\.(?:mp4|m3u8|mpd|webm|ts)[^\s"'`]*/gi;
              let m;
              while ((m = regex.exec(text)) !== null) {
                logCaptured(m[0], 'xhr-response-body');
              }
            }
          } catch (_) {}
        });
        return originalSend.apply(this, args);
      };
    });

    try {
      addLog('Hooks injected successfully. Starting navigation...');
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      addLog('Page navigation completed (DOMContentLoaded)');
    } catch (err) {
      addLog(`Navigation warning/error: ${err.message}. Proceeding to deep scan loop anyway.`);
    }

    // Interaction loop
    const scanInterval = 1500;
    while (Date.now() - startTime < timeoutMs && !finished) {
      addLog('Scanning DOM and window variables...');

      // Get captured scripts/sources from page context, plus window globals
      let pageData = [];
      try {
        pageData = await page.evaluate(() => {
          const list = Array.from(window.__capturedSrcs || []);
          
          // Scan media tags in DOM
          document.querySelectorAll('video, source').forEach(el => {
            const src = el.src || el.getAttribute('src');
            if (src && !list.some(x => x.url === src)) {
              let resolved = src;
              if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('blob:')) {
                try {
                  resolved = new URL(src, document.baseURI).href;
                } catch (_) {}
              }
              if (resolved.startsWith('http')) {
                list.push({ url: resolved, source: 'DOM element (video/source)' });
              }
            }
            if (el.currentSrc && !list.some(x => x.url === el.currentSrc)) {
              let resolved = el.currentSrc;
              if (!el.currentSrc.startsWith('http') && !el.currentSrc.startsWith('data:') && !el.currentSrc.startsWith('blob:')) {
                try {
                  resolved = new URL(el.currentSrc, document.baseURI).href;
                } catch (_) {}
              }
              if (resolved.startsWith('http')) {
                list.push({ url: resolved, source: 'DOM element currentSrc' });
              }
            }
          });

          // Scan window properties (Up to 3 levels deep)
          const visited = new Set();
          const scanObj = (obj, depth) => {
            if (depth > 3 || !obj || visited.has(obj)) return;
            visited.add(obj);

            for (const key in obj) {
              try {
                const val = obj[key];
                if (typeof val === 'string') {
                  if (val.startsWith('http') && (val.includes('.m3u8') || val.includes('.mp4') || val.includes('.mpd') || val.includes('/stream'))) {
                    if (!list.some(x => x.url === val)) {
                      list.push({ url: val, source: `window property scanning (${key})` });
                    }
                  }
                } else if (typeof val === 'object' && val !== null) {
                  // Limit key counts to avoid infinite loops on large window namespaces
                  if (Object.keys(val).length < 200) {
                    scanObj(val, depth + 1);
                  }
                }
              } catch (_) {}
            }
          };

          // Targets for window property scanning
          ['player', 'playerConfig', 'jwplayer', 'videojs', 'config', 'jw', 'playerInstance', 'sources', 'streams', 'episode'].forEach(k => {
            if (window[k]) {
              scanObj(window[k], 1);
            }
          });

          // Fallback global window regex search on raw window serialized config
          try {
            const matchKeys = ['playerConfig', 'config', '_player', 'jwplayer', 'videojs'];
            matchKeys.forEach(k => {
              if (window[k]) {
                const str = JSON.stringify(window[k]);
                const regex = /https?:\/\/[^\s"'`]+\.(?:mp4|m3u8|mpd|webm|ts)[^\s"'`]*/gi;
                let m;
                while ((m = regex.exec(str)) !== null) {
                  if (!list.some(x => x.url === m[0])) {
                    list.push({ url: m[0], source: `serialized window global (${k})` });
                  }
                }
              }
            });
          } catch (_) {}

          return list;
        });
      } catch (err) {
        addLog(`Page evaluation failed: ${err.message}`);
      }

      let cookieStr = '';
      try {
        const cookies = await page.cookies().catch(() => []);
        cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      } catch (err) {
        addLog(`Failed to fetch cookies: ${err.message}`);
      }

      for (const entry of pageData) {
        try {
          await processCandidate(entry.url, entry.source, cookieStr);
        } catch (err) {
          addLog(`Error processing candidate ${entry.url.slice(0, 50)}: ${err.message}`);
        }
        if (finished) break;
      }

      if (finished) break;

      // Click overlays and play buttons
      try {
        addLog('Clicking play overlays / coordinates to trigger player activity...');
        const clickMsg = await page.evaluate(() => {
          const playSelectors = [
            '.jw-display-icon-container',
            '.plyr__control--overlaid',
            '.vjs-big-play-button',
            '.play-button',
            'div[class*="play" i]',
            'div[id*="play" i]',
            'button[class*="play" i]',
            'video',
            'svg',
            'button'
          ];

          // Click first visible selector element
          for (const sel of playSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                el.click();
                return `Clicked selector: ${sel}`;
              }
            }
          }

          // Simulating click in center of page to clear overlays
          const centerEl = document.elementFromPoint(640, 400);
          if (centerEl && typeof centerEl.click === 'function') {
            centerEl.click();
            return 'Clicked center coordinates (640, 400)';
          }
          return 'No target elements matched for click action';
        }).catch(err => `Click failed: ${err.message}`);
        addLog(clickMsg);
      } catch (err) {
        addLog(`Click evaluation outer error: ${err.message}`);
      }

      // Recursive scan on child frames
      try {
        const frames = page.frames();
        for (const frame of frames) {
          if (finished) break;
          if (frame === page.mainFrame()) continue;
          try {
            const frameData = await frame.evaluate(() => {
              const list = Array.from(window.__capturedSrcs || []);
              
              document.querySelectorAll('video, source').forEach(el => {
                const src = el.src || el.getAttribute('src');
                if (src && !list.some(x => x.url === src)) {
                  let resolved = src;
                  if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('blob:')) {
                    try {
                      resolved = new URL(src, document.baseURI).href;
                    } catch (_) {}
                  }
                  if (resolved.startsWith('http')) {
                    list.push({ url: resolved, source: 'DOM element (video/source)' });
                  }
                }
                if (el.currentSrc && !list.some(x => x.url === el.currentSrc)) {
                  let resolved = el.currentSrc;
                  if (!el.currentSrc.startsWith('http') && !el.currentSrc.startsWith('data:') && !el.currentSrc.startsWith('blob:')) {
                    try {
                      resolved = new URL(el.currentSrc, document.baseURI).href;
                    } catch (_) {}
                  }
                  if (resolved.startsWith('http')) {
                    list.push({ url: resolved, source: 'DOM element currentSrc' });
                  }
                }
              });
              // Try triggering click inside frame
              const playSelectors = [
                '.jw-display-icon-container',
                '.plyr__control--overlaid',
                '.vjs-big-play-button',
                '.play-button',
                'video',
                'button'
              ];
              for (const sel of playSelectors) {
                const el = document.querySelector(sel);
                if (el) { el.click(); break; }
              }
              return list;
            }).catch(() => []);

            for (const entry of frameData) {
              try {
                await processCandidate(entry.url, `iframe-source (${frame.name() || frame.url()}) -> ${entry.source}`, cookieStr);
              } catch (err) {
                addLog(`Error processing iframe candidate: ${err.message}`);
              }
              if (finished) break;
            }
          } catch (frameErr) {
            addLog(`Frame evaluation error: ${frameErr.message}`);
          }
        }
      } catch (err) {
        addLog(`Frame traversal error: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, scanInterval));
    }

    if (!finished) {
      addLog('Timeout reached or no candidate was verified as playable.');
    }

  } catch (err) {
    addLog(`Error occurred during execution: ${err.message}`);
  } finally {
    browser.off('targetcreated', closePopups);
    await page.close().catch(() => {});
  }

  return resolvedResult;
};

router.extractWithBrowser = extractWithBrowser;
router.verifyUrl = verifyUrl;
router.deepScanPage = deepScanPage;
router.isStreamLike = isStreamLike;

module.exports = router;
