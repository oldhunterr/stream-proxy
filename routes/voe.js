const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const vm = require('vm');
const router = express.Router();

puppeteer.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Helper to check if a URL is a decoy (Big Buck Bunny, etc.)
function isDecoy(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return lower.includes('bunny') || lower.includes('decoy') || lower.includes('static/video/mp4') || lower.includes('big_buck_bunny');
}

// ROT13 helper
function rot13(str) {
    if (!str) return '';
    return str.replace(/[a-zA-Z]/g, function(c) {
        return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
    });
}

// Decrypt Voe JSON payload using static decryption logic
function decryptVoePayload(obfuscatedStr) {
    try {
        // 1. ROT13
        const step1 = rot13(obfuscatedStr);
        
        // 2. Remove separators
        const separators = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
        let step2 = step1;
        for (const sep of separators) {
            step2 = step2.split(sep).join('');
        }
        
        // 3. Base64 decode to string
        const step3 = Buffer.from(step2, 'base64').toString('utf-8');
        
        // 4. Shift charcode by -3
        let step4 = '';
        for (let i = 0; i < step3.length; i++) {
            step4 += String.fromCharCode(step3.charCodeAt(i) - 3);
        }
        
        // 5. Reverse string
        const step5 = step4.split('').reverse().join('');
        
        // 6. Base64 decode again
        const step6 = Buffer.from(step5, 'base64').toString('utf-8');
        
        // 7. Parse JSON
        return JSON.parse(step6);
    } catch (err) {
        console.error('[Voe Decryption Error]', err.message);
        return null;
    }
}

