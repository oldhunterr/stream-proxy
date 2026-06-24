const browser = require('../routes/browser');
const curlCffi = require('./curl_cffi');

const registry = [];

function register(extractor) {
  registry.push(extractor);
}

function find(url) {
  for (const ext of registry) {
    try {
      if (ext.test(url)) return ext;
    } catch (_) {}
  }
  return null;
}

async function extract(url, options = {}) {
  const ext = find(url);
  if (!ext) return { ok: false, error: 'No extractor matched' };
  return extractWithExt(ext, url, options);
}

async function extractByName(name, url, options = {}) {
  const ext = registry.find(e => e.name === name);
  if (!ext) return { ok: false, error: `Unknown extractor: ${name}` };
  return extractWithExt(ext, url, options);
}

async function extractWithExt(ext, url, options = {}) {
  const { useCurlCffi = false, useBrowser = false, browserTimeout = 15000, quality } = options;

  // 1. Try specific extractor logic
  try {
    const result = await ext.extract(url, { quality });
    if (result && result.url) {
      const response = { ok: true, url: result.url, headers: result.headers || {}, source: ext.name };
      if (result.all_qualities) response.all_qualities = result.all_qualities;
      return response;
    }
    if (result && result.url) return { ok: true, url: result.url, headers: result.headers || {}, source: ext.name };
  } catch (_) {}

  // 2. Try curl_cffi (handles CF JS challenge) — optional
  if (useCurlCffi) {
    try {
      const resp = await curlCffi.get(url, { Referer: new URL(url).origin + '/' }, true, 20);
      if (resp && resp.status === 200 && resp.text) {
        const result = await ext.extract(resp.text);
        if (result && result.url) return { ok: true, url: result.url, headers: result.headers || {}, source: `${ext.name}/curl_cffi` };
      }
    } catch (_) {}
  }

  // 3. Fallback to Puppeteer deep scan — optional
  if (useBrowser) {
    try {
      const scan = await browser.deepScanPage(url, browserTimeout);
      if (scan && scan.url) return { ok: true, url: scan.url, headers: { Referer: scan.referer || url, Cookie: scan.cookieStr || '' }, source: `${ext.name}/browser` };
    } catch (_) {}
  }

  return { ok: false, error: `All extraction methods failed for ${ext.name}` };
}

module.exports = { register, find, extract, extractByName, registry };
