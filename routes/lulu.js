const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const packer  = require('../utils/packer');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

/**
 * GET /lulu?url=<base64>
 *
 * Lulustream uses packed/obfuscated JS (p,a,c,k,e,d format) 
 * containing JWPlayer setup with HLS (.m3u8) or MP4 stream URLs.
 * The packed JS is multiline and contains escape sequences that
 * trip up vm.runInNewContext, so we use a manual unpacker.
 */
router.get('/', async (req, res) => {
  const b64 = req.query.url;
  if (!b64) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const url = Buffer.from(b64, 'base64').toString('utf-8');
    console.log(`[Lulu] Fetching: ${url}`);

    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://lulustream.com/',
      },
      timeout: 15000,
    });
    const html = r.data;

    // Strategy 1: Try to find direct video URLs in HTML
    const directM3u8 = html.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
    if (directM3u8) {
      console.log(`[Lulu] Direct m3u8 found: ${directM3u8[1]}`);
      const encUrl = Buffer.from(directM3u8[1]).toString('base64');
      const headersObj = {
        'Referer': 'https://lulustream.com/',
        'User-Agent': UA
      };
      const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
      const proxiedUrl = `/hls?url=${encUrl}&headers=${encHeaders}`;
      return res.json({ url: proxiedUrl, type: 'hls' });
    }

    const directMp4 = html.match(/(?:file|src|source)\s*[:=]\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/);
    if (directMp4) {
      console.log(`[Lulu] Direct mp4 found: ${directMp4[1]}`);
      const encUrl = Buffer.from(directMp4[1]).toString('base64');
      const headersObj = {
        'Referer': 'https://lulustream.com/',
        'User-Agent': UA
      };
      const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
      const proxiedUrl = `/proxy?url=${encUrl}&headers=${encHeaders}`;
      return res.json({ url: proxiedUrl, type: 'mp4' });
    }

    // Strategy 2: Use shared packer to find and unpack eval blocks
    const unpackedBlocks = packer.findAndUnpack(html);
    console.log(`[Lulu] Found ${unpackedBlocks.length} unpacked blocks`);

    const patterns = [
      /(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/,
      /(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/,
      /file\s*:\s*["'](https?:\/\/[^"']+)["']/,
      /src\s*:\s*["'](https?:\/\/[^"']+)["']/,
      /sources:\s*\[{file:\s*["'](https?:\/\/[^"']+)["']/i,
    ];

    for (const unpacked of unpackedBlocks) {
      const videoUrl = packer.extractUrlFromPatterns(unpacked, patterns);
      if (videoUrl) {
        console.log(`[Lulu] Found video URL in packed block: ${videoUrl}`);
        const isHls = videoUrl.includes('.m3u8');
        const encUrl = Buffer.from(videoUrl).toString('base64');
        const headersObj = {
          'Referer': 'https://lulustream.com/',
          'User-Agent': UA
        };
        const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
        const proxiedUrl = `/${isHls ? 'hls' : 'proxy'}?url=${encUrl}&headers=${encHeaders}`;
        return res.json({ url: proxiedUrl, type: isHls ? 'hls' : 'mp4' });
      }
    }

    return res.status(404).json({ error: 'Could not find video URL in Lulustream page' });

  } catch (err) {
    console.error('[Lulu] Error:', err.message);
    res.status(500).json({ error: 'Failed to extract Lulustream URL: ' + err.message });
  }
});

module.exports = router;
