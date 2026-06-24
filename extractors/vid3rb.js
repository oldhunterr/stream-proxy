const { makeRequest, ExtractorError } = require('../utils/extractor_base');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function htmldecode(text) {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c));
}

function extractPlayerUrl(text) {
  const decoded = htmldecode(text);
  const m = decoded.match(/video_url"\s*:\s*"https:\\\/\\\/video\.vid3rb\.com\\\/player\\\/([a-f0-9-]+)\?token=([a-f0-9]+)&expires=(\d+)/);
  if (m) return `https://video.vid3rb.com/player/${m[1]}?token=${m[2]}&expires=${m[3]}`;
  return null;
}

function extractVideoSources(html, quality) {
  const idx = html.indexOf('var video_sources = [{"src"');
  if (idx === -1) return null;
  const start = idx + 'var video_sources = '.length;
  let depth = 0, end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  try {
    const sources = JSON.parse(html.substring(start, end).replace(/\\\//g, '/'));
    let available = sources.filter(s => s.src && !s.premium);
    if (available.length === 0) return null;

    // Sort by resolution descending
    available.sort((a, b) => parseInt(b.res || '0') - parseInt(a.res || '0'));

    // If quality='all', return all sources
    if (quality === 'all') {
      return available.map(s => ({
        url: s.src.replace(/\\\//g, '/'),
        label: s.label || s.res || 'Unknown',
        res: s.res || '0',
      }));
    }

    // If quality specified, try to find a match (exact or closest)
    if (quality) {
      const qNum = parseInt(quality);
      if (!isNaN(qNum)) {
        let match = available.find(s => parseInt(s.res) === qNum);
        if (!match) {
          match = available.find(s => parseInt(s.res) <= qNum) || available[available.length - 1];
        }
        if (match) return match.src.replace(/\\\//g, '/');
      }
    }

    // Default: pick highest
    return available[0].src.replace(/\\\//g, '/');
  } catch (_) { return null; }
}

function extractDownloadButton(text) {
  // Look for the download/play button: <a class="btn btn-light ..." href="...">
  // Try various patterns
  const patterns = [
    /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*btn[^"']*btn-light[^"']*["'][^>]*>/i,
    /<a[^>]+class=["'][^"']*btn[^"']*btn-light[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /<a[^>]+download[^>]+href=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let href = m[1];
      if (href.startsWith('/')) href = 'https://anime3rb.com' + href;
      if (href.startsWith('http')) return href;
    }
  }
  return null;
}

async function resolveRedirect(videoUrl, referer) {
  try {
    const resp = await axios.get(videoUrl, {
      headers: { 'User-Agent': UA, 'Referer': referer, 'Range': 'bytes=0-0' },
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: () => true,
    });
    const finalUrl = resp.request?.res?.responseUrl || videoUrl;
    // Use the final URL if it redirected to a different domain or is a direct file
    if (finalUrl !== videoUrl && (finalUrl.includes('files.vid3rb.com') || !finalUrl.includes('/video/'))) {
      return finalUrl;
    }
  } catch (_) {}
  return videoUrl;
}

module.exports = {
  name: 'Vid3rb',
  test: (url) => /vid3rb\.com|anime3rb/i.test(url),
  extract: async (url, options = {}) => {
    let pageUrl, referer = 'https://vid3rb.com/';
    const isEpisode = /anime3rb\.com\/episode\//i.test(url);
    const isDownload = /anime3rb\.com\/download/i.test(url);
    const isPlayer = /vid3rb\.com\/player/i.test(url);

    // --- EPISODE URLs: Extract player URL from Livewire JSON ---
    if (isEpisode) {
      const { text } = await makeRequest(url, {
        headers: { 'Accept': 'text/html,*/*', 'Referer': 'https://anime3rb.com/' },
      });
      const playerUrl = extractPlayerUrl(text);
      if (!playerUrl) throw new ExtractorError('Vid3rb: player URL not found in episode page');
      pageUrl = playerUrl;
      referer = 'https://anime3rb.com/';

    // --- DOWNLOAD URLs: Try Livewire JSON first, then download button ---
    } else if (isDownload) {
      const { text } = await makeRequest(url, {
        headers: { 'Accept': 'text/html,*/*', 'Referer': 'https://anime3rb.com/' },
      });
      // First try: extract player URL from Livewire JSON (same as episode)
      const playerUrl = extractPlayerUrl(text);
      if (playerUrl) {
        pageUrl = playerUrl;
        referer = 'https://anime3rb.com/';
      } else {
        // Second try: find download button and use its href directly
        const btnHref = extractDownloadButton(text);
        if (btnHref) {
          // Resolve redirect on the download link to get the actual file
          const directUrl = await resolveRedirect(btnHref, url);
          return { url: directUrl, headers: { Referer: 'https://anime3rb.com/' } };
        }
        throw new ExtractorError('Vid3rb: no player URL or download button found');
      }

    // --- PLAYER URLs: Directly extract video_sources ---
    } else if (isPlayer) {
      pageUrl = url;
    } else {
      throw new ExtractorError('Vid3rb: unsupported URL format');
    }

    // --- Fetch player page and extract video sources ---
    const playerResp = await makeRequest(pageUrl, {
      headers: { 'Accept': 'text/html,*/*', 'Referer': referer },
    });

    const optsQuality = options && options.quality;
    const sources = extractVideoSources(playerResp.text, optsQuality);
    if (!sources) throw new ExtractorError('Vid3rb: video_sources not found in player page');

    // If quality='all', resolve redirects for each and return all
    if (optsQuality === 'all' && Array.isArray(sources)) {
      const allQualities = await Promise.all(sources.map(async s => {
        const finalUrl = s.url.includes('/video/') ? await resolveRedirect(s.url, referer) : s.url;
        return { url: finalUrl, label: s.label, res: s.res };
      }));
      return {
        url: allQualities[0].url,
        headers: { Referer: referer },
        all_qualities: allQualities,
      };
    }

    // Single quality: resolve redirect if needed
    const finalUrl = sources.includes('/video/') ? await resolveRedirect(sources, referer) : sources;
    return { url: finalUrl, headers: { Referer: referer } };
  },
};
