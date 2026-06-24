const { makeRequest, ExtractorError } = require('../utils/extractor_base');
const packer = require('../utils/packer');

module.exports = {
  name: 'FileMoon',
  test: (url) => /filemoon\.(com|site|sx)/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const unpacked = packer.findAndUnpack(text);
    for (const code of unpacked) {
      const match = code.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                    code.match(/file\s*:\s*["']([^"']+)["']/i);
      if (match) {
        let videoUrl = match[1];
        if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
        return { url: videoUrl, headers: { Referer: url } };
      }
    }
    throw new ExtractorError('FileMoon: no stream found');
  },
};
