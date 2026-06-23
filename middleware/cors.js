/**
 * Global CORS middleware — allows any origin, any header, GET + OPTIONS.
 * This is intentional for a local testing/research proxy.
 */
module.exports = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Expose-Headers', '*');

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
};
