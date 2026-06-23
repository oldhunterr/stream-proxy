/**
 * In-memory LRU segment cache middleware.
 * Caches binary video segments (.ts, .mp4, .aac, etc.) up to MAX_CACHE_MB.
 * Manifests (.m3u8, .mpd) are always fetched fresh.
 */
const { LRUCache } = require('lru-cache');
const chalk = require('chalk');

const MAX_BYTES = (parseInt(process.env.MAX_CACHE_MB) || 50) * 1024 * 1024;

const cache = new LRUCache({
  maxSize: MAX_BYTES,
  sizeCalculation: (entry) => entry.data.length,
  ttl: (parseInt(process.env.CACHE_TTL) || 300) * 1000,
});

// Expose cache for the /status route
module.exports.cache    = cache;
module.exports.MAX_BYTES = MAX_BYTES;

// Skip caching for manifest-like content types / extensions
const SKIP_EXTS = ['.m3u8', '.mpd', '.xml'];
const shouldSkip = (url) => SKIP_EXTS.some(ext => url.includes(ext));

const middleware = (req, res, next) => {
  const targetUrl = req.query.url;
  if (!targetUrl || shouldSkip(targetUrl)) return next();

  const key = targetUrl;
  const hit = cache.get(key);

  if (hit) {
    console.log(chalk.magenta('[CACHE HIT]'), targetUrl.slice(0, 80));
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Content-Type', hit.contentType);
    return res.send(hit.data);
  }

  // Intercept the response to store it
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    const ct = res.getHeader('Content-Type') || 'application/octet-stream';
    if (Buffer.isBuffer(body) && body.length < MAX_BYTES * 0.1) {
      cache.set(key, { data: body, contentType: ct });
      console.log(chalk.blue('[CACHE SET]'), `${body.length} bytes`);
    }
    res.setHeader('X-Cache', 'MISS');
    originalSend(body);
  };

  next();
};

module.exports = middleware;
module.exports.cache     = cache;
module.exports.MAX_BYTES = MAX_BYTES;
