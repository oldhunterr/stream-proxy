const assert = require('assert');
const express = require('express');
const axios = require('axios');
const zlib = require('zlib');
const browserModule = require('./routes/browser');
const streamModule = require('./routes/stream');

const app = express();
const PORT = process.env.PORT || 3061;

app.use('/stream', streamModule);

// Setup mock endpoints
app.get('/player.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send('console.log("mock player script");');
});

app.get('/dummy.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send('This is not a real m3u8 playlist file');
});

app.get('/valid.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts');
});

app.get('/valid.mp4', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Range', 'bytes 0-8191/1000000');
  res.setHeader('Content-Length', '8192');
  res.status(206).send(Buffer.alloc(8192));
});

app.get('/compressed_vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Encoding', 'gzip');
  const buffer = zlib.gzipSync('WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello');
  res.send(buffer);
});

app.get('/bad_content_type', (req, res) => {
  res.setHeader('Content-Type', 'text/subtitle');
  res.send('Some text content');
});

app.get('/utf16le_vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  const vttStr = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello UTF-16LE';
  const vttBuf = Buffer.from(vttStr, 'utf16le');
  const bomBuf = Buffer.from([0xFF, 0xFE]);
  const finalBuf = Buffer.concat([bomBuf, vttBuf]);
  res.send(finalBuf);
});

app.get('/utf16be_vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  const vttStr = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello UTF-16BE';
  const vttBuf = Buffer.from(vttStr, 'utf16le');
  const bomBuf = Buffer.from([0xFE, 0xFF]);
  for (let i = 0; i < vttBuf.length - 1; i += 2) {
    const tmp = vttBuf[i];
    vttBuf[i] = vttBuf[i+1];
    vttBuf[i+1] = tmp;
  }
  const finalBuf = Buffer.concat([bomBuf, vttBuf]);
  res.send(finalBuf);
});

let server;

