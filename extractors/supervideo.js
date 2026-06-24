const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Supervideo',
  test: (url) => /supervideo\.(cc|tv)/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const match = text.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                  text.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
    if (!match) throw new ExtractorError('Supervideo: video URL not found');
    return { url: match[1], headers: { Referer: url } };
  },
};
