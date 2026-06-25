/**
 * /extract?url=<encoded>
 *
 * iFrame / embedded-player stream extractor.
 *
 * Strategy:
 *  1. Fetch the target page with a real browser User-Agent
 *  2. Parse HTML with cheerio — look for <video>, <source>, <iframe>
 *  3. Scan inline <script> content for common stream URL patterns
 *  4. Recursively follow iframes up to MAX_DEPTH levels
 *  5. Detect DoodStream / playmogo pattern (pass_md5 + makePlay token)
 *  6. Return a deduplicated JSON array of discovered stream candidates
 *
 * Each candidate has: { url, type, source, confidence }
 */
const express  = require('express');
const axios    = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio  = require('cheerio');
const chalk    = require('chalk');
const router   = express.Router();
const registry = require('../utils/extractor_registry');

// Cookie-aware axios instance
const jar = new CookieJar();
const axiosCj = wrapper(axios.create({ jar, withCredentials: true }));

const MAX_DEPTH   = 3;
const TIMEOUT_MS  = 15000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch (_) {}
  try { return decodeURIComponent(raw); } catch (_) {}
  return raw;
};

/**
 * Guess stream type from URL
 */
const guessType = (url) => {
  if (url.includes('.m3u8'))            return 'HLS';
  if (url.includes('.mpd'))             return 'DASH';
  if (url.includes('.mp4'))             return 'MP4';
  if (url.includes('.webm'))            return 'WEBM';
  if (url.includes('.ts'))              return 'MPEG-TS';
  if (url.includes('.flv'))             return 'FLV';
  if (url.includes('rtmp://'))          return 'RTMP';
  if (url.includes('rtsp://'))          return 'RTSP';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('vimeo.com'))        return 'Vimeo';
  return 'Unknown';
};

/**
 * Resolve specialized proxy URLs (e.g. /lulu, /mixdrop) based on hostname
 */
const getSpecializedProxyUrl = (url, host) => {
  const enc = Buffer.from(url).toString('base64');
  
  if (url.includes('lulustream.com') || url.includes('lulu')) {
    return `${host}/lulu?url=${enc}`;
  }
  if (url.includes('mixdrop.ag') || url.includes('mixdrop.co') || url.includes('mixdrop.to') || url.includes('mixdrop.bz')) {
    return `${host}/mixdrop?url=${enc}`;
  }
  if (url.includes('voe.sx') || url.includes('voe.sh')) {
    return `${host}/voe?url=${enc}`;
  }
  if (url.includes('doodstream.com') || url.includes('dood') || url.includes('playmogo.com')) {
    return `${host}/dood?url=${enc}`;
  }
  if (url.includes('mega.nz')) {
    return `${host}/mega?url=${enc}`;
  }
  if (url.includes('file-upload.org') || url.includes('fileupload')) {
    return `${host}/fileupload?url=${enc}`;
  }
  if (url.includes('krakenfiles.com')) {
    return `${host}/kraken?url=${enc}`;
  }
  if (url.includes('mp4upload.com')) {
    return `${host}/mp4upload?url=${enc}`;
  }
  
  const isHls = url.includes('.m3u8');
  return `${host}/${isHls ? 'hls' : 'proxy'}?url=${enc}`;
};

/**
 * JS source heuristic patterns to detect stream URLs
 */
