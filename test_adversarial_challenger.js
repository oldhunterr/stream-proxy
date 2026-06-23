const express = require('express');
const axios = require('axios');
const zlib = require('zlib');
const assert = require('assert');
const browserModule = require('./routes/browser');

const app = express();
const PORT = 55668;

// Mock endpoints

// 1. Malformed gzip stream
app.get('/malformed-gzip', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Encoding', 'gzip');
  // Send corrupted/invalid gzip data
  res.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x55, 0x66, 0x77]));
  res.end();
});

// 2. Slow response stream (emits 1 byte of binary 0x00 every 2 seconds, never finishes)
app.get('/slow-stream', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  let interval = setInterval(() => {
    if (!res.destroyed) {
      res.write(Buffer.from([0x00])); // binary 0x00
    } else {
      clearInterval(interval);
    }
  }, 2000);
  req.on('close', () => {
    clearInterval(interval);
  });
});

// 3. Huge stream (sends 10MB of data in 64KB chunks of 0x00)
let hugeStreamBytesSent = 0;
app.get('/huge-stream', (req, res) => {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Range', 'bytes 0-10485759/10485760');
  res.setHeader('Content-Length', '10485760');
  
  const chunkSize = 64 * 1024; // 64KB chunks
  const chunk = Buffer.alloc(chunkSize, 0x00); // Binary 0x00
  let sent = 0;
  
  const sendChunk = () => {
    if (res.destroyed) {
      hugeStreamBytesSent = sent;
      return;
    }
    res.write(chunk, (err) => {
      if (err) {
        hugeStreamBytesSent = sent;
        return;
      }
      sent += chunkSize;
      hugeStreamBytesSent = sent;
      if (sent < 10 * 1024 * 1024) {
        // Yield to event loop to allow socket closure to be detected
        process.nextTick(sendChunk);
      } else {
        res.end();
      }
    });
  };
  sendChunk();
});

// 4. UTF-16LE WebVTT with leading whitespace
app.get('/utf16le-whitespace-vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  const vttStr = '   \t  WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello';
  const vttBuf = Buffer.from(vttStr, 'utf16le');
  const bomBuf = Buffer.from([0xFF, 0xFE]);
  res.send(Buffer.concat([bomBuf, vttBuf]));
});

// 5. UTF-16BE WebVTT with leading whitespace
app.get('/utf16be-whitespace-vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  const vttStr = '   \t  WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello';
  const vttBuf = Buffer.from(vttStr, 'utf16le');
  // Swap bytes for BE
  for (let i = 0; i < vttBuf.length - 1; i += 2) {
    const tmp = vttBuf[i];
    vttBuf[i] = vttBuf[i+1];
    vttBuf[i+1] = tmp;
  }
  const bomBuf = Buffer.from([0xFE, 0xFF]);
  res.send(Buffer.concat([bomBuf, vttBuf]));
});

// 6. UTF-8 WebVTT with BOM and leading whitespace
app.get('/utf8-bom-whitespace-vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  const vttStr = '   \t  WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello';
  const vttBuf = Buffer.from(vttStr, 'utf8');
  const bomBuf = Buffer.from([0xEF, 0xBB, 0xBF]);
  res.send(Buffer.concat([bomBuf, vttBuf]));
});

// 7. Subtitle with no extension returning text/plain with WEBVTT signature
app.get('/sub/en-vtt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello');
});

// 8. Subtitle with no extension returning text/plain containing SRT style cues
app.get('/sub/en-srt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('1\n00:00:01,000 --> 00:00:04,000\nHello');
});

let server;

