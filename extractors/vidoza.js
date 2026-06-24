const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Vidoza',
  test: (url) => /vidoza\.net|videzz\.net/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const match = text.match(/["']?\s*(?:file|src)\s*["']?\s*[:=,]\s*["']([^"']+)/i);
    if (!match) throw new ExtractorError('Vidoza: video URL not found');
    let videoUrl = match[1];
    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    return { url: videoUrl, headers: { Referer: new URL(url).origin + '/' } };
  },
};