async function runTests() {
  console.log('=== STARTING DEEPSCAN & VERIFYURL VERIFICATION ===\n');

  let failed = false;

  // 1. Test isStreamLike filtering of excluded extensions
  try {
    console.log('[Test 1] checking isStreamLike filtering...');
    
    const isStreamLike = browserModule.isStreamLike;
    assert.ok(typeof isStreamLike === 'function', 'isStreamLike should be exported');

    // URLs that should be excluded
    const ignoredJsUrl = 'https://rubyvidhub.com/player/jw8/jwplayer.js?v=';
    const ignoredCssUrl = 'https://vibuxer.com/style/theme.css';
    const ignoredPngUrl = 'https://vibuxer.com/images/poster.png?width=800';
    const ignoredHtmlUrl = 'https://vibuxer.com/embed-123.html';

    // URLs that should be accepted
    const acceptedM3u8Url = 'https://vibuxer.com/stream/abc/master.m3u8';
    const acceptedPlayUrl = 'https://vibuxer.com/play/video-segment';
    const acceptedDoodUrl = 'https://dood.to/pass_md5/token123';

    assert.strictEqual(isStreamLike(ignoredJsUrl), false, 'JS URLs must be filtered out');
    assert.strictEqual(isStreamLike(ignoredCssUrl), false, 'CSS URLs must be filtered out');
    assert.strictEqual(isStreamLike(ignoredPngUrl), false, 'PNG URLs must be filtered out');
    assert.strictEqual(isStreamLike(ignoredHtmlUrl), false, 'HTML URLs must be filtered out');

    assert.strictEqual(isStreamLike(acceptedM3u8Url), true, 'M3U8 URLs must be accepted');
    assert.strictEqual(isStreamLike(acceptedPlayUrl), true, 'URLs with play key must be accepted');
    assert.strictEqual(isStreamLike(acceptedDoodUrl), true, 'DoodStream pass_md5 URLs must be accepted');

    console.log('Testing verifyUrl directly on forbidden content types...');
    const verifyJs = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/player.js`);
    console.log('verifyUrl on JS content:', verifyJs);
    assert.strictEqual(verifyJs.ok, false, 'JS player script should not verify successfully');
    assert.strictEqual(verifyJs.error, 'Forbidden content type', 'Should return Forbidden content type error');
    
    console.log('✅ Test 1 Passed: isStreamLike filtering and forbidden content type rejection work correctly.');
  } catch (e) {
    console.error('❌ Test 1 Failed:', e.message);
    failed = true;
  }

  // 2. Test verifyUrl on dummy / invalid m3u8 files (Vibuxer / Rubyvidhub issue)
  try {
    console.log('\n[Test 2] checking verifyUrl on dummy m3u8 file...');
    const verifyDummy = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/dummy.m3u8`);
    console.log('verifyUrl on dummy m3u8:', verifyDummy);
    assert.strictEqual(verifyDummy.ok, false, 'Dummy m3u8 should not verify successfully');
    assert.strictEqual(verifyDummy.error, 'Invalid or empty M3U8 playlist contents', 'Should fail due to invalid/empty playlist contents');
    
    console.log('✅ Test 2 Passed: Dummy m3u8 playlist file is successfully rejected.');
  } catch (e) {
    console.error('❌ Test 2 Failed:', e.message);
    failed = true;
  }

  // 3. Test verifyUrl on valid m3u8 playlist
  try {
    console.log('\n[Test 3] checking verifyUrl on valid m3u8...');
    const verifyValidM3u8 = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/valid.m3u8`);
    console.log('verifyUrl on valid m3u8:', verifyValidM3u8);
    assert.strictEqual(verifyValidM3u8.ok, true, 'Valid m3u8 should verify successfully');
    assert.strictEqual(verifyValidM3u8.contentType, 'application/vnd.apple.mpegurl', 'Should have correct content-type');
    
    console.log('✅ Test 3 Passed: Valid m3u8 playlist file is successfully verified.');
  } catch (e) {
    console.error('❌ Test 3 Failed:', e.message);
    failed = true;
  }

  // 4. Test verifyUrl on valid mp4 video stream (Range request support)
  try {
    console.log('\n[Test 4] checking verifyUrl on valid mp4...');
    const verifyValidMp4 = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/valid.mp4`);
    console.log('verifyUrl on valid mp4:', verifyValidMp4);
    assert.strictEqual(verifyValidMp4.ok, true, 'Valid mp4 should verify successfully');
    assert.strictEqual(verifyValidMp4.contentType, 'video/mp4', 'Should have correct content-type');
    assert.strictEqual(verifyValidMp4.status, 206, 'Should get 206 status for range request');
    
    console.log('✅ Test 4 Passed: Valid mp4 stream with range request is successfully verified.');
  } catch (e) {
    console.error('❌ Test 4 Failed:', e.message);
    failed = true;
  }
  // 5. Test WebVTT Rejection (fast-reject path & hash splitting)
  try {
    console.log('\n[Test 5] checking WebVTT path / hash fast-reject...');
    const resultVtt = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/file.vtt#xywh=0,0,100,100`);
    console.log('verifyUrl on vtt with hash:', resultVtt);
    assert.strictEqual(resultVtt.ok, false, 'WebVTT with hash should be early-rejected');
    assert.strictEqual(resultVtt.error, 'Forbidden path: WebVTT/SRT');

    const resultSrt = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/file.srt?token=abc`);
    console.log('verifyUrl on srt with query:', resultSrt);
    assert.strictEqual(resultSrt.ok, false, 'SRT with query should be early-rejected');
    assert.strictEqual(resultSrt.error, 'Forbidden path: WebVTT/SRT');

    console.log('✅ Test 5 Passed: WebVTT/SRT URLs with queries and hashes are correctly rejected.');
  } catch (e) {
    console.error('❌ Test 5 Failed:', e.message);
    failed = true;
  }

  // 6. Test WebVTT Rejection (content-type check)
  try {
    console.log('\n[Test 6] checking WebVTT content-type rejection...');
    const resultBadType = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/bad_content_type`);
    console.log('verifyUrl on bad content-type:', resultBadType);
    assert.strictEqual(resultBadType.ok, false, 'Subtitle content-type should be rejected');
    assert.strictEqual(resultBadType.error, 'Forbidden content type: Subtitles');

    console.log('✅ Test 6 Passed: Subtitle content-types are successfully rejected.');
  } catch (e) {
    console.error('❌ Test 6 Failed:', e.message);
    failed = true;
  }

  // 7. Test WebVTT Rejection (decompression and signature check)
  try {
    console.log('\n[Test 7] checking decompression and signature rejection...');
    const resultDecompressed = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/compressed_vtt`);
    console.log('verifyUrl on compressed WebVTT:', resultDecompressed);
    assert.strictEqual(resultDecompressed.ok, false, 'Decompressed WebVTT signature should be detected and rejected');
    assert.strictEqual(resultDecompressed.error, 'Forbidden content: WebVTT signature detected');

    console.log('✅ Test 7 Passed: Decompressed WebVTT signatures are successfully detected.');
  } catch (e) {
    console.error('❌ Test 7 Failed:', e.message);
    failed = true;
  }

  // 7b. Test UTF-16LE WebVTT Rejection
  try {
    console.log('\n[Test 7b] checking UTF-16LE WebVTT rejection...');
    const resultLE = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/utf16le_vtt`);
    console.log('verifyUrl on UTF-16LE WebVTT:', resultLE);
    assert.strictEqual(resultLE.ok, false, 'UTF-16LE WebVTT should be detected and rejected');
    assert.strictEqual(resultLE.error, 'Forbidden content: WebVTT signature detected');

    console.log('✅ Test 7b Passed: UTF-16LE WebVTT signature is successfully detected.');
  } catch (e) {
    console.error('❌ Test 7b Failed:', e.message);
    failed = true;
  }

  // 7c. Test UTF-16BE WebVTT Rejection
  try {
    console.log('\n[Test 7c] checking UTF-16BE WebVTT rejection...');
    const resultBE = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/utf16be_vtt`);
    console.log('verifyUrl on UTF-16BE WebVTT:', resultBE);
    assert.strictEqual(resultBE.ok, false, 'UTF-16BE WebVTT should be detected and rejected');
    assert.strictEqual(resultBE.error, 'Forbidden content: WebVTT signature detected');

    console.log('✅ Test 7c Passed: UTF-16BE WebVTT signature is successfully detected.');
  } catch (e) {
    console.error('❌ Test 7c Failed:', e.message);
    failed = true;
  }

  // 8. Test Stremio Companion Mode
  try {
    console.log('\n[Test 8] checking Stremio Companion Mode endpoints...');
    const resStream = await axios.get(`http://127.0.0.1:${PORT}/stream?url=aHR0cDovL2ludmFsaWQ=&stremio=true`, {
      maxRedirects: 0,
      validateStatus: () => true,
    });
    console.log('Stream resolve redirect status:', resStream.status);
    console.log('Stream resolve redirect location:', resStream.headers.location);
    assert.strictEqual(resStream.status, 302, 'Should return redirect on failure in companion mode');
    assert.ok(resStream.headers.location.includes('/stream/error.m3u8'), 'Redirect should point to HLS error playlist');

    const resM3u8 = await axios.get(`http://127.0.0.1:${PORT}/stream/error.m3u8?msg=TestError`, {
      validateStatus: () => true,
    });
    console.log('error.m3u8 content type:', resM3u8.headers['content-type']);
    assert.ok(resM3u8.headers['content-type'].includes('mpegurl'), 'm3u8 should have correct content-type');
    assert.ok(resM3u8.data.includes('error_subtitle.vtt?msg=TestError'), 'm3u8 should reference the subtitle endpoint with message');
    assert.ok(resM3u8.data.includes('error_video.m3u8'), 'm3u8 should reference the video media playlist');

    const resVtt = await axios.get(`http://127.0.0.1:${PORT}/stream/error_subtitle.vtt?msg=TestError`, {
      validateStatus: () => true,
    });
    console.log('error_subtitle.vtt headers:', resVtt.headers['content-type'], resVtt.headers['access-control-allow-origin']);
    assert.ok(resVtt.headers['content-type'].includes('vtt'), 'vtt should have correct content-type');
    assert.strictEqual(resVtt.headers['access-control-allow-origin'], '*', 'vtt should support CORS');
    assert.ok(resVtt.data.includes('TestError'), 'vtt file should contain the error message');

    const resTs = await axios.get(`http://127.0.0.1:${PORT}/stream/error_video.ts`, {
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    console.log('error_video.ts length:', resTs.data.length);
    assert.ok(resTs.data.length > 1000, 'TS segment should be non-empty and of reasonable size');

    console.log('✅ Test 8 Passed: Stremio Companion Mode HLS playlist and subtitle endpoints function correctly.');
  } catch (e) {
    console.error('❌ Test 8 Failed:', e.message);
    failed = true;
  }

  console.log('\n=== VERIFICATION SUMMARY ===');
  if (failed) {
    console.log('❌ One or more tests failed!');
    server.close(() => process.exit(1));
  } else {
    console.log('🎉 All tests passed successfully!');
    server.close(() => process.exit(0));
  }
}

server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock server listening on port ${PORT}`);
  runTests();
});
