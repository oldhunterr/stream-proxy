const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Streamtape',
  test: (url) => /streamtape\.com|streamtape\.net/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url);
    const idMatches = text.match(/id=["']([^"']+?)["']/g);
    if (!idMatches || idMatches.length < 2) throw new ExtractorError('Streamtape: id pattern not found');
    const seen = new Map();
    for (const m of idMatches) {
      const val = m.match(/["']([^"']+)["']/)[1];
      seen.set(val, (seen.get(val) || 0) + 1);
    }
    let best = null;
    for (const [val, count] of seen) {
      if (count >= 2 && val.includes('=')) best = val;
    }
    if (!best) throw new ExtractorError('Streamtape: could not find video token');
    const videoUrl = `https://streamtape.com/get_video?${best}`;
    return { url: videoUrl, headers: { Referer: 'https://streamtape.com/' } };
  },
};
