const { makeRequest, ExtractorError } = require('../utils/extractor_base');
const packer = require('../utils/packer');

module.exports = {
  name: 'Uqload',
  test: (url) => /uqload\.(com|io|to|ws|cx|net|is)/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);

    // Strategy 1: Try direct regex for m3u8 or mp4 URLs
    let match = text.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                text.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
                text.match(/file\s*:\s*["']([^"']+)["']/i);
    if (match) {
      let videoUrl = match[1];
      if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
      return { url: videoUrl, headers: { Referer: url } };
    }

    // Strategy 2: Unpack P.A.C.K.E.R. and search for sources
    const unpacked = packer.findAndUnpack(text);
    for (const code of unpacked) {
      const srcMatch = code.match(/sources:\s*\[{file:\s*["']([^"']+)["']/i) ||
                       code.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                       code.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
      if (srcMatch) {
        let videoUrl = srcMatch[1];
        if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
        return { url: videoUrl, headers: { Referer: url } };
      }
    }

    throw new ExtractorError('Uqload: video URL not found');
  },
};
