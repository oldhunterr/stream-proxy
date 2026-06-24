const crypto = require('crypto');

function generateToken(url, secret, expiration, ip) {
  const data = JSON.stringify({ url, exp: expiration, ip: ip || null });
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  const payload = Buffer.from(data).toString('base64');
  return `${payload}.${hmac}`;
}

function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    const expected = crypto.createHmac('sha256', secret).update(Buffer.from(parts[0], 'base64')).digest('hex');
    if (expected !== parts[1]) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function buildSignedUrl(baseUrl, destination, options = {}) {
  const { secret, expiration, ip, headers } = options;
  const params = new URLSearchParams();
  params.set('d', Buffer.from(destination).toString('base64'));
  if (headers) params.set('headers', Buffer.from(JSON.stringify(headers)).toString('base64'));
  if (secret) {
    const token = generateToken(destination, secret, expiration, ip);
    params.set('token', token);
  }
  if (expiration) params.set('exp', expiration);
  return `${baseUrl}?${params.toString()}`;
}

module.exports = { generateToken, verifyToken, buildSignedUrl };
