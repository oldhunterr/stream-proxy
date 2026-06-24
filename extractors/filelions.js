const { makeRequest, ExtractorError } = require('../utils/extractor_base');
const packer = require('../utils/packer');

module.exports = {
  name: 'FileLions',
  test: (url) => /filelions\.(com|to|site)/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const unpacked = packer.findAndUnpack(text);
    for (const code of unpacked) {
      const patterns = [
        /sources:\s*\[{file:\s*["']([^"']+)/i,
        /["']hls4["']:\s*["']([^"']+)/i,
        /["']hls2["']:\s*["']([^"']+)/i,
      ];
      for (const pattern of patterns) {
        const match = code.match(pattern);
        if (match) return { url: match[1], headers: { Referer: url } };
      }
    }
    throw new ExtractorError('FileLions: no stream found');
  },
};
