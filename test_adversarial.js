const assert = require('assert');
const express = require('express');
const axios = require('axios');
const browserModule = require('./routes/browser');

const app = express();
const PORT = 3070;

// Setup adversarial mock endpoints
app.get('/fake-video-html', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Range', 'bytes 0-8191/1000');
  res.setHeader('Content-Length', '1000');
  res.status(206).send('<html><body><h1>Not a real MP4</h1><p>This is HTML masquerading as video/mp4</p></body></html>');
});

app.get('/fake-video-js', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Range', 'bytes 0-8191/1000');
  res.setHeader('Content-Length', '1000');
  res.status(206).send('console.log("This is Javascript masquerading as video/mp4");');
});

app.get('/empty-manifest.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send('#EXTM3U\n#EXTINF:10,\n');
});

app.get('/html-comment-manifest.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send('<!DOCTYPE html><html><!--\n#EXTM3U\n#EXTINF:10,\n--><body>Fake playlist but contains matching tags in comments</body></html>');
});

app.get('/no-tags.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send('#EXTM3U\n#EXT-X-VERSION:3\n');
});

app.get('/infinite-redirect', (req, res) => {
  res.redirect(`/infinite-redirect?r=${Math.random()}`);
});

let server;

async function runAdversarialTests() {
  console.log('=== STARTING ADVERSARIAL SCANNER & VERIFYURL TESTS ===\n');

  let failedCount = 0;
  let passedCount = 0;

  const test = async (name, fn) => {
    try {
      console.log(`[Test] ${name}...`);
      await fn();
      console.log(`✅ Passed: ${name}\n`);
      passedCount++;
    } catch (e) {
      console.error(`❌ Failed: ${name}`);
      console.error(`   Error: ${e.message}\n`);
      failedCount++;
    }
  };

  // Test 1: HTML masquerading as video/mp4
  await test('HTML file masquerading as video/mp4 content-type', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/fake-video-html`);
    console.log('Result:', verify);
    // Under current implementation, verify.ok is expected to be true since it only checks content-type and status.
    // However, conceptually this is a bypass! Let's assert what the system currently does, and note it in our report.
    assert.strictEqual(verify.ok, true, 'Current implementation accepts fake-video-html as valid because content-type is video/mp4');
    assert.strictEqual(verify.contentType, 'video/mp4', 'Should match Content-Type header');
  });

  // Test 2: JS file masquerading as video/mp4
  await test('JS file masquerading as video/mp4 content-type', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/fake-video-js`);
    console.log('Result:', verify);
    assert.strictEqual(verify.ok, true, 'Current implementation accepts fake-video-js as valid because content-type is video/mp4');
  });

  // Test 3: Dummy empty manifest (no segments) but has minimum tags
  await test('Empty manifest with minimum tags', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/empty-manifest.m3u8`);
    console.log('Result:', verify);
    // Current implementation checks for #EXTM3U and (#EXTINF || #EXT-X-STREAM-INF || #EXT-X-TARGETDURATION)
    // So this empty manifest will be validated as OK.
    assert.strictEqual(verify.ok, true, 'Empty manifest with tags should be accepted under current validation logic');
  });

  // Test 4: HTML comment containing M3U8 tags served with mpegurl content-type
  await test('HTML page containing commented M3U8 tags served as mpegurl', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/html-comment-manifest.m3u8`);
    console.log('Result:', verify);
    // Current implementation uses simple String.includes() which matches text within HTML comments.
    assert.strictEqual(verify.ok, true, 'HTML page containing commented M3U8 tags is accepted!');
    assert.strictEqual(verify.contentType, 'application/vnd.apple.mpegurl', 'Matches Content-Type header');
  });

  // Test 5: Manifest missing required second tag (like #EXTINF or #EXT-X-TARGETDURATION)
  await test('Manifest missing required second tag', async () => {
    const verify = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/no-tags.m3u8`);
    console.log('Result:', verify);
    // Should be rejected because it lacks the second tag.
    assert.strictEqual(verify.ok, false, 'Manifest with only #EXTM3U and no targetduration/inf should be rejected');
    assert.strictEqual(verify.error, 'Invalid or empty M3U8 playlist contents');
  });

  console.log('=== ADVERSARIAL TEST SUMMARY ===');
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);

  server.close(() => {
    console.log('Adversarial mock server closed.');
    process.exit(failedCount > 0 ? 1 : 0);
  });
}

server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Adversarial mock server listening on port ${PORT}`);
  runAdversarialTests();
});
