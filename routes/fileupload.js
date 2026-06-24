const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const packer  = require('../utils/packer');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

/**
 * GET /fileupload?url=<base64>
 *
 * file-upload.org embeds use JWPlayer with packed/obfuscated JS.
 * The packed eval block decodes to a jwplayer().setup({...}) call
 * containing the direct file URL on f5.file-upload.download.
 */
router.get('/', async (req, res) => {
  const b64 = req.query.url;
  if (!b64) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const url = Buffer.from(b64, 'base64').toString('utf-8');
    console.log(`[FileUpload] Fetching: ${url}`);

    const r = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 15000,
    });
    const html = r.data;

    // Use shared packer to find and unpack eval blocks
    const unpackedBlocks = packer.findAndUnpack(html);
    if (unpackedBlocks.length === 0) {
      return res.status(500).json({ error: 'Could not find packed eval block' });
    }

    const patterns = [
      /file\s*:\s*["'](https?:\/\/[^"']+)["']/,
      /(https?:\/\/[^\s"']+\.mp4[^\s"']*)/,
      /src\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/,
    ];

    let videoUrl = null;
    for (const unpacked of unpackedBlocks) {
      videoUrl = packer.extractUrlFromPatterns(unpacked, patterns);
      if (videoUrl) break;
    }

    if (!videoUrl) {
      return res.status(500).json({ error: 'Could not find video URL in unpacked code' });
    }

    console.log(`[FileUpload] Extracted URL: ${videoUrl}`);

    // Verify the URL
    try {
      const verify = await axios.head(videoUrl, {
        headers: { 'User-Agent': UA, 'Referer': url },
        timeout: 10000,
        validateStatus: () => true,
      });
      console.log(`[FileUpload] Verify: ${verify.status} ${verify.headers['content-type']} ${verify.headers['content-length']} bytes`);
    } catch (e) {
      console.log(`[FileUpload] Verify failed: ${e.message}`);
    }

    // Route through the local proxy to inject the required Referer header
    const encUrl = Buffer.from(videoUrl).toString('base64');
    const headersObj = {
      'Referer': 'https://file-upload.org/',
      'User-Agent': UA
    };
    const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
    const proxiedUrl = `/proxy?url=${encUrl}&headers=${encHeaders}`;

    res.json({ url: proxiedUrl });

  } catch (err) {
    console.error('[FileUpload] Error:', err.message);
    res.status(500).json({ error: 'Failed to extract file-upload URL: ' + err.message });
  }
});

module.exports = router;
