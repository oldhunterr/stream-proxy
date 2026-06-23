const express = require('express');
const axios = require('axios');
const assert = require('assert');

const BASE_URL = 'http://localhost:4002'; // Target server under test
const MOCK_PORT = 4500;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;

// Simple helper to encode base64
const b64Encode = (str) => Buffer.from(str).toString('base64');

async function runTests() {
  console.log('=== STARTING FUNCTIONAL VERIFICATION OF COMPANION MODE AND CRAWLER RETRY ===\n');

  // 1. Start the Mock Server
  const mockApp = express();
  let cfChallengeAccessCount = 0;

  mockApp.get('/cf-challenge', (req, res) => {
    cfChallengeAccessCount++;
    const cookies = req.headers.cookie || '';
    
    console.log(`  [Mock Server] /cf-challenge request #${cfChallengeAccessCount}, Cookie: "${cookies}"`);

    if (!cookies.includes('cf_clearance=12345')) {
      // First pass: Return a Cloudflare challenge page
      res.setHeader('Set-Cookie', 'cf_clearance=12345; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'text/html');
      res.status(200).send('<html><head><title>Cloudflare Challenge</title></head><body>Please solve the challenge to proceed.</body></html>');
    } else {
      // Second pass: Return the actual page with media content
      res.setHeader('Content-Type', 'text/html');
      res.status(200).send(`
        <html>
          <body>
            <video src="${MOCK_URL}/mock_stream.mp4"></video>
          </body>
        </html>
      `);
    }
  });

  mockApp.get('/mock_stream.mp4', (req, res) => {
    console.log('  [Mock Server] Serving mock_stream.mp4');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', '1000');
    res.status(200).send(Buffer.alloc(1000, 0x01));
  });

  mockApp.get('/hang', (req, res) => {
    console.log('  [Mock Server] /hang requested (simulating latency)...');
    // Do not respond to simulate timeout
  });

  mockApp.get('/error-500', (req, res) => {
    console.log('  [Mock Server] /error-500 requested...');
    res.status(500).send('Internal Server Error');
  });

  const mockServer = mockApp.listen(MOCK_PORT, () => {
    console.log(`  [Mock Server] Running on http://localhost:${MOCK_PORT}\n`);
  });

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      console.log(`[Test] ${name}...`);
      await fn();
      console.log(`✅ Passed\n`);
      passed++;
    } catch (e) {
      console.error(`❌ Failed: ${e.message}\n`);
      failed++;
    }
  };

  try {
    // --- TEST GROUP 1: CRAWLER FALLBACK RETRY LOGIC ---
    await test('Crawler Fallback Retry Logic on Cloudflare Challenge', async () => {
      cfChallengeAccessCount = 0;
      const target = `${MOCK_URL}/cf-challenge`;
      const encUrl = b64Encode(target);
      
      const res = await axios.get(`${BASE_URL}/extract?url=${encUrl}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.candidates.length > 0, 'Should find at least 1 candidate stream');
      
      const candidate = res.data.candidates[0];
      assert.strictEqual(candidate.url, `${MOCK_URL}/mock_stream.mp4`);
      assert.strictEqual(cfChallengeAccessCount, 2, 'Should access the mock server twice (retry flow)');
    });

    // --- TEST GROUP 2: STREMIO COMPANION MODE AND ERROR VIDEO REDIRECTION ---
    await test('GET /stream companion mode error video redirection on failing URL', async () => {
      // URL that returns 500 error
      const encUrl = b64Encode(`${MOCK_URL}/error-500`);
      const res = await axios.get(`${BASE_URL}/stream?url=${encUrl}&stremio=true`, {
        maxRedirects: 0,
        validateStatus: () => true
      });

      assert.strictEqual(res.status, 302);
      const redirectUrl = res.headers.location;
      assert.ok(redirectUrl.includes('/stream/error.m3u8'), `Redirect target should be error playlist, got ${redirectUrl}`);
      
      // Extract encoded message from redirect url
      const urlObj = new URL(redirectUrl, BASE_URL);
      const msg = urlObj.searchParams.get('msg');
      assert.ok(msg, 'Redirect URL should contain error message');
      console.log(`    ↳ Received error msg: "${msg}"`);
    });

    await test('GET /stream companion mode error video redirection on simulated latency (timeout)', async () => {
      // URL that hangs
      const encUrl = b64Encode(`${MOCK_URL}/hang`);
      // Since stream resolver timeouts could take longer, let's verify if resolving a slow url redirects
      // We will set a client timeout or let the server time out.
      // Wait, deepScanPage takes 25s, but fast extraction takes 15s.
      // Let's call /proxy or /hls directly with companion mode under short timeouts.
      const start = Date.now();
      const res = await axios.get(`${BASE_URL}/proxy?url=${encUrl}&stremio=true`, {
        maxRedirects: 0,
        validateStatus: () => true
      });
      const elapsed = Date.now() - start;
      console.log(`    ↳ /proxy with hang url took ${elapsed}ms`);
      assert.strictEqual(res.status, 302);
      assert.ok(res.headers.location.includes('/stream/error.m3u8'));
    });

    await test('Verify error.m3u8 returns a valid playlist pointing to error subtitle and error video', async () => {
      const errorMsg = 'Failed to extract any playable video streams.';
      const res = await axios.get(`${BASE_URL}/stream/error.m3u8?msg=${encodeURIComponent(errorMsg)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('mpegurl') || res.headers['content-type'].includes('mpegURL'));
      assert.ok(res.data.includes('#EXTM3U'));
      assert.ok(res.data.includes('error_subtitle.vtt?msg=Failed%20to%20extract%20any%20playable%20video%20streams.'));
      assert.ok(res.data.includes('error_video.m3u8'));
    });

    await test('Verify error_subtitle.vtt serves correctly', async () => {
      const errorMsg = 'Custom error message 123';
      const res = await axios.get(`${BASE_URL}/stream/error_subtitle.vtt?msg=${encodeURIComponent(errorMsg)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/vtt'));
      assert.ok(res.data.includes('WEBVTT'));
      assert.ok(res.data.includes(errorMsg));
    });

    await test('Verify error_video.m3u8 serves correctly', async () => {
      const res = await axios.get(`${BASE_URL}/stream/error_video.m3u8`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('mpegurl') || res.headers['content-type'].includes('mpegURL'));
      assert.ok(res.data.includes('error_video.ts'));
    });

    await test('Verify error_video.ts serves playable TS video binary', async () => {
      const res = await axios.get(`${BASE_URL}/stream/error_video.ts`, {
        responseType: 'arraybuffer'
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'video/mp2t');
      assert.ok(res.data.length > 0, 'TS video segment should not be empty');
      // TS packets must start with 0x47 (sync byte)
      assert.strictEqual(res.data[0], 0x47, 'First byte of TS packet must be 0x47');
    });

    // --- TEST GROUP 3: ROBUSTNESS AGAINST CRASH ON INVALID SCHEMES ---
    await test('Verify non-http scheme URL does not crash the server', async () => {
      // base64 for ftp://ftp.example.com
      const encUrl = b64Encode('ftp://ftp.example.com');
      
      const res = await axios.get(`${BASE_URL}/stream?url=${encUrl}`, {
        validateStatus: () => true
      });
      
      assert.strictEqual(res.status, 502);
      assert.ok(res.data.error, 'Should return error message');

      // Verify server is still alive
      const statusRes = await axios.get(`${BASE_URL}/status`);
      assert.strictEqual(statusRes.status, 200);
      assert.strictEqual(statusRes.data.status, 'ok');
    });

  } finally {
    // 4. Cleanup Mock Server
    mockServer.close(() => {
      console.log('  [Mock Server] Closed.');
    });
  }

  console.log('=== VERIFICATION SUMMARY ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Unhandled error in test suite:', err);
  process.exit(1);
});
