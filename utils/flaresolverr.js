const axios = require('axios');

const FLARESOLVER_URL = 'http://192.168.100.150:8191/v1';

async function request(url, options = {}) {
  const { maxTimeout = 30000, headers = {} } = options;
  try {
    const resp = await axios.post(FLARESOLVER_URL, {
      cmd: 'request.get',
      url,
      maxTimeout,
      headers,
    }, { timeout: maxTimeout + 15000 });

    const data = resp.data;
    if (data.status !== 'ok') {
      throw new Error('FlareSolverr: ' + (data.message || 'unknown error'));
    }

    const solution = data.solution || {};
    return {
      status: solution.status,
      text: solution.response || '',
      headers: solution.headers || {},
      cookies: solution.cookies || [],
      finalUrl: solution.url || url,
    };
  } catch (err) {
    if (err.response) throw new Error('FlareSolverr HTTP ' + err.response.status);
    throw err;
  }
}

module.exports = { request };
