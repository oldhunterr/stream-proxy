const { makeRequest, getCookieString, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Okru',
  test: (url) => /ok\.ru|odnoklassniki/i.test(url),
  extract: async (url) => {
    // Convert full page URL to embed URL for easier extraction
    let embedUrl = url;
    const videoIdMatch = url.match(/ok\.ru\/video\/(\d+)/i);
    if (videoIdMatch) {
      embedUrl = `https://ok.ru/videoembed/${videoIdMatch[1]}`;
    }

    const { text } = await makeRequest(embedUrl, { headers: { 'Accept': 'text/html,*/*' } });
    const cookies = await getCookieString(embedUrl);

    function makeHeaders() {
      const h = { Referer: url };
      if (cookies) h.Cookie = cookies;
      return h;
    }

    // Strategy 1: Parse data-options from embed page (most reliable)
    const dataOptionsMatch = text.match(/data-options=(["'])([\s\S]*?)\1/i);
    if (dataOptionsMatch) {
      try {
        const options = JSON.parse(dataOptionsMatch[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        const metadata = options?.flashvars?.metadata;
        if (metadata) {
          const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
          const hlsUrl = meta?.hlsMasterPlaylistUrl || meta?.hlsManifestUrl || meta?.ondemandHls;
          if (hlsUrl) return { url: hlsUrl, type: 'HLS', headers: makeHeaders() };
        }
      } catch (_) {}
    }

    // Strategy 2: Look for direct m3u8 URL in page source
    const m3u8Match = text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (m3u8Match) return { url: m3u8Match[1], type: 'HLS', headers: makeHeaders() };

    // Strategy 3: Look for og:video URL in meta tags
    const ogMatch = text.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
    if (ogMatch && ogMatch[1].startsWith('http')) {
      const ogUrl = ogMatch[1];
      if (ogUrl.includes('/videoembed/')) {
        const embedResp = await makeRequest(ogUrl, { headers: { 'Accept': 'text/html,*/*' } });
        const embedCookies = await getCookieString(ogUrl);
        const embedMatch = embedResp.text.match(/data-options=(["'])([\s\S]*?)\1/i);
        if (embedMatch) {
          try {
            const options = JSON.parse(embedMatch[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
            const metadata = options?.flashvars?.metadata;
            if (metadata) {
              const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
              const hlsUrl = meta?.hlsMasterPlaylistUrl || meta?.hlsManifestUrl || meta?.ondemandHls;
              if (hlsUrl) return { url: hlsUrl, type: 'HLS', headers: { Referer: url, Cookie: embedCookies || '' } };
            }
          } catch (_) {}
        }
      }
    }

    throw new ExtractorError('Okru: video URL not found');
  },
};