const JS_PATTERNS = [
  // HLS/DASH manifests
  /["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/gi,
  /["'`](https?:\/\/[^"'`\s]+\.mpd[^"'`\s]*)["'`]/gi,
  // MP4 (including escaped slashes like https:\/\/)
  /["'`](https?:\\\/\\\/[^"'`\s]+\.mp4[^"'`\s]*)["'`]/gi,
  /["'`](https?:\/\/[^"'`\s]+\.mp4[^"'`\s]*)["'`]/gi,
  // Generic src/file/url/stream keys (with and without escaped slashes)
  /(?:file|src|url|source|stream|hls_url|video_url|mp4|stream_url)\s*[:=]\s*["'](https?:\\\/\\\/[^"']{10,})["']/gi,
  /(?:file|src|url|source|stream|hls_url|video_url|mp4|stream_url)\s*[:=]\s*["'`](https?:\/\/[^"'`\s]{10,})["'`]/gi,
  // JSON-like "url": "..." (with and without escaped slashes)
  /"(?:url|src|file|source|stream)"\s*:\s*"(https?:\\\/\\\/[^"]{10,})"/gi,
  /"(?:url|src|file|source|stream)"\s*:\s*"(https?:\/\/[^"]{10,})"/gi,
];

const STREAM_EXTS = ['.m3u8', '.mpd', '.mp4', '.webm', '.ts', '.mkv', '.flv'];
const STREAM_KEYS = ['pass_md5', '/stream', '/video', '/media', '/play', '/hls', '/file', '/playlist.m3u8', '/get_video', '?file=', '&stream=', '?video='];
const EXCLUDED_EXTS = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.map', '.html', '.htm', '.vtt', '.srt'];

const isStreamLike = (url) => {
  const u = url.toLowerCase();
  const pathPart = u.split('?')[0];
  if (EXCLUDED_EXTS.some(ext => pathPart.endsWith(ext))) {
    return false;
  }
  return STREAM_EXTS.some(e => u.includes(e)) || STREAM_KEYS.some(k => u.includes(k));
};

const extractFromJS = (script) => {
  const found = [];
  for (const pattern of JS_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(script)) !== null) {
      let url = match[1];
      if (url && url.startsWith('http')) {
        url = url.replace(/\\\//g, '/');
        if (isStreamLike(url)) {
          found.push({ url, source: 'script', confidence: 'medium' });
        }
      }
    }
  }
  return found;
};

/**
 * DoodStream / playmogo-style extractor.
 * Detects the pass_md5 pattern and resolves the real MP4 URL.
 */
const extractDoodStream = async (html, pageUrl) => {
  const results = [];

  // Match:  $.get('/pass_md5/<path>/<token>', ...)
  const md5Match = html.match(/\/pass_md5\/([\w\-\/]+)/);
  if (!md5Match) return results;

  const pass_md5_path = md5Match[0]; // e.g. /pass_md5/12345.../token
  const baseHost = (() => { try { const u = new URL(pageUrl); return u.origin; } catch(_) { return ''; } })();
  const md5Url = baseHost + pass_md5_path;

  console.log(chalk.cyan('[DOODSTREAM] pass_md5 URL:'), md5Url);

  try {
    const md5Resp = await axios.get(md5Url, {
      timeout: 10000,
      headers: {
        'User-Agent': UA,
        'Referer': pageUrl,
        'Accept': '*/*',
      },
      validateStatus: () => true,
    });

    const baseVideoUrl = (md5Resp.data || '').trim();
    if (!baseVideoUrl || baseVideoUrl === 'RELOAD') {
      results.push({ url: md5Url, type: 'DoodStream-token-expired', source: 'doodstream/pass_md5', confidence: 'low' });
      return results;
    }

    // Build the makePlay token — random 10-char alphanum + expiry timestamp
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomToken = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1h
    const finalUrl = `${baseVideoUrl}?token=${randomToken}&expiry=${expiry}`;

    console.log(chalk.cyan('[DOODSTREAM] resolved URL:'), finalUrl.slice(0, 100));
    results.push({ url: finalUrl, type: 'MP4', source: 'doodstream/pass_md5', confidence: 'high', baseUrl: baseVideoUrl });
  } catch (err) {
    console.error(chalk.red('[DOODSTREAM ERROR]'), err.message);
  }

  return results;
};

/**
 * Fetch and extract streams from one page URL.
 */
const extractFromPage = async (pageUrl, depth = 0, visited = new Set()) => {
  if (depth > MAX_DEPTH || visited.has(pageUrl)) return [];
  visited.add(pageUrl);

  if (pageUrl.includes('share4max.com') || pageUrl.includes('megamax.me')) {
    const baseDomain = pageUrl.includes('share4max.com') ? 'share4max.com' : 'megamax.me';
    console.log(chalk.cyan(`[${baseDomain.toUpperCase()}] Extracting mirrors list...`));
    try {
      // 1. Fetch initial HTML to get Inertia version
      const r1 = await axiosCj.get(pageUrl, {
        headers: { 'User-Agent': UA, 'Referer': `https://${baseDomain}/` },
        timeout: TIMEOUT_MS
      });
      const html1 = r1.data;
      const scriptMatch = html1.match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/i);
      
      if (scriptMatch) {
        const pageData = JSON.parse(scriptMatch[1]);
        const version = pageData.version;
        
        // 2. Fetch partial load for streams/mirrors
        const r2 = await axiosCj.get(pageUrl, {
          headers: {
            'User-Agent': UA,
            'Referer': pageUrl,
            'X-Inertia': 'true',
            'X-Inertia-Version': version,
            'X-Inertia-Partial-Component': 'files/mirror/video',
            'X-Inertia-Partial-Data': 'streams',
            'X-Requested-With': 'XMLHttpRequest'
          },
          timeout: TIMEOUT_MS
        });
        
        if (r2.data && r2.data.props && r2.data.props.streams && r2.data.props.streams.data) {
          const streamsData = r2.data.props.streams.data;
          const found = [];
          for (const qualityGroup of streamsData) {
            const label = qualityGroup.label || '';
            for (const mirror of (qualityGroup.mirrors || [])) {
              let link = mirror.link || '';
              if (link.startsWith('//')) {
                link = 'https:' + link;
              }
              const driver = (mirror.driver || mirror.symbol || 'Unknown').toLowerCase();
              let type = guessType(link);
              if (driver.includes('lulu')) type = 'HLS';
              if (driver.includes('voe')) type = 'HLS';
              if (driver.includes('mixdrop')) type = 'MP4';
              if (driver.includes('dood')) type = 'MP4';
              if (driver.includes('mp4upload')) type = 'MP4';
              
              found.push({
                url: link,
                type: type,
                source: `share4max/${label}/${mirror.driver || mirror.symbol || 'Unknown'}`,
                confidence: 'high'
              });
            }
          }
          return found;
        }
      }
    } catch (err) {
      console.error(chalk.red('[SHARE4MAX ERROR]'), err.message);
    }
    return [];
  }

  console.log(chalk.green(`[EXTRACT depth=${depth}]`), pageUrl.slice(0, 100));

  let html;
  try {
    const origin = (() => { try { return new URL(pageUrl).origin; } catch(_) { return pageUrl; } })();
    const reqHeaders = {
      'User-Agent': UA,
      'Referer':    origin,
      'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };

    // First pass — collects Set-Cookie (Cloudflare lang / __cf_bm etc)
    const first = await axiosCj.get(pageUrl, {
      timeout: TIMEOUT_MS,
      responseType: 'text',
      headers: reqHeaders,
      validateStatus: () => true,
      maxRedirects: 5,
    });

    html = first.data;

    // If we got a short response (CF challenge / redirect page), do a second pass
    if (typeof html === 'string' && html.length < 10000 && html.includes('challenge')) {
      console.log(chalk.yellow('  ↳ got CF challenge, retrying with cookies…'));
      await new Promise(r => setTimeout(r, 1500)); // brief pause
      const second = await axiosCj.get(pageUrl, {
        timeout: TIMEOUT_MS,
        responseType: 'text',
        headers: { ...reqHeaders, 'Cache-Control': 'max-age=0' },
        validateStatus: () => true,
        maxRedirects: 5,
      });
      html = second.data;
    }

    if (typeof html !== 'string') html = JSON.stringify(html);
  } catch (err) {
    console.error(chalk.red('[EXTRACT FETCH ERR]'), err.message);
    return [];
  }

  console.log(chalk.gray(`  ↳ html length: ${html.length}`));

  if (!html || html.length < 100) return [];

  const $ = cheerio.load(html);
  const results = [];

  // ── HTML element scan ────────────────────────────────────────────────────
  // <video src="...">
  $('video[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.startsWith('http')) {
      results.push({ url: src, type: guessType(src), source: 'video[src]', confidence: 'high' });
    }
  });

  // <source src="...">
  $('source[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.startsWith('http')) {
      results.push({ url: src, type: guessType(src), source: 'source[src]', confidence: 'high' });
    }
  });

  // <a href="..."> with video extension
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && /\.(mp4|m3u8|mpd|webm|ts)(\?|$)/i.test(href)) {
      results.push({ url: href, type: guessType(href), source: 'a[href]', confidence: 'medium' });
    }
  });

  // ── Inline script scan ───────────────────────────────────────────────────
  $('script').each((_, el) => {
    const code = $(el).html() || '';
    extractFromJS(code).forEach(r => results.push(r));
  });

  // ── DoodStream / playmogo special handler ────────────────────────────────
  if (html.includes('pass_md5') || html.includes('doodcdn') || html.includes('dsplayer')) {
    const doodResults = await extractDoodStream(html, pageUrl);
    doodResults.forEach(r => results.push(r));
  }

  // ── Meta / link tags ─────────────────────────────────────────────────────
  $('meta[property="og:video"], meta[name="twitter:player:stream"]').each((_, el) => {
    const content = $(el).attr('content');
    if (content && content.startsWith('http')) {
      results.push({ url: content, type: guessType(content), source: 'meta', confidence: 'high' });
    }
  });

  // ── iFrame recursion ─────────────────────────────────────────────────────
  const iframeSrcs = [];
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.startsWith('http') && !visited.has(src)) {
      iframeSrcs.push(src);
    }
  });

  for (const iframeSrc of iframeSrcs.slice(0, 5)) {
    const sub = await extractFromPage(iframeSrc, depth + 1, visited);
    sub.forEach(r => {
      r.source = `iframe(${r.source})`;
      results.push(r);
    });
  }

  return results;
};

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  const wantQuality = req.query.quality;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);

  // Try hoster-specific extraction first (if URL matches a known extractor)
  let directUrl = null;
  let directHeaders = null;
  let allQualities = null;
  try {
    const hosterResult = await registry.extract(targetUrl, { useBrowser: false, quality: wantQuality });
    if (hosterResult && hosterResult.ok && hosterResult.url) {
      directUrl = hosterResult.url;
      directHeaders = hosterResult.headers || null;
      allQualities = hosterResult.all_qualities || null;
    }
  } catch (_) {}

  // Cheerio-based extraction
  const all = await extractFromPage(targetUrl);

  // Deduplicate by URL
  const seen = new Set();
  const unique = all.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Sort: high confidence first
  unique.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.confidence] || 2) - (rank[b.confidence] || 2);
  });

  console.log(chalk.green('[EXTRACT]'), `Found ${unique.length} candidates${directUrl ? ', + direct URL from hoster' : ''}${wantQuality ? ', quality=' + wantQuality : ''}`);

  res.json({
    source: targetUrl,
    quality: wantQuality || null,
    count: unique.length,
    direct_url: directUrl,
    direct_headers: directHeaders,
    all_qualities: allQualities,
    candidates: unique.map(c => {
      const host = `${req.protocol}://${req.get('host')}`;
      const specializedProxy = getSpecializedProxyUrl(c.url, host);
      return {
        ...c,
        proxyUrl: specializedProxy,
        hlsUrl: c.type === 'HLS' && c.url.includes('.m3u8') && !specializedProxy.includes('/hls?url=')
          ? `${host}/hls?url=${Buffer.from(c.url).toString('base64')}`
          : null
      };
    }),
  });
});

router.extractFromPage = extractFromPage;

module.exports = router;
