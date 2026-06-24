const { makeRequest, ExtractorError } = require('../utils/extractor_base');
const axios = require('axios');
const curlCffi = require('../utils/curl_cffi');

module.exports = {
  name: 'VK',
  test: (url) => /vk\.com|vkvideo\.ru/i.test(url),
  extract: async (url) => {
    const ref = 'https://vk.com/';

    // Parse video parameters from URL
    let oid, id, hash;
    const qsMatch = url.match(/[?&]oid=(-?\d+)[&].*?id=(\d+)(?:[&].*?hash=([^&]+))?/);
    if (qsMatch) {
      oid = qsMatch[1];
      id = qsMatch[2];
      hash = qsMatch[3];
    } else {
      const pathMatch = url.match(/vk\.com\/video(-?\d+)_(\d+)/i);
      if (pathMatch) {
        oid = pathMatch[1];
        id = pathMatch[2];
      }
    }
    if (!oid || !id) throw new ExtractorError('VK: could not parse video ID');

    // Strategy 1: POST to al_video.php AJAX endpoint (works for public videos)
    try {
      const params = new URLSearchParams();
      params.append('act', 'show');
      params.append('al', '1');
      params.append('video', `${oid}_${id}`);
      const resp = await axios.post('https://vk.com/al_video.php?act=show', params.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': ref,
          'Origin': 'https://vk.com',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
        validateStatus: () => true,
        maxRedirects: 0,
      });

      let data = resp.data;
      if (typeof data === 'string' && data.startsWith('<!--')) {
        data = data.substring(4);
      }

      let payload;
      if (typeof data === 'string') {
        try { payload = JSON.parse(data).payload; } catch (_) { payload = null; }
      } else if (data && data.payload) {
        payload = data.payload;
      }

      if (payload) {
        // Flatten payload to find the player config
        const allDicts = [];
        const walk = (arr) => {
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (typeof item === 'object' && item !== null) {
                if (item.player && item.player.params) {
                  allDicts.push(item);
                }
                walk(Object.values(item));
              }
            }
          }
        };
        walk(payload);

        for (const item of allDicts) {
          const params = item.player.params;
          if (Array.isArray(params) && params.length > 0) {
            const p = params[0];

            // Collect all quality URLs and pick highest resolution
            const qualities = [];
            for (const key of Object.keys(p)) {
              if (key.startsWith('url') && p[key]) {
                const resMatch = key.match(/url(\d+)/);
                if (resMatch) {
                  let videoUrl = p[key];
                  if (typeof videoUrl === 'string') {
                    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
                    if (videoUrl.startsWith('http')) qualities.push({ res: parseInt(resMatch[1]), url: videoUrl });
                  }
                }
              }
            }
            if (qualities.length > 0) {
              qualities.sort((a, b) => b.res - a.res);
              return { url: qualities[0].url, headers: { Referer: ref } };
            }

            // Fallback to hls
            if (p.hls || p.hls_ondemand || p.hls_live) {
              const hlsUrl = p.hls || p.hls_ondemand || p.hls_live;
              if (hlsUrl.startsWith('http') || hlsUrl.startsWith('//')) {
                return { url: hlsUrl.startsWith('//') ? 'https:' + hlsUrl : hlsUrl, headers: { Referer: ref } };
              }
            }
          }
        }
      }
    } catch (_) {}

    // Strategy 2: Try to find playerParams in page source
    try {
      const pageUrl = `https://vk.com/video_ext.php?oid=${oid}&id=${id}` + (hash ? `&hash=${hash}` : '');
      const { text } = await makeRequest(pageUrl, {
        headers: { 'Accept': 'text/html,*/*', 'Referer': ref },
      });
      const ppMatch = text.match(/var\s+playerParams\s*=\s*(.+?});/);
      if (ppMatch) {
        try {
          const pp = JSON.parse(ppMatch[1]);
          const params = pp?.params?.[0];
          if (params) {
            const qualities = [];
            for (const key of Object.keys(params)) {
              if (key.startsWith('url') && params[key]) {
                const resMatch = key.match(/url(\d+)/);
                if (resMatch) {
                  let videoUrl = params[key];
                  if (typeof videoUrl === 'string') {
                    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
                    if (videoUrl.startsWith('http')) qualities.push({ res: parseInt(resMatch[1]), url: videoUrl });
                  }
                }
              }
            }
            if (qualities.length > 0) {
              qualities.sort((a, b) => b.res - a.res);
              return { url: qualities[0].url, headers: { Referer: ref } };
            }
            if (params.hls || params.hls_ondemand) {
              const hlsUrl = params.hls || params.hls_ondemand;
              return { url: hlsUrl.startsWith('//') ? 'https:' + hlsUrl : hlsUrl, headers: { Referer: ref } };
            }
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Strategy 3: Try curl_cffi
    try {
      const pageUrl = `https://vk.com/video_ext.php?oid=${oid}&id=${id}` + (hash ? `&hash=${hash}` : '');
      const resp = await curlCffi.get(pageUrl, { 'Referer': ref }, true, 15);
      if (resp?.status === 200 && resp?.text) {
        const m3u8Match = resp.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u8Match) return { url: m3u8Match[1], headers: { Referer: ref } };
      }
    } catch (_) {}

    throw new ExtractorError('VK: video URL not found (try browser fallback)');
  },
};
