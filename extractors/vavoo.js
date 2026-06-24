const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Vavoo',
  test: (url) => /vavoo\.(to|tv)/i.test(url),
  extract: async (url) => {
    let text, finalUrl = url;

    // Mode 1: Try direct fetch, follow redirects
    try {
      const resp = await makeRequest(url, { followRedirects: true });
      text = resp.text;
      finalUrl = resp.finalUrl;
    } catch (_) {
      throw new ExtractorError('Vavoo: fetch failed');
    }

    // Check if response is HTML (redirect page) or direct stream
    if (text && !text.startsWith('#')) {
      const m3u8Match = text.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
      if (m3u8Match) return { url: m3u8Match[1], headers: { Referer: url } };

      const tsMatch = text.match(/(https?:\/\/[^\s"']+\.ts[^\s"']*)/i);
      if (tsMatch) return { url: tsMatch[1], headers: { Referer: url } };
    }

    // If text is HLS playlist, return directly
    if (text && text.startsWith('#EXTM3U')) {
      return { url: finalUrl, headers: { Referer: url } };
    }

    throw new ExtractorError('Vavoo: no stream found');
  },
};
