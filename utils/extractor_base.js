const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

class ExtractorError extends Error {
  constructor(message, code = 'EXTRACTION_FAILED') {
    super(message);
    this.name = 'ExtractorError';
    this.code = code;
  }
}

const jar = new CookieJar();
const axiosCj = wrapper(axios.create({ jar, withCredentials: true }));

async function makeRequest(url, options = {}) {
  const {
    headers = {},
    timeout = 15000,
    retries = 3,
    responseType = 'text',
    followRedirects = true,
  } = options;

  const reqHeaders = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...headers,
  };

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const origin = new URL(url).origin;
      if (!reqHeaders.Referer) reqHeaders.Referer = origin + '/';
    } catch (_) {}

    try {
      const resp = await axiosCj.get(url, {
        headers: reqHeaders,
        timeout,
        responseType,
        validateStatus: () => true,
        maxRedirects: followRedirects ? 5 : 0,
      });

      if (resp.status >= 400 && attempt < retries - 1) {
        lastErr = new ExtractorError(`HTTP ${resp.status}`, 'HTTP_ERROR');
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }

      return {
        status: resp.status,
        text: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
        headers: resp.headers,
        finalUrl: resp.request?.res?.responseUrl || url,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastErr || new ExtractorError('Request failed after retries');
}

async function getCookieString(url) {
  try {
    const cookies = await jar.getCookies(url);
    return cookies.map(c => `${c.key}=${c.value}`).join('; ');
  } catch (_) {
    return '';
  }
}

module.exports = { makeRequest, getCookieString, ExtractorError, UA };
