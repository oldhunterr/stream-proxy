const express = require('express');
const { File } = require('megajs');
const router  = express.Router();

/**
 * GET /mega?url=<base64>
 *
 * Mega.nz files are end-to-end encrypted. The decryption key is in the URL fragment (#...).
 * This route uses megajs to:
 *   1. Parse the Mega URL and extract file metadata (name, size)
 *   2. Return metadata + a streaming proxy endpoint
 *
 * GET /mega/stream?url=<base64>
 *   Streams the decrypted Mega file through the proxy in real-time.
 */
router.get('/', async (req, res) => {
  const b64 = req.query.url;
  if (!b64) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    let url = Buffer.from(b64, 'base64').toString('utf-8');
    
    // Clean up embed URLs for megajs parser
    if (url.endsWith('/html')) url = url.slice(0, -5);
    url = url.replace('/embed/', '/file/');
    
    console.log(`[Mega] Resolving: ${url}`);

    const file = File.fromURL(url);
    await file.loadAttributes();

    const name = file.name;
    const size = file.size;
    console.log(`[Mega] File: ${name}, Size: ${size} bytes`);

    // The "playable URL" for Mega is our own streaming endpoint
    const streamUrl = `/mega/stream?url=${b64}`;

    res.json({
      url: streamUrl,
      fileName: name,
      fileSize: size,
      type: name.match(/\.mp4$/i) ? 'video/mp4' :
            name.match(/\.mkv$/i) ? 'video/x-matroska' :
            name.match(/\.avi$/i) ? 'video/x-msvideo' :
            name.match(/\.webm$/i) ? 'video/webm' : 'application/octet-stream',
    });

  } catch (err) {
    console.error('[Mega] Error:', err.message);
    res.status(500).json({ error: 'Failed to resolve Mega file: ' + err.message });
  }
});

/**
 * Streaming endpoint: decrypts and pipes the Mega file directly to the client.
 * Supports HTTP Range requests for video seeking.
 */
router.get('/stream', async (req, res) => {
  const b64 = req.query.url;
  if (!b64) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    let url = Buffer.from(b64, 'base64').toString('utf-8');
    if (url.endsWith('/html')) url = url.slice(0, -5);
    url = url.replace('/embed/', '/file/');
    console.log(`[Mega] Streaming: ${url}`);

    const file = File.fromURL(url);
    await file.loadAttributes();

    const totalSize = file.size;
    const contentType = file.name.match(/\.mp4$/i) ? 'video/mp4' :
                        file.name.match(/\.mkv$/i) ? 'video/x-matroska' :
                        file.name.match(/\.webm$/i) ? 'video/webm' : 'application/octet-stream';

    // Handle Range requests for seeking
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      console.log(`[Mega] Range: ${start}-${end}/${totalSize}`);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${file.name}"`,
      });

      const stream = file.download({ start, end: end + 1 });
      pipeDecryptedStream(stream, res, chunkSize);

      req.on('close', () => {
        stream.destroy();
      });
    } else {
      // Full download
      console.log(`[Mega] Full download: ${totalSize} bytes`);

      res.writeHead(200, {
        'Content-Length': totalSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${file.name}"`,
      });

      const stream = file.download();
      pipeDecryptedStream(stream, res, totalSize);

      req.on('close', () => {
        stream.destroy();
      });
    }

  } catch (err) {
    console.error('[Mega] Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream Mega file: ' + err.message });
    }
  }
});

/**
 * Pipes a decrypted stream from megajs to the Express response object,
 * strictly limiting the written bytes to the requested size and closing
 * the stream and response cleanly once that limit is reached.
 */
function pipeDecryptedStream(stream, res, limitSize) {
  let bytesWritten = 0;
  let active = true;

  const onData = (chunk) => {
    if (!active) return;
    if (bytesWritten >= limitSize) {
      cleanup();
      return;
    }

    let chunkToWrite = chunk;
    if (bytesWritten + chunk.length > limitSize) {
      chunkToWrite = chunk.slice(0, limitSize - bytesWritten);
    }

    res.write(chunkToWrite);
    bytesWritten += chunkToWrite.length;

    if (bytesWritten >= limitSize) {
      cleanup();
    }
  };

  const onEnd = () => {
    cleanup();
  };

  const onError = (err) => {
    console.error('[Mega] Stream helper error:', err.message);
    cleanup();
    if (!res.headersSent) {
      res.status(500).end();
    }
  };

  const cleanup = () => {
    if (!active) return;
    active = false;
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
    stream.removeListener('error', onError);
    try {
      stream.destroy();
    } catch (_) {}
    res.end();
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);
}

module.exports = router;
