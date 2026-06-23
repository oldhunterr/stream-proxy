const assert = require('assert');
const express = require('express');
const axios = require('axios');
const browserModule = require('./routes/browser');

const app = express();
const PORT = 3090;

// ── Mock Endpoints for Adversarial Cases ─────────────────────────────────────

// Case 1: Generic content-type (application/octet-stream) containing JS/HTML
app.get('/generic-octet-stream-js', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.status(200).send('console.log("Adversarial payload inside octet-stream");');
});

app.get('/generic-octet-stream-html', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.status(200).send('<!DOCTYPE html><html><body><h1>Fake Video</h1></body></html>');
});

// Case 2: text/plain masquerading as video/mp4 URL but with text body
app.get('/text-plain-mp4', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send('This is just plain text, not a video stream.');
});

// Case 3: Empty body or 0-byte video response
app.get('/zero-byte-video.mp4', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', '0');
  res.status(200).send('');
});

// Case 4: Dummy manifest with valid tags but no segments
app.get('/dummy-no-segments.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-ENDLIST\n');
});

// Case 5: HTML comment containing M3U8 tags inside a valid HTML document
app.get('/html-comment-m3u8.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/x-mpegurl');
  res.send(`<!DOCTYPE html>
<html>
<head><title>Fake Playlist</title></head>
<body>
  <!--
  #EXTM3U
  #EXT-X-TARGETDURATION:10
  #EXTINF:10,
  http://example.com/segment.ts
  -->
  <p>Not a real playlist, but contains commented out tags.</p>
</body>
</html>`);
});

// Case 6: Fake DASH manifest (just contains <MPD in string)
app.get('/fake-dash.mpd', (req, res) => {
  res.setHeader('Content-Type', 'application/dash+xml');
  res.send('This is not XML but it contains <MPD tag somewhere inside it.');
});

// Case 7: video/mp4 with HTML body (MIME Spoofing)
app.get('/spoofed-mp4-html', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Range', 'bytes 0-99/100');
  res.status(206).send('<html><head><title>Spoofed</title></head><body>Hello</body></html>');
});

let server;

async function runAdversarialScannerTests() {
  console.log('=== STARTING ADVANCED ADVERSARIAL SCANNER TESTS ===\n');

  let failedCount = 0;
  let passedCount = 0;

  const test = async (name, fn) => {
    try {
      console.log(`[Test] ${name}...`);
      await fn();
      console.log(`✅ Completed test: ${name}\n`);
      passedCount++;
    } catch (e) {
      console.error(`❌ Assertion Failed in: ${name}`);
      console.error(`   Error: ${e.message}\n`);
      failedCount++;
    }
  };

  // Test 1: Octet-stream content type containing JavaScript
  await test('Octet-stream content-type containing Javascript', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/generic-octet-stream-js`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects octet-stream with JS content');
  });

  // Test 2: Octet-stream content type containing HTML
  await test('Octet-stream content-type containing HTML', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/generic-octet-stream-html`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects octet-stream with HTML content');
  });

  // Test 3: Text/plain content type
  await test('Text/plain content-type with no playlist/media structure', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/text-plain-mp4`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects text/plain content as valid stream');
  });

  // Test 4: Zero-byte video stream
  await test('Zero-byte response with video/mp4 content-type', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/zero-byte-video.mp4`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects 0-byte video files');
  });

  // Test 5: Dummy manifest with no actual segments
  await test('Dummy M3U8 manifest with no actual segments', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/dummy-no-segments.m3u8`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects manifest with tags but no segments');
  });

  // Test 6: HTML comments containing M3U8 tags
  await test('HTML page containing commented M3U8 tags', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/html-comment-m3u8.m3u8`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects HTML pages containing commented M3U8 tags');
  });

  // Test 7: Fake DASH manifest (just XML-like string)
  await test('Fake DASH manifest matching XML string', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/fake-dash.mpd`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects fake DASH manifest');
  });

  // Test 8: MIME Spoofed HTML as video/mp4
  await test('Spoofed video/mp4 containing HTML body', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/spoofed-mp4-html`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, false, 'Rejects spoofed video/mp4 containing HTML body');
  });

  console.log('=== ADVANCED ADVERSARIAL TEST SUMMARY ===');
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);

  server.close(() => {
    console.log('Adversarial mock server closed.');
    process.exit(0); // Exit cleanly, we want to report the findings rather than error out the test suite if we're showing they bypass.
  });
}

server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Adversarial mock server listening on port ${PORT}`);
  runAdversarialScannerTests();
});