async function runTests() {
  console.log('=== STARTING EMPIRICAL CHALLENGER TESTS ===\n');
  let failed = false;

  // Test 1: Malformed Gzip stream (check for unhandled crash/rejection)
  try {
    console.log('[Challenger Test 1] Malformed Gzip stream...');
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/malformed-gzip`);
    console.log('Result:', result);
    // It should fail gracefully (either Empty response body or decompression error)
    assert.strictEqual(result.ok, false);
    console.log('✅ Test 1 Passed: Malformed Gzip handled cleanly.');
  } catch (e) {
    console.error('❌ Test 1 Failed:', e.message);
    failed = true;
  }

  // Test 2: Slow response stream (chunk timeout)
  try {
    console.log('\n[Challenger Test 2] Slow stream chunk read timeout...');
    const startTime = Date.now();
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/slow-stream`);
    const duration = Date.now() - startTime;
    console.log(`Result:`, result, `(Duration: ${duration}ms)`);
    // Should take around 5000ms (chunk timeout) plus some connection setup time
    assert.ok(duration >= 4500 && duration <= 9000, `Duration should be around 5s-7s, was ${duration}ms`);
    // The result should have ok: true because it has binary 0x00 and Content-Type video/mp4
    assert.strictEqual(result.ok, true);
    console.log('✅ Test 2 Passed: Slow stream timed out chunk reading and returned ok: true.');
  } catch (e) {
    console.error('❌ Test 2 Failed:', e.message);
    failed = true;
  }

  // Test 3: Huge stream (verify it does not download the whole file)
  try {
    console.log('\n[Challenger Test 3] Huge stream request...');
    hugeStreamBytesSent = 0;
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/huge-stream`);
    console.log('Result:', result);
    console.log('Bytes sent by mock server:', hugeStreamBytesSent);
    assert.strictEqual(result.ok, true);
    // Since limit is 8192, the client should have destroyed the stream after reading the first chunk.
    // The mock server might send 64KB or a bit more due to buffering, but it should be far less than 10MB.
    assert.ok(hugeStreamBytesSent < 512 * 1024, `Huge stream was not cut off! Sent: ${hugeStreamBytesSent} bytes`);
    console.log('✅ Test 3 Passed: Huge stream truncated correctly.');
  } catch (e) {
    console.error('❌ Test 3 Failed:', e.message);
    failed = true;
  }

  // Test 4: UTF-16LE WebVTT with leading whitespace
  try {
    console.log('\n[Challenger Test 4] UTF-16LE WebVTT with leading whitespace...');
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/utf16le-whitespace-vtt`);
    console.log('Result:', result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Forbidden content: WebVTT signature detected');
    console.log('✅ Test 4 Passed.');
  } catch (e) {
    console.error('❌ Test 4 Failed:', e.message);
    failed = true;
  }

  // Test 5: UTF-16BE WebVTT with leading whitespace
  try {
    console.log('\n[Challenger Test 5] UTF-16BE WebVTT with leading whitespace...');
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/utf16be-whitespace-vtt`);
    console.log('Result:', result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Forbidden content: WebVTT signature detected');
    console.log('✅ Test 5 Passed.');
  } catch (e) {
    console.error('❌ Test 5 Failed:', e.message);
    failed = true;
  }

  // Test 6: UTF-8 WebVTT with BOM and leading whitespace
  try {
    console.log('\n[Challenger Test 6] UTF-8 WebVTT with BOM and leading whitespace...');
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/utf8-bom-whitespace-vtt`);
    console.log('Result:', result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Forbidden content: WebVTT signature detected');
    console.log('✅ Test 6 Passed.');
  } catch (e) {
    console.error('❌ Test 6 Failed:', e.message);
    failed = true;
  }

  // Test 7: Subtitle with no extension returning text/plain with WEBVTT signature
  try {
    console.log('\n[Challenger Test 7] Subtitle with no extension and text/plain (VTT)...');
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/sub/en-vtt`);
    console.log('Result:', result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Forbidden content: WebVTT signature detected');
    console.log('✅ Test 7 Passed.');
  } catch (e) {
    console.error('❌ Test 7 Failed:', e.message);
    failed = true;
  }

  // Test 8: Subtitle with no extension returning text/plain containing SRT style cues
  try {
    console.log('\n[Challenger Test 8] Subtitle with no extension and text/plain (SRT)...');
    const result = await browserModule.verifyUrl(`http://127.0.0.1:${PORT}/sub/en-srt`);
    console.log('Result:', result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Forbidden content: Plain text or script detected for binary media');
    console.log('✅ Test 8 Passed.');
  } catch (e) {
    console.error('❌ Test 8 Failed:', e.message);
    failed = true;
  }

  console.log('\n=== CHALLENGER VERIFICATION SUMMARY ===');
  if (failed) {
    console.log('❌ One or more challenger tests failed!');
    server.close(() => process.exit(1));
  } else {
    console.log('🎉 All challenger tests passed successfully!');
    server.close(() => process.exit(0));
  }
}

server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Challenger mock server listening on port ${PORT}`);
  runTests();
});
