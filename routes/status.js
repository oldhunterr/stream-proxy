/**
 * /status
 *
 * Returns server health, cache stats, and a summary of all available routes.
 */
const express = require('express');
const router  = express.Router();

// Lazy import cache to avoid circular deps
const getCacheStats = () => {
  try {
    const cacheModule = require('../middleware/cache');
    const cache    = cacheModule.cache;
    const maxBytes = cacheModule.MAX_BYTES;
    return {
      size:       cache.size,
      calculatedSize: cache.calculatedSize,
      maxBytes,
      usedPercent: Math.round((cache.calculatedSize / maxBytes) * 100),
      ttlMs:      (parseInt(process.env.CACHE_TTL) || 300) * 1000,
    };
  } catch (_) {
    return { error: 'cache not available' };
  }
};

router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    cache:  getCacheStats(),
    routes: {
      proxy:   `${base}/proxy?url=<base64-encoded-url>`,
      hls:     `${base}/hls?url=<base64-encoded-m3u8-url>`,
      extract: `${base}/extract?url=<base64-encoded-page-url>`,
      inspect: `${base}/inspect?url=<base64-encoded-url>`,
      dash:    `${base}/dash?url=<base64-encoded-mpd-url>`,
      log:     `${base}/inspect/log`,
      status:  `${base}/status`,
      ui:      `${base}/ui`,
    },
  });
});

module.exports = router;
