const express = require('express');
const router = express.Router();
const chalk = require('chalk');
const browserModule = require('./browser');
const extractRoute = require('./extract');
const axios = require('axios');

const decodeUrl = (raw) => {
  if (raw && typeof raw === 'string') raw = raw.replace(/ /g, '+');
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch (_) {}
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch (_) {}
  return raw;
};

const encodeUrl = (u) => encodeURIComponent(Buffer.from(u).toString('base64'));

const guessType = (url = '', ct = '') => {
  const u = url.toLowerCase();
  if (ct.includes('mpegurl') || u.includes('.m3u8')) return 'HLS';
  if (ct.includes('dash')    || u.includes('.mpd'))  return 'DASH';
  if (ct.includes('mp4')     || u.includes('.mp4'))  return 'MP4';
  if (ct.includes('webm')    || u.includes('.webm')) return 'WEBM';
  if (ct.includes('mp2t')    || u.includes('.ts'))   return 'MPEG-TS';
  return 'stream';
};

const HOSTER_MATCHERS = [
  { test: u => u.includes('lulustream.com') || u.includes('luluvdo.com') || u.includes('luluvid.com') || u.includes('lulu.'), route: '/lulu' },
  { test: u => /mixdrop\.(ag|co|to|bz)/.test(u), route: '/mixdrop' },
  { test: u => /voe\.(sx|sh)/.test(u), route: '/voe' },
  { test: u => u.includes('doodstream.com') || u.includes('dood') || u.includes('playmogo.com'), route: '/dood' },
  { test: u => u.includes('mega.nz'), route: '/mega' },
  { test: u => u.includes('file-upload.org') || u.includes('fileupload'), route: '/fileupload' },
  { test: u => u.includes('krakenfiles.com'), route: '/kraken' },
  { test: u => u.includes('mp4upload.com'), route: '/mp4upload' },
  { test: u => u.includes('drive.google.com'), route: '/gdrive' },
  { test: u => /vidoza\.net|videzz\.net/i.test(u), route: '/extractor/video?host=Vidoza' },
  { test: u => /streamtape\.com|streamtape\.net/i.test(u), route: '/extractor/video?host=Streamtape' },
  { test: u => /ok\.ru|odnoklassniki/i.test(u), route: '/extractor/video?host=Okru' },
  { test: u => /filelions\.(com|to|site)/i.test(u), route: '/extractor/video?host=FileLions' },
  { test: u => /streamwish\.(com|to|site)/i.test(u), route: '/extractor/video?host=StreamWish' },
  { test: u => /supervideo\.(cc|tv)/i.test(u), route: '/extractor/video?host=Supervideo' },
  { test: u => /uqload\.(com|io|to)/i.test(u), route: '/extractor/video?host=Uqload' },
  { test: u => /turbovidplay\.(com|site)/i.test(u), route: '/extractor/video?host=TurboVidPlay' },
  { test: u => /vidmoly\.(com|me|to)/i.test(u), route: '/extractor/video?host=Vidmoly' },
  { test: u => /fastream\.(com|site)/i.test(u), route: '/extractor/video?host=Fastream' },
  { test: u => /vixcloud\.(co|com)/i.test(u), route: '/extractor/video?host=VixCloud' },
  { test: u => /f16px\.(com|site)/i.test(u), route: '/extractor/video?host=F16Px' },
  { test: u => /gupload\.(com|site)/i.test(u), route: '/extractor/video?host=Gupload' },
  { test: u => /filemoon\.(com|site|sx)/i.test(u), route: '/extractor/video?host=FileMoon' },
  { test: u => /maxstream\.(com|site)/i.test(u), route: '/extractor/video?host=Maxstream' },
  { test: u => /livetv\.(com|site)/i.test(u), route: '/extractor/video?host=LiveTV' },
  { test: u => /sportsonline|sports?online/i.test(u), route: '/extractor/video?host=Sportsonline' },
  { test: u => /vidfast\.(com|site)/i.test(u), route: '/extractor/video?host=VidFast' },
  { test: u => /streamhg\.(com|site)/i.test(u), route: '/extractor/video?host=StreamHG' },
  { test: u => /vavoo\.(to|tv)/i.test(u), route: '/extractor/video?host=Vavoo' },
];

