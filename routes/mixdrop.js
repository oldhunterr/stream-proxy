const express = require('express');
const axios = require('axios');
const router = express.Router();
const packer = require('../utils/packer');

const ALTERNATIVE_DOMAINS = [
    'mixdrop.co',
    'mixdrop.to',
    'mixdrop.ag',
    'mixdrop.sx',
    'mixdrop.bz',
    'mixdrop.ch',
    'mixdrop.vc',
    'mixdrop.ws'
];

router.get('/', async (req, res) => {
    const b64Url = req.query.url;
    if (!b64Url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    let url;
    try {
        const decoded = Buffer.from(b64Url, 'base64').toString('utf8');
        if (!decoded.startsWith('http://') && !decoded.startsWith('https://')) {
            return res.status(400).json({ error: 'Invalid URL parameter' });
        }
        const parsedUrl = new URL(decoded);
        url = parsedUrl.toString();
    } catch (err) {
        return res.status(400).json({ error: 'Invalid URL parameter' });
    }

    // SSRF Protection: Extract hostname and verify allowed domain
    let hostname;
    try {
        const parsedUrl = new URL(url);
        hostname = parsedUrl.hostname.toLowerCase();
    } catch (err) {
        return res.status(400).json({ error: 'Invalid URL parameter' });
    }

    const hostWithoutWww = hostname.replace(/^www\./, '');
    if (!ALTERNATIVE_DOMAINS.includes(hostWithoutWww)) {
        return res.status(400).json({ error: 'Untrusted target domain' });
    }

    console.log(`[Mixdrop] Decoding and fetching target: ${url}`);

    // Prepare domain failover lists
    const urlsToTry = [url];
    const matchId = url.match(/(?:\/e\/|\/f\/)([a-zA-Z0-9]+)/);
    if (matchId) {
        const videoId = matchId[1];
        for (const domain of ALTERNATIVE_DOMAINS) {
            if (domain !== hostWithoutWww) {
                urlsToTry.push(`https://${domain}/e/${videoId}`);
            }
        }
    }

    let html = null;
    let successfulUrl = null;
    let lastError = null;

    for (const tryUrl of urlsToTry) {
        try {
            console.log(`[Mixdrop] Trying extraction from URL: ${tryUrl}`);
            const response = await axios.get(tryUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': new URL(tryUrl).origin + '/'
                },
                timeout: 10000,
                validateStatus: () => true
            });

            if (response.status >= 200 && response.status < 400 && response.data) {
                const dataStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                const lowerDataStr = dataStr.toLowerCase();
                // Relaxed Substring Check
                if (lowerDataStr.includes('eval') && lowerDataStr.includes('function(p,a,c,k,e,')) {
                    html = dataStr;
                    successfulUrl = tryUrl;
                    break;
                }
            }
        } catch (err) {
            console.warn(`[Mixdrop] Fetch failed for ${tryUrl}: ${err.message}`);
            lastError = err;
        }
    }

    if (!html) {
        return res.status(502).json({ 
            error: 'Failed to retrieve Mixdrop page from all domain alternatives',
            details: lastError ? lastError.message : 'No valid HTML/packed content received'
        });
    }

    // Use shared packer to find and unpack all eval blocks
    const unpackedBlocks = packer.findAndUnpack(html);
    if (unpackedBlocks.length === 0) {
        return res.status(500).json({ error: 'Could not find packed eval block' });
    }

    // Extract video URL from unpacked blocks using patterns
    const patterns = [
      /(?:wurl|vurl|remu)\s*=\s*["']([^"']+)["']/i,
      /["'](\/\/[^"']+\.mp4[^"']*)["']/i,
      /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
    ];

    let videoUrl = null;
    for (const unpacked of unpackedBlocks) {
      videoUrl = packer.extractUrlFromPatterns(unpacked, patterns);
      if (videoUrl) break;
    }

    if (!videoUrl) {
        return res.status(500).json({ error: 'wurl/vurl not found in unpacked block' });
    }

    if (videoUrl.startsWith('//')) {
        videoUrl = 'https:' + videoUrl;
    }

    console.log(`[Mixdrop] Successfully extracted stream: ${videoUrl}`);
    
    // Route through the local proxy to inject the required Referer header
    const encUrl = Buffer.from(videoUrl).toString('base64');
    const headersObj = {
      'Referer': 'https://mixdrop.ag/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    };
    const encHeaders = Buffer.from(JSON.stringify(headersObj)).toString('base64');
    const proxiedUrl = `/proxy?url=${encUrl}&headers=${encHeaders}`;

    res.json({ url: proxiedUrl });
});

module.exports = router;
