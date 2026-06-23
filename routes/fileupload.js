const express = require('express');
const axios   = require('axios');
const vm      = require('vm');
const router  = express.Router();

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

    // Find the eval block using balanced parenthesis matching
    // (regex fails because the packed string contains escaped parens)
    const evalContent = extractEvalBlock(html);
    if (!evalContent) {
      return res.status(500).json({ error: 'Could not find packed eval block' });
    }

    // Use manual unpacker (vm.runInNewContext fails on double-escaped backslashes)
    let unpacked = manualUnpack(evalContent);
    if (!unpacked) {
      // Fallback: try vm
      try {
        unpacked = vm.runInNewContext('(' + evalContent + ')');
      } catch (e) {
        console.log('[FileUpload] Both unpack methods failed');
      }
    }

    if (!unpacked) {
      return res.status(500).json({ error: 'Failed to unpack eval block' });
    }

    console.log('[FileUpload] Unpacked:', unpacked.substring(0, 300));

    // Extract the video file URL from the unpacked jwplayer setup
    let videoUrl;

    // Pattern 1: file:"https://..." in jwplayer setup
    const fileMatch = unpacked.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/);
    if (fileMatch) videoUrl = fileMatch[1];

    // Pattern 2: Direct URL with .mp4
    if (!videoUrl) {
      const mp4Match = unpacked.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/);
      if (mp4Match) videoUrl = mp4Match[1];
    }

    // Pattern 3: provider src
    if (!videoUrl) {
      const srcMatch = unpacked.match(/src\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/);
      if (srcMatch) videoUrl = srcMatch[1];
    }

    if (!videoUrl) {
      return res.status(500).json({ error: 'Could not find video URL in unpacked code', unpacked: unpacked.substring(0, 500) });
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

/**
 * Manual unpacker for p,a,c,k,e,d format as a fallback.
 * Implements the same algorithm as the eval'd function.
 */
function manualUnpack(packedFn) {
  // Extract: function(p,a,c,k,e,d){while(c--)...}('encoded_string',base,count,'dict|...'...)
  const argsMatch = packedFn.match(/\}\('((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'/);
  if (!argsMatch) return null;

  let p = argsMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const a = parseInt(argsMatch[2]);
  let c = parseInt(argsMatch[3]);
  const k = argsMatch[4].split('|');

  // The unpacking algorithm
  while (c--) {
    if (k[c]) {
      const regex = new RegExp('\\b' + c.toString(a) + '\\b', 'g');
      p = p.replace(regex, k[c]);
    }
  }
  return p;
}

/**
 * Extract eval block content using balanced parenthesis matching.
 * This handles cases where the packed string contains escaped parens
 * that break regex-based extraction.
 */
function extractEvalBlock(html) {
  const marker = 'eval(function(p,a,c,k,e,d)';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const start = idx + 5; // position after 'eval('
  let depth = 1; // we're inside the first '('
  let inString = false;
  let stringChar = '';

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    const prev = i > 0 ? html[i - 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) {
        return html.substring(start, i);
      }
    }
  }
  return null;
}

module.exports = router;
