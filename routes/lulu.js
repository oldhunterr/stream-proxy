const express = require('express');
const axios   = require('axios');
const vm      = require('vm');
const router  = express.Router();

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

    // Strategy 2: Find and unpack the eval(function(p,a,c,k,e,d){...}) block
    // Use a greedy regex that captures the entire eval block including multiline content
    const evalBlocks = findEvalBlocks(html);
    console.log(`[Lulu] Found ${evalBlocks.length} eval blocks`);

    for (let i = 0; i < evalBlocks.length; i++) {
      const block = evalBlocks[i];
      console.log(`[Lulu] Unpacking eval block ${i} (${block.length} chars)...`);

      let unpacked = manualUnpack(block);
      if (!unpacked) {
        console.log(`[Lulu] Manual unpack failed for block ${i}`);
        continue;
      }

      console.log(`[Lulu] Unpacked block ${i}: ${unpacked.substring(0, 300)}`);

      // Search for video URLs in unpacked content
      const m3u8 = unpacked.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
      if (m3u8) {
        console.log(`[Lulu] Found m3u8 in packed block: ${m3u8[1]}`);
        const encUrl = Buffer.from(m3u8[1]).toString('base64');
        const headersObj = {
          'Referer': 'https://lulustream.com/',
          'User-Agent': UA
        };
        const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
        const proxiedUrl = `/hls?url=${encUrl}&headers=${encHeaders}`;
        return res.json({ url: proxiedUrl, type: 'hls' });
      }

      const mp4 = unpacked.match(/(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/);
      if (mp4) {
        console.log(`[Lulu] Found mp4 in packed block: ${mp4[1]}`);
        const encUrl = Buffer.from(mp4[1]).toString('base64');
        const headersObj = {
          'Referer': 'https://lulustream.com/',
          'User-Agent': UA
        };
        const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
        const proxiedUrl = `/proxy?url=${encUrl}&headers=${encHeaders}`;
        return res.json({ url: proxiedUrl, type: 'mp4' });
      }

      // Look for file:"..." pattern from JWPlayer setup
      const fileMatch = unpacked.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/);
      if (fileMatch) {
        console.log(`[Lulu] Found file in packed block: ${fileMatch[1]}`);
        const isHls = fileMatch[1].includes('.m3u8');
        const encUrl = Buffer.from(fileMatch[1]).toString('base64');
        const headersObj = {
          'Referer': 'https://lulustream.com/',
          'User-Agent': UA
        };
        const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
        const proxiedUrl = `/${isHls ? 'hls' : 'proxy'}?url=${encUrl}&headers=${encHeaders}`;
        return res.json({ url: proxiedUrl });
      }

      // Look for sources:[{src:"..."}] pattern
      const srcMatch = unpacked.match(/src\s*:\s*["'](https?:\/\/[^"']+)["']/);
      if (srcMatch) {
        console.log(`[Lulu] Found src in packed block: ${srcMatch[1]}`);
        const isHls = srcMatch[1].includes('.m3u8');
        const encUrl = Buffer.from(srcMatch[1]).toString('base64');
        const headersObj = {
          'Referer': 'https://lulustream.com/',
          'User-Agent': UA
        };
        const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
        const proxiedUrl = `/${isHls ? 'hls' : 'proxy'}?url=${encUrl}&headers=${encHeaders}`;
        return res.json({ url: proxiedUrl });
      }
    }

    return res.status(404).json({ error: 'Could not find video URL in Lulustream page' });

  } catch (err) {
    console.error('[Lulu] Error:', err.message);
    res.status(500).json({ error: 'Failed to extract Lulustream URL: ' + err.message });
  }
});

/**
 * Find all eval(function(p,a,c,k,e,d){...}(...)) blocks in HTML,
 * handling multiline content by matching balanced parentheses.
 */
function findEvalBlocks(html) {
  const blocks = [];
  const marker = 'eval(function(p,a,c,k,e,d)';
  let idx = 0;

  while ((idx = html.indexOf(marker, idx)) !== -1) {
    // Find the matching closing parenthesis by counting parens
    let depth = 0;
    let start = idx + 5; // after 'eval('
    let end = start;
    let inString = false;
    let stringChar = '';

    for (let i = idx; i < html.length; i++) {
      const ch = html[i];
      const prev = i > 0 ? html[i-1] : '';

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
          // The content between eval( and the final ) is the function call
          blocks.push(html.substring(start, i));
          idx = i + 1;
          break;
        }
      }
    }

    if (depth !== 0) break; // malformed, stop
  }

  return blocks;
}

/**
 * Manual unpacker for p,a,c,k,e,d format.
 */
function manualUnpack(packedContent) {
  // The content is: function(p,a,c,k,e,d){while(c--)...}('encoded',base,count,'dict|...'...)
  // We need to extract p (the encoded template), a (base), c (count), and k (dictionary)
  
  const argsMatch = packedContent.match(/\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'/);
  if (!argsMatch) return null;

  let p = argsMatch[1];
  const a = parseInt(argsMatch[2]);
  let c = parseInt(argsMatch[3]);
  const k = argsMatch[4].split('|');

  // Apply replacements (same algorithm as the packed function)
  while (c--) {
    if (k[c]) {
      const token = c.toString(a);
      const regex = new RegExp('\\b' + token + '\\b', 'g');
      p = p.replace(regex, k[c]);
    }
  }

  return p;
}

module.exports = router;