// Extract stream URL from the encrypted JSON payload
function extractFromJSONPayload(html) {
    const jsonMatch = html.match(/<script type="application\/json">([\s\S]*?)<\/script>/);
    if (!jsonMatch) return null;
    try {
        const payload = JSON.parse(jsonMatch[1]);
        if (Array.isArray(payload) && typeof payload[0] === 'string') {
            const config = decryptVoePayload(payload[0]);
            if (config) {
                // Prioritize HLS stream, then MP4 direct access, then default file url
                let streamUrl = config.source || config.direct_access_url || config.file;
                if (streamUrl && !isDecoy(streamUrl)) {
                    return streamUrl;
                }
                
                // If config.source is a decoy, search in config for other non-decoy URLs
                if (config.playlist && config.playlist[0]) {
                    const pl = config.playlist[0];
                    if (pl.sources) {
                        for (const source of pl.sources) {
                            if (source.file && !isDecoy(source.file)) {
                                return source.file;
                            }
                        }
                    }
                    if (pl.file && !isDecoy(pl.file)) {
                        return pl.file;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Voe JSON extract error]', e.message);
    }
    return null;
}

// 2. Regular expression base64 extraction fallback
function extractFromBase64(html) {
    const candidates = new Set();

    // Match typical atob('...') or atob("...")
    const atobRegex = /atob\s*\(\s*['"`]([A-Za-z0-9+/=]{10,})['"`]\s*\)/g;
    let match;
    while ((match = atobRegex.exec(html)) !== null) {
        try {
            const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
            if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
                candidates.add(decoded);
            } else if (decoded.startsWith('{') && decoded.endsWith('}')) {
                const parsed = JSON.parse(decoded);
                for (const key of ['hls', 'mp4', 'url', 'file', 'src']) {
                    if (parsed[key] && (parsed[key].startsWith('http://') || parsed[key].startsWith('https://'))) {
                        candidates.add(parsed[key]);
                    }
                }
            }
        } catch (_) {}
    }

    // Match raw base64 patterns starting with aHR0cHM6Ly (https://) or aHR0cDov (http://)
    const base64UrlRegex = /['"`](aHR0cHM6Ly[A-Za-z0-9+/=]{10,}|aHR0cDov[A-Za-z0-9+/=]{10,})['"`]/g;
    while ((match = base64UrlRegex.exec(html)) !== null) {
        try {
            const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
            if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
                candidates.add(decoded);
            }
        } catch (_) {}
    }

    // Filter out decoys and return the first valid candidate
    for (const url of candidates) {
        if (!isDecoy(url)) {
            return url;
        }
    }
    return null;
}

// 3. Headless browser extraction fallback
async function extractWithPuppeteer(targetUrl) {
    console.log(`[Voe Fallback] Launching Puppeteer for: ${targetUrl}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent(UA);
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': targetUrl
        });

        let extractedUrl = null;

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            const lowerUrl = url.toLowerCase();
            if ((lowerUrl.includes('.m3u8') || lowerUrl.includes('.mp4')) && !isDecoy(url)) {
                extractedUrl = url;
            }
            req.continue();
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(resolve => setTimeout(resolve, 5000));

        await browser.close();
        return extractedUrl;
    } catch (err) {
        console.error(`[Voe Fallback Error] ${err.message}`);
        if (browser) await browser.close().catch(() => {});
        return null;
    }
}

router.get('/', async (req, res) => {
    try {
        const b64Url = req.query.url;
        if (!b64Url) {
            return res.status(400).json({ error: 'Missing url parameter' });
        }

        let targetUrl;
        try {
            targetUrl = Buffer.from(b64Url, 'base64').toString('utf-8');
            if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                return res.status(400).json({ error: 'Invalid URL parameter' });
            }
        } catch (err) {
            return res.status(400).json({ error: 'Invalid URL parameter' });
        }

        console.log(`[Voe] Decoding and fetching: ${targetUrl}`);

        const jar = new CookieJar();
        const client = wrapper(axios.create({ jar, withCredentials: true }));

        let currentUrl = targetUrl;
        let html = '';
        let extractedStreamUrl = null;

        // Follow up to 3 JS redirects (Voe uses JS-based redirection to mirror domains)
        for (let i = 0; i < 3; i++) {
            console.log(`[Voe] Fetching: ${currentUrl}`);
            const response = await client.get(currentUrl, {
                headers: {
                    'User-Agent': UA,
                    'Referer': i === 0 ? targetUrl : currentUrl
                },
                timeout: 10000,
                validateStatus: () => true
            });

            html = response.data || '';
            if (typeof html !== 'string') {
                html = JSON.stringify(html);
            }

            const redirectMatch = 
                html.match(/(?:window\.)?location(?:\.href|\.replace)?\s*=\s*['"]([^'"]+)['"]/) ||
                html.match(/(?:window\.)?location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/);

            if (redirectMatch && !html.includes('var source') && !html.includes("'hls'") && !html.includes('"hls"')) {
                let redirectUrl = redirectMatch[1];
                if (redirectUrl.startsWith('/')) {
                    const urlObj = new URL(redirectUrl, response.request.res.responseUrl || currentUrl);
                    currentUrl = urlObj.href;
                } else {
                    currentUrl = redirectUrl;
                }
                console.log(`[Voe] Followed JS redirect to: ${currentUrl}`);
            } else {
                break;
            }
        }

        // Try static decryption of JSON payload first
        try {
            console.log('[Voe] Attempting static decryption of JSON payload...');
            extractedStreamUrl = extractFromJSONPayload(html);
            if (extractedStreamUrl) {
                console.log(`[Voe] Static JSON payload extraction successful: ${extractedStreamUrl}`);
            }
        } catch (jsonErr) {
            console.error(`[Voe JSON Payload Error] ${jsonErr.message}`);
        }

        // If VM extraction failed, try traditional Base64 static regex extraction
        if (!extractedStreamUrl) {
            console.log('[Voe] VM extraction failed. Trying static Base64 regex extraction...');
            extractedStreamUrl = extractFromBase64(html);
            if (extractedStreamUrl) {
                console.log(`[Voe] Static Base64 regex extraction successful: ${extractedStreamUrl}`);
            }
        }

        // If both static methods failed, use Puppeteer intercept fallback
        if (!extractedStreamUrl) {
            console.log('[Voe] Static extraction failed. Running Puppeteer fallback...');
            extractedStreamUrl = await extractWithPuppeteer(currentUrl);
            if (extractedStreamUrl) {
                console.log(`[Voe] Puppeteer fallback extraction successful: ${extractedStreamUrl}`);
            }
        }

        if (extractedStreamUrl) {
            return res.json({ url: extractedStreamUrl });
        }

        return res.status(404).json({ error: 'Video URL not found in Voe page (all extraction methods failed)' });

    } catch (error) {
        console.error('Voe extractor error:', error.message);
        return res.status(500).json({ error: 'Failed to extract Voe URL', details: error.message });
    }
});

module.exports = router;
