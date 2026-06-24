const { execFile } = require('child_process');
const path = require('path');

async function request(url, headers = {}, followRedirects = true, timeout = 30) {
  const script = path.join(__dirname, 'curl_cffi_proxy.py');
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python',
      [script, url, JSON.stringify(headers), followRedirects ? 'true' : 'false', String(timeout)],
      { timeout: (timeout + 5) * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('Failed to parse curl_cffi response: ' + e.message));
        }
      }
    );
  });
}

module.exports = { request, get: request };
