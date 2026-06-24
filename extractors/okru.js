const { makeRequest, ExtractorError } = require('../utils/extractor_base');

module.exports = {
  name: 'Okru',
  test: (url) => /ok\.ru|odnoklassniki/i.test(url),
  extract: async (url) => {
    const { text } = await makeRequest(url, { headers: { 'Accept': 'text/html,*/*' } });
    const dataOptionsMatch = text.match(/data-options=(["'])([\s\S]*?)\1/i);
    if (!dataOptionsMatch) throw new ExtractorError('Okru: data-options not found');
    let options;
    try {
      options = JSON.parse(dataOptionsMatch[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    } catch (_) {
      throw new ExtractorError('Okru: failed to parse data-options JSON');
    }
    const metadata = options?.flashvars?.metadata;
    if (!metadata) throw new ExtractorError('Okru: flashvars.metadata not found');
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const hlsUrl = meta?.hlsMasterPlaylistUrl || meta?.hlsManifestUrl || meta?.ondemandHls;
    if (!hlsUrl) throw new ExtractorError('Okru: no HLS URL in metadata');
    return { url: hlsUrl, type: 'HLS', headers: { Referer: url } };
  },
};
