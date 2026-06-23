const axios = require('axios');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';

async function runEdgeCaseTests() {
  console.log('=== STARTING SERVER EDGE CASE & ROBUSTNESS TESTS ===\n');

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

  // --- 1. ROUTE PARAMETER MISSING/MALFORMED TESTS ---
  
  await test('GET /stream with missing url parameter (JSON format)', async () => {
    const res = await axios.get(`${BASE_URL}/stream?format=json`, { validateStatus: () => true });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.error, 'Missing ?url= parameter');
  });

  await test('GET /stream with invalid base64 characters', async () => {
    // base64 strings shouldn't have exclamation marks or hashes in them.
    // The decodeUrl helper should fallback or return error gracefully without throwing uncaught exceptions.
    const res = await axios.get(`${BASE_URL}/stream?url=!!!invalid_b64!!!`, { validateStatus: () => true });
    assert.strictEqual(res.status, 502); // it tries to run extractor on decoded URL or decoded value
    assert.ok(res.data.error);
  });

  await test('GET /stream with base64 decoding to non-http URL (e.g. ftp://)', async () => {
    // base64 for 'ftp://ftp.example.com' is 'ZnRwOi8vZnRwLmV4YW1wbGUuY29t'
    const res = await axios.get(`${BASE_URL}/stream?url=ZnRwOi8vZnRwLmV4YW1wbGUuY29t`, { validateStatus: () => true });
    // Since it doesn't start with http/https, decodeUrl returns the raw URL or raw base64.
    // In either case, the extractor will fail to request it.
    assert.strictEqual(res.status, 502);
    assert.ok(res.data.error);
  });

  // --- 2. COMPANION MODE ROBUSTNESS ---

  await test('GET /stream in Companion Mode (stremio=true) with missing url', async () => {
    const res = await axios.get(`${BASE_URL}/stream?stremio=true`, { validateStatus: () => true });
    // Without url, the check `if (!rawUrl)` runs before `isCompanionMode` check.
    // Wait, let's see: `if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });`
    assert.strictEqual(res.status, 400);
  });

  await test('GET /stream in Companion Mode (stremio=true) with invalid/failing URL', async () => {
    // base64 for 'http://invalid.domain.xyz' is 'aHR0cDovL2ludmFsaWQuZG9tYWluLnh5eg=='
    const res = await axios.get(`${BASE_URL}/stream?url=aHR0cDovL2ludmFsaWQuZG9tYWluLnh5eg==&stremio=true`, {
      maxRedirects: 0,
      validateStatus: () => true
    });
    // It should redirect to /stream/error.m3u8 on resolution failure
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('/stream/error.m3u8'));
  });

  await test('GET /stream/error.m3u8 with missing message parameter', async () => {
    const res = await axios.get(`${BASE_URL}/stream/error.m3u8`, { validateStatus: () => true });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('mpegurl'));
    assert.ok(res.data.includes('error_subtitle.vtt?msg=Unknown%20error'));
  });

  await test('GET /stream/error.m3u8 with HTML/XSS injection payload', async () => {
    const payload = '<script>alert(1)</script>';
    const encPayload = encodeURIComponent(payload);
    const res = await axios.get(`${BASE_URL}/stream/error.m3u8?msg=${encPayload}`, { validateStatus: () => true });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes(encPayload)); // URL encoded payload is safe in HLS playlist
  });

  await test('GET /stream/error_subtitle.vtt with missing message parameter', async () => {
    const res = await axios.get(`${BASE_URL}/stream/error_subtitle.vtt`, { validateStatus: () => true });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/vtt'));
    assert.ok(res.data.includes('WEBVTT'));
    assert.ok(res.data.includes('Unknown error'));
  });

  await test('GET /stream/error_subtitle.vtt with special character message', async () => {
    const msg = 'Error occurred: [Line 1] -> details & info';
    const res = await axios.get(`${BASE_URL}/stream/error_subtitle.vtt?msg=${encodeURIComponent(msg)}`, { validateStatus: () => true });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes(msg));
  });

  // --- 3. EXTRACTOR ENDPOINT BOUNDARY & SSRF PROTECTION ---

  const extractors = ['mixdrop', 'voe', 'mega', 'gdrive', 'fileupload', 'lulu'];

  for (const ext of extractors) {
    await test(`GET /${ext} with missing url parameter`, async () => {
      const res = await axios.get(`${BASE_URL}/${ext}`, { validateStatus: () => true });
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.toLowerCase().includes('missing'));
    });

    await test(`GET /${ext} with invalid base64`, async () => {
      const res = await axios.get(`${BASE_URL}/${ext}?url=invalid_b64_string`, { validateStatus: () => true });
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.toLowerCase().includes('invalid'));
    });

    await test(`GET /${ext} with untrusted host domain (SSRF protection)`, async () => {
      // base64 for 'https://evil-untrusted-domain.com/file' is 'aHR0cHM6Ly9ldmlsLXVudHJ1c3RlZC1kb21haW4uY29tL2ZpbGU='
      const res = await axios.get(`${BASE_URL}/${ext}?url=aHR0cHM6Ly9ldmlsLXVudHJ1c3RlZC1kb21haW4uY29tL2ZpbGU=`, { validateStatus: () => true });
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.toLowerCase().includes('untrusted') || res.data.error.toLowerCase().includes('invalid'));
    });
  }

  console.log('=== EDGE CASE TEST SUMMARY ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error('❌ Robustness verification failed!');
    process.exit(1);
  } else {
    console.log('🎉 Robustness verification passed successfully!');
    process.exit(0);
  }
}

runEdgeCaseTests().catch(err => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
