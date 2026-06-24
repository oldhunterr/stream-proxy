const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'VidFast',
  test: (url) => /vidfast\.(com|site)/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const match = text.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                  text.match(/file\s*:\s*["']([^"']+)["']/i);
    if (!match) throw new ExtractorError('VidFast: video URL not found');
    let videoUrl = match[1];
    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    return { url: videoUrl, headers: { Referer: url } };
  },
};
