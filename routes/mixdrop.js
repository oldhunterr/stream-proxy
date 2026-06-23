const express = require('express');
const axios = require('axios');
const vm = require('vm');
const router = express.Router();

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

function parseArgs(content) {
    const args = [];
    let current = '';
    let inString = false;
    let stringChar = '';
    let bracketDepth = 0;
    
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (inString) {
            if (char === '\\') {
                current += char;
                if (i + 1 < content.length) {
                    current += content[i + 1];
                    i++;
                }
            } else if (char === stringChar) {
                inString = false;
                current += char;
            } else {
                current += char;
            }
        } else {
            if (char === "'" || char === '"' || char === '`') {
                inString = true;
                stringChar = char;
                current += char;
            } else if (char === '[') {
                bracketDepth++;
                current += char;
            } else if (char === ']') {
                bracketDepth--;
                current += char;
            } else if (char === ',' && bracketDepth === 0) {
                args.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
    }
    if (current) {
        args.push(current.trim());
    }
    return args;
}

function parseStringToken(token) {
    if ((token.startsWith("'") && token.endsWith("'")) || 
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith('`') && token.endsWith('`'))) {
        const raw = token.slice(1, -1);
        return raw.replace(/\\(.)/g, (match, g1) => {
            if (g1 === 'n') return '\n';
            if (g1 === 'r') return '\r';
            if (g1 === 't') return '\t';
            if (g1 === 'b') return '\b';
            if (g1 === 'f') return '\f';
            return g1;
        });
    }
    return token;
}

function decodeDeanEdwards(p, a, c, k, e, d) {
    if (typeof k === 'string') {
        k = k.split('|');
    }
    if (!d || typeof d !== 'object') {
        d = {};
    }
    
    const base = a;
    const base62Encode = (c_val) => {
        const e_func = (n) => {
            return (n < base ? '' : e_func(Math.floor(n / base))) + 
                   ((n % base) > 35 ? String.fromCharCode((n % base) + 29) : (n % base).toString(36));
        };
        return e_func(c_val) || '0';
    };

    for (let i = 0; i < c; i++) {
        const key = base62Encode(i);
        d[key] = k[i] || key;
    }

    const unpacked = p.replace(/\b\w+\b/g, (word) => {
        return d[word] !== undefined ? d[word] : word;
    });
    
    return unpacked;
}

function tryPureUnpack(packedBlock) {
    const lastCurly = packedBlock.lastIndexOf('}');
    if (lastCurly === -1) return null;
    
    const bodyPart = packedBlock.substring(0, lastCurly + 1).trim();
    const argsPart = packedBlock.substring(lastCurly + 1).trim();
    
    if (bodyPart.includes('throw')) {
        return null;
    }
    
    const simpleReturnMatch = bodyPart.match(/\{\s*return\s+(['"`][\s\S]*?['"`])\s*;?\s*\}/);
    if (simpleReturnMatch) {
        return parseStringToken(simpleReturnMatch[1]);
    }
    
    const isStandardPacker = bodyPart.includes('while') && bodyPart.includes('replace');
    if (isStandardPacker) {
        if (!argsPart.startsWith('(') || !argsPart.endsWith(')')) {
            return null;
        }
        const content = argsPart.slice(1, -1).trim();
        const tokens = parseArgs(content);
        if (tokens.length < 4) {
            return null;
        }
        
        const p = parseStringToken(tokens[0]);
        const a = parseInt(tokens[1], 10);
        const c = parseInt(tokens[2], 10);
        
        let k;
        if (tokens[3].includes('.split(')) {
            const splitMatch = tokens[3].match(/^(['"`][\s\S]*?['"`])\s*\.\s*split\s*\(\s*['"`](\|)['"`]\s*\)$/);
            if (splitMatch) {
                k = parseStringToken(splitMatch[1]).split(splitMatch[2]);
            } else {
                return null;
            }
        } else if (tokens[3].startsWith('[') && tokens[3].endsWith(']')) {
            const inner = tokens[3].slice(1, -1).trim();
            k = inner ? parseArgs(inner).map(item => parseStringToken(item)) : [];
        } else {
            k = parseStringToken(tokens[3]);
        }
        
        return decodeDeanEdwards(p, a, c, k);
    }
    
    return null;
}

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

    // Match packed JavaScript block, supporting various arguments and newlines
    const match = html.match(/eval\s*\(\s*(function\s*\(p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*\w\s*\)[\s\S]*?\}\s*\([\s\S]*?\))\s*\)/);
    if (!match) {
        return res.status(500).json({ error: 'Could not find packed eval block' });
    }

    // Unpack using pure JavaScript or secure VM execution fallback
    let unpacked = null;
    try {
        unpacked = tryPureUnpack(match[1]);
    } catch (unpackErr) {
        console.warn(`[Mixdrop] Pure JS unpack failed: ${unpackErr.message}`);
    }

    if (unpacked === null) {
        console.log(`[Mixdrop] Falling back to secure VM execution`);
        try {
            unpacked = vm.runInNewContext('(' + match[1] + ')', Object.create(null), { timeout: 1000 });
        } catch (evalErr) {
            return res.status(500).json({ error: 'Failed to evaluate packed JS block: ' + evalErr.message });
        }
    }

    // Try extracting standard keys (wurl, vurl, remu)
    const wurlMatch = unpacked.match(/(?:wurl|vurl|remu)\s*=\s*["']([^"']+)["']/i);
    let videoUrl = null;

    if (wurlMatch) {
        videoUrl = wurlMatch[1];
    } else {
        // Fallback: search for any mp4 stream URL pattern
        const mp4Match = unpacked.match(/["'](\/\/[^"']+\.mp4[^"']*)["']/i) || 
                         unpacked.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
        if (mp4Match) {
            videoUrl = mp4Match[1];
        }
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