const resolveViaHoster = async (route, targetUrl, host) => {
  try {
    const res = await axios.get(`${host}${route}?url=${encodeUrl(targetUrl)}&format=json`);
    return res.data;
  } catch (err) {
    return null;
  }
};

const ERROR_TS_B64 = 
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQAAQAACwDQABwQAAAAHwACqxBLL////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W//////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQQAAMAdQAAB7DH4AAAAB4AAAgIAFIQAH2GEAAAABCfAAAAABZ0LACtoFBn58BEAAAAMAQAAAAwKDxImoAAAAAWj' +
  'OMsgAAAEGBf//d9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01Q' +
  'RUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFHAQARbi5vcmcve' +
  'DI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG' +
  '1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21' +
  'hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLEcBABIxMSBmYXN0X3Bza2lwPTEgY2hy' +
  'b21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTYgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5y' +
  'PTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZy' +
  'YW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ95SBrZXlpbnRfRwEAE21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJl' +
  'c2g9MCByY19sb29rYWhlYWQ9NSByYz1hYnIgbWJ0cmVlPTEgYml0cmF0ZT0xMCByYXRldG9sPTEuMCBxY29tcD0w' +
  'LjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAWWIhHyYoAAi' +
  'SycnJycnJycnJycnJycnJycnJydddddHAQA0FAD/////////////////////////XXXXXXXXXXXXXXXXXXXXXXXX' +
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' +
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' +
  'gEdAABEAALANAAHBAAAAAfAAKrEEsv////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HUAARAACwEgABwQAA4QDwABvhAPAAFb1NVv//////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQQA1mRAAAJ40fgD////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////wAAAeAAAICABSEACWUBAAAAAQnwAAAA' +
  'AUGaIfAeMEdAABIAALANAAHBAAAAAfAAKrEEsv////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HUAASAACwEgABwQAA4QDwABvhAPAAFb1NVv//////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQQA2mRAAAMFcfgD////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////wAAAeAAAICABSEACfGhAAAAAQnwAAAA' +
  'AUGaQLwHjEdAEREAQvAlAAHBAAD/Af8AAfyAFEgSAQZGRm1wZWcJU2VydmljZTAxd3xDyv//////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQAAEwAAsA0AAcEAAAAB8AAqsQSy////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HUAATAAKwEgABwQAA4QDwABvhAPAAFb1NVv//////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQQA3mRAAAA5IR+AP////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////AAAB4AAAgIAFIQALfkEAAAABCfAAAAAB' +
  'QZpg/AeMR0AAFAAAsA0AAcEAAAAB8AAqsQSy////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HUAAUAAKwEgABwQAA4QDwABvhAPAAFb1NVv//////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQQA4mRAAABB6x+AP////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////AAAB4AAAgIAFIQANCuEAAAABCfAAAAAB' +
  'QZqATwHjR0AAFQAAsA0AAcEAAAAB8AAqsQSy////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HUAAVAAKwEgABwQAA4QDwABvhAPAAFb1NVv//////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HQQA5HUAABKtR+AAAAAeAAAICABSEADZeBAAAAAQnwAAAAAWdCwAraBQZ+fARAAAADAEAAAAMCg8SJqAAAAAFoz' +
  'jLIAAABZYiCBfJigACO/JycnJycnJycnJycnJycnJycnJ11111111111111111111111111111111111111111111' +
  '111111111111111111111111111111111111111111111111111111111111111111111RwEAOmoA////////////' +
  '////////////////////////////////////////////////////////////////////////////////' +
  '1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111' +
  '11111111111111115HQBESAELwJQABwQAA/wH/AAH8gBRIEgEGRkZtcGVnCVNlcnZpY2UwMXd8Q8r/////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  '//9HAQAWAAAQDwAB8AAqsQSy////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  'R1AAFgACsBIAAcEAAOEA8AAb4QDwABW9TVb/////////////////////////////////////////////////////////' +
  '///////////////////////////////////////////////////////////////////////////////////////////' +
  'f0dBADuZEAABTfx+AP//////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////8AAAeAAAICABSEADyQhAAAAAQnwAAAAAUGa' +
  'I8B4wEdAABcAALANAAHBAAAAAfAAKrEEsv//////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  'R1AAFwACsBIAAcEAAOEA8AAb4QDwABW9TVb/////////////////////////////////////////////////////////' +
  '///////////////////////////////////////////////////////////////////////////////////////////' +
  'f0dBADyZEAABcSkfgD//////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////8AAAeAAAICABSEAD7DBAAAAAQnwAAAAAUGa' +
  'QXAeMEdAABgAALANAAHBAAAAAfAAKrEEsv//////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////' +
  'R1AAGAACsBIAAcEAAOEA8AAb4QDwABW9TVb/////////////////////////////////////////////////////////' +
  '///////////////////////////////////////////////////////////////////////////////////////////' +
  'f0dBAD1mRAAAZRMfgD//////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////8AAAeAAAICABSEAET1hAAAAAQnwAAAAAUGa' +
  'YLwHjEdAERMAQvAlAAHBAAD/Af8AAfyAFEgSAQZGRm1wZWcJU2VydmljZTAxd3xDyv//////////////////////////' +
  '//////////////////////////////////////////////////////////////////////////////////9HQAAZ' +
  'AAsA0AAcEAAAAB8AAqsQSy//////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////////////////////////////////9H' +
  'UAAZAAKwEgABwQAA4QDwABvhAPAAFb1NVv//////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////////////////////////////////////' +
  '9HQQA+mRAAB3d0fgD//////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////AAAB4AAAgIAFIQARygEAAAABCfAAAAABQZ' +
  'qA/AeM=';

