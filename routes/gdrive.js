const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

/**
 * GET /gdrive?url=<base64>
 *
 * Google Drive files >100 MB trigger a "virus scan warning" page.
 * This route:
 *   1. Converts /view or /preview URLs to /uc?export=download
 *   2. Follows the 303 redirect to drive.usercontent.google.com
 *   3. Parses the virus-scan confirmation page for confirm + uuid tokens
 *   4. Returns the final direct-download URL (streamable video/mp4)
 */
router.get('/', async (req, res) => {
  const b64 = req.query.url;
  if (!b64) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const originalUrl = Buffer.from(b64, 'base64').toString('utf-8');
    console.log(`[GDrive] Original URL: ${originalUrl}`);

    // Extract fileId from various Google Drive URL formats
    let fileId;
    const patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]+)/,           // /file/d/<id>/view
      /[?&]id=([a-zA-Z0-9_-]+)/,                // ?id=<id>
      /\/open\?id=([a-zA-Z0-9_-]+)/,            // /open?id=<id>
      /\/uc\?.*id=([a-zA-Z0-9_-]+)/,            // /uc?id=<id>
    ];
    for (const p of patterns) {
      const m = originalUrl.match(p);
      if (m) { fileId = m[1]; break; }
    }
    if (!fileId) {
      return res.status(400).json({ error: 'Could not extract Google Drive file ID from URL' });
    }
    console.log(`[GDrive] File ID: ${fileId}`);

    // Step 1: Hit the export download URL (follows 303 → virus scan page)
    const scanUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
    const scanRes = await axios.get(scanUrl, {
      headers: { 'User-Agent': UA },
      timeout: 15000,
      validateStatus: () => true,
    });

    // If we got the video directly (small files), return immediately
    const ct = scanRes.headers['content-type'] || '';
    if (ct.includes('video') || ct.includes('octet-stream') || ct.includes('audio')) {
      console.log(`[GDrive] Direct download (no virus scan), content-type: ${ct}`);
      return res.json({ url: scanUrl, type: 'direct', contentType: ct });
    }

    const html = typeof scanRes.data === 'string' ? scanRes.data : '';

    // Step 2: Parse the virus-scan confirmation form
    const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/);
    const uuidMatch    = html.match(/name="uuid"\s+value="([^"]+)"/);

    if (!confirmMatch || !uuidMatch) {
      return res.status(500).json({ error: 'Could not find confirm/uuid tokens on virus scan page' });
    }

    const confirm = confirmMatch[1];
    const uuid    = uuidMatch[1];
    console.log(`[GDrive] Confirm: ${confirm}, UUID: ${uuid}`);

    // Capture cookies from the scan page response
    const setCookies = scanRes.headers['set-cookie'] || [];
    const cookieStr  = setCookies.map(c => c.split(';')[0]).join('; ');

    // Step 3: Build the confirmed download URL
    const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirm}&uuid=${uuid}`;

    // Verify the confirmed URL actually streams video
    const verifyRes = await axios.head(directUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookieStr },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    const verifyType = verifyRes.headers['content-type'] || 'unknown';
    const verifyLen  = verifyRes.headers['content-length'] || 'unknown';
    console.log(`[GDrive] Verified: ${verifyRes.status} ${verifyType} ${verifyLen} bytes`);

    // Build the proxy URL with cookies baked in
    const headersPayload = Buffer.from(JSON.stringify({
      'Cookie': cookieStr,
      'User-Agent': UA
    })).toString('base64');

    const proxyUrl = `/proxy?url=${Buffer.from(directUrl).toString('base64')}&headers=${headersPayload}`;

    res.json({
      url: directUrl,
      proxyUrl,
      contentType: verifyType,
      contentLength: verifyLen,
      fileId,
    });

  } catch (err) {
    console.error('[GDrive] Error:', err.message);
    res.status(500).json({ error: 'Failed to extract Google Drive URL: ' + err.message });
  }
});

module.exports = router;
