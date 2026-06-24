require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const chalk = require('chalk');
const path = require('path');

process.on('unhandledRejection', (reason, promise) => {
  if (reason && reason.message && reason.message.includes('Target closed')) {
    return;
  }
  if (reason && reason.message && reason.message.includes('Protocol error')) {
    return;
  }
  console.error(chalk.red('[UNHANDLED REJECTION]'), reason);
});

const corsMiddleware = require('./middleware/cors');
const cacheMiddleware = require('./middleware/cache');

const proxyRoute   = require('./routes/proxy');
const hlsRoute     = require('./routes/hls');
const extractRoute = require('./routes/extract');
const inspectRoute = require('./routes/inspect');
const dashRoute    = require('./routes/dash');
const statusRoute  = require('./routes/status');
const doodRoute    = require('./routes/dood');
const browserRoute = require('./routes/browser');
const mixdropRoute = require('./routes/mixdrop');
const voeRoute     = require('./routes/voe');
const gdriveRoute  = require('./routes/gdrive');
const fileupRoute  = require('./routes/fileupload');
const luluRoute    = require('./routes/lulu');
const megaRoute    = require('./routes/mega');
const krakenRoute  = require('./routes/kraken');
const mp4uploadRoute = require('./routes/mp4upload');
const streamRoute  = require('./routes/stream');
const extractorRoute = require('./routes/extractor');
const generateRoute  = require('./routes/generate');

require('./utils/register_extractors');

// ── Global unhandled rejection handler ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('[UNHANDLED REJECTION]'), reason);
});

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Logging ──────────────────────────────────────────────────────────────────
app.use(morgan((tokens, req, res) => {
  const status = tokens.status(req, res);
  const color  = status >= 500 ? chalk.red
               : status >= 400 ? chalk.yellow
               : status >= 300 ? chalk.cyan
               : chalk.green;
  return [
    chalk.gray(tokens.date(req, res, 'iso')),
    color(status),
    chalk.bold(tokens.method(req, res)),
    chalk.white(tokens.url(req, res)),
    chalk.gray(tokens['response-time'](req, res) + ' ms'),
    chalk.gray(tokens.res(req, res, 'content-length') || '–' + ' bytes'),
  ].join(' ');
}));

// ── Body parsing ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── Global CORS ───────────────────────────────────────────────────────────────
app.use(corsMiddleware);

// ── Static dashboard ─────────────────────────────────────────────────────────
app.use('/ui', express.static(path.join(__dirname, 'public')));
app.get('/ui', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Redirect Fallback Middleware ─────────────────────────────────────────────
// If a client requests a specialized extractor route (like /lulu) directly without
// expecting JSON, automatically redirect them to the resolved stream URL.
const redirectFallback = (req, res, next) => {
  const originalJson = res.json;
  res.json = function(obj) {
    const wantJson = req.query.format === 'json' || 
                     req.xhr || 
                     (req.headers.accept && req.headers.accept.includes('application/json'));
    
    if (obj && obj.url && !wantJson) {
      return res.redirect(obj.url);
    }
    return originalJson.call(this, obj);
  };
  next();
};

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/proxy',   cacheMiddleware, proxyRoute);
app.use('/hls',     hlsRoute);
app.use('/extract', extractRoute);
app.use('/inspect', inspectRoute);
app.use('/dash',    dashRoute);
app.use('/status',  statusRoute);
app.use('/dood',    redirectFallback, doodRoute);
app.use('/browser', browserRoute);
app.use('/mixdrop', redirectFallback, mixdropRoute);
app.use('/voe',     redirectFallback, voeRoute);
app.use('/gdrive',  redirectFallback, gdriveRoute);
app.use('/fileupload', redirectFallback, fileupRoute);
app.use('/lulu',    redirectFallback, luluRoute);
app.use('/mega',    redirectFallback, megaRoute);
app.use('/kraken',  redirectFallback, krakenRoute);
app.use('/mp4upload', redirectFallback, mp4uploadRoute);
app.use('/extractor', extractorRoute);
app.use('/generate',  generateRoute);
app.use('/stream',    streamRoute);

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/ui'));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(chalk.red('[ERROR]'), err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(chalk.bold.green(`\n🎬  Video Stream Proxy`));
  console.log(chalk.cyan(`   Dashboard  → http://localhost:${PORT}/ui`));
  console.log(chalk.cyan(`   Proxy      → http://localhost:${PORT}/proxy?url=<enc>`));
  console.log(chalk.cyan(`   HLS        → http://localhost:${PORT}/hls?url=<enc>`));
  console.log(chalk.cyan(`   Extract    → http://localhost:${PORT}/extract?url=<enc>`));
  console.log(chalk.cyan(`   Inspect    → http://localhost:${PORT}/inspect?url=<enc>`));
  console.log(chalk.cyan(`   DASH       → http://localhost:${PORT}/dash?url=<enc>`));
  console.log(chalk.cyan(`   DoodStream → http://localhost:${PORT}/dood?url=<enc>`));
  console.log(chalk.cyan(`   Mixdrop    → http://localhost:${PORT}/mixdrop?url=<enc>`));
  console.log(chalk.cyan(`   Voe        → http://localhost:${PORT}/voe?url=<enc>`));
  console.log(chalk.cyan(`   GDrive     → http://localhost:${PORT}/gdrive?url=<enc>`));
  console.log(chalk.cyan(`   FileUpload → http://localhost:${PORT}/fileupload?url=<enc>`));
  console.log(chalk.cyan(`   Lulu       → http://localhost:${PORT}/lulu?url=<enc>`));
  console.log(chalk.cyan(`   Mega       → http://localhost:${PORT}/mega?url=<enc>`));
  console.log(chalk.cyan(`   Browser    → http://localhost:${PORT}/browser?url=<enc>`));
  console.log(chalk.gray(`\n   Listening on port ${PORT} …\n`));
});

module.exports = app;