router.get('/', async (req, res) => {
  const rawUrl = req.query.url;
  const wantJson = req.query.format === 'json';
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const targetUrl = decodeUrl(rawUrl);
  const host = `${req.protocol}://${req.get('host')}`;

  console.log(chalk.magenta('[STREAM ENDPOINT] Resolve request for:'), targetUrl.slice(0, 100));

  const isCompanionMode = req.query.stremio === 'true' || req.query.video_error === 'true';
  const companionParams = [];
  if (req.query.stremio === 'true') companionParams.push('stremio=true');
  if (req.query.video_error === 'true') companionParams.push('video_error=true');
  const companionSuffix = companionParams.length > 0 ? '&' + companionParams.join('&') : '';

  // 1. Direct stream check
  const lowerUrl = targetUrl.toLowerCase();
  const isDirect = lowerUrl.includes('.m3u8') || lowerUrl.includes('.mp4') || lowerUrl.includes('.mpd') || lowerUrl.includes('.webm');
  if (isDirect) {
    console.log(chalk.gray('  ↳ direct format matched, verifying...'));
    const verify = await browserModule.verifyUrl(targetUrl);
    if (verify.ok) {
      const type = guessType(targetUrl, verify.contentType);
      const proxyUrl = (type === 'HLS' 
        ? `${host}/hls?url=${encodeUrl(targetUrl)}`
        : `${host}/proxy?url=${encodeUrl(targetUrl)}`) + companionSuffix;
      console.log(chalk.green('  ↳ direct URL verified playable!'));
      
      if (wantJson) return res.json({ url: proxyUrl, type, source: 'direct-check', confidence: 'verified' });
      return res.redirect(proxyUrl);
    }
  }

  // 2. Known hoster check
  const matchedHoster = HOSTER_MATCHERS.find(h => h.test(lowerUrl));
  if (matchedHoster) {
    console.log(chalk.gray(`  ↳ known hoster matched → ${matchedHoster.route}`));
    const resolved = await resolveViaHoster(matchedHoster.route, targetUrl, host);
    if (resolved && (resolved.url || resolved.proxyUrl)) {
      let finalUrl = resolved.proxyUrl || resolved.url;
      if (companionSuffix && finalUrl.includes('/proxy') && !finalUrl.includes('stremio=')) {
        finalUrl += companionSuffix;
      }
      console.log(chalk.green('  ↳ hoster resolved:'), finalUrl.slice(0, 80));
      
      if (wantJson) return res.json({ url: finalUrl, type: resolved.type || 'stream', source: 'hoster', confidence: 'verified' });
      return res.redirect(finalUrl);
    }
  }

  // 3. Fast Cheerio-based extraction check
  console.log(chalk.gray('  ↳ fast Cheerio extraction...'));
  try {
    const candidates = await extractRoute.extractFromPage(targetUrl);
    const seen = new Set();
    const unique = candidates.filter(c => {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });
    unique.sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return (rank[a.confidence] || 2) - (rank[b.confidence] || 2);
    });

    for (const c of unique.slice(0, 5)) {
      console.log(chalk.gray(`  ↳ verifying: ${c.url.slice(0, 80)}`));
      const verify = await browserModule.verifyUrl(c.url, targetUrl);
      if (verify.ok) {
        const type = guessType(c.url, verify.contentType);
        console.log(chalk.green('  ↳ fast extraction found playable!'), type);

        const extraHeaders = { Referer: targetUrl };
        const b64 = Buffer.from(JSON.stringify(extraHeaders)).toString('base64');
        const proxyUrl = (type === 'HLS'
          ? `${host}/hls?url=${encodeUrl(c.url)}&headers=${b64}`
          : `${host}/proxy?url=${encodeUrl(c.url)}&headers=${b64}`) + companionSuffix;

        if (wantJson) return res.json({ url: proxyUrl, type, source: 'fast-extractor', confidence: 'verified' });
        return res.redirect(proxyUrl);
      }
    }
  } catch (err) {
    console.error(chalk.red('  ↳ fast extraction error:'), err.message);
  }

  // 4. Slow-path Heuristic Deep Scanner fallback
  console.log(chalk.magenta('  ↳ launching Heuristic Deep Scanner...'));
  try {
    const scan = await browserModule.deepScanPage(targetUrl, 25000);
    if (scan && scan.url) {
      const type = scan.type || guessType(scan.url, scan.contentType);
      console.log(chalk.green('  ↳ deep scanner resolved!'), type, scan.url.slice(0, 80));

      const extraHeaders = { Referer: scan.referer || targetUrl };
      if (scan.cookieStr) extraHeaders['Cookie'] = scan.cookieStr;
      const b64 = Buffer.from(JSON.stringify(extraHeaders)).toString('base64');
      const proxyUrl = (type === 'HLS'
        ? `${host}/hls?url=${encodeUrl(scan.url)}&headers=${b64}`
        : `${host}/proxy?url=${encodeUrl(scan.url)}&headers=${b64}`) + companionSuffix;

      if (wantJson) return res.json({ url: proxyUrl, type, source: 'deep-scanner', confidence: 'verified' });
      return res.redirect(proxyUrl);
    }
  } catch (err) {
    console.error(chalk.red('  ↳ deep scanner error:'), err.message);
  }

  console.log(chalk.red('  ↳ FAILED to resolve any playable stream'));
  if (isCompanionMode) {
    const msg = encodeURIComponent('Failed to extract any playable video streams.');
    return res.redirect(`${host}/stream/error.m3u8?msg=${msg}`);
  }
  res.status(502).json({ error: 'Failed to extract any playable video streams.', url: targetUrl });
});

router.get('/error.m3u8', (req, res) => {
  const msg = req.query.msg || 'Unknown error';
  const encodedMsg = encodeURIComponent(msg);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=YES,LANGUAGE="en",URI="error_subtitle.vtt?msg=${encodedMsg}"
#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"
error_video.m3u8`);
});

router.get('/error_video.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
error_video.ts
#EXT-X-ENDLIST`);
});

router.get('/error_video.ts', (req, res) => {
  const buf = Buffer.from(ERROR_TS_B64, 'base64');
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

router.get('/error_subtitle.vtt', (req, res) => {
  const msg = req.query.msg || 'Unknown error';
  res.setHeader('Content-Type', 'text/vtt');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(`WEBVTT

00:00:00.000 --> 00:00:10.000
${msg}`);
});

module.exports = router;
