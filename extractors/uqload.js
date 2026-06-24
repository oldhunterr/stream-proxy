const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Uqload',
  test: (url) => /uqload\.(com|io|to)/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const match = text.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
                  text.match(/file\s*:\s*["']([^"']+)["']/i);
    if (!match) throw new ExtractorError('Uqload: video URL not found');
    let videoUrl = match[1];
    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    return { url: videoUrl, headers: { Referer: url } };
  },
};
