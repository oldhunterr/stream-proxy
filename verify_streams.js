const axios = require('axios');

const BASE = 'http://localhost:3000';

const tests = [
  {
    name: 'Mixdrop',
    route: '/mixdrop',
    url: 'https://mixdrop.ag/e/z1z6416lid0pmd',
  },
  {
    name: 'Voe',
    route: '/voe',
    url: 'https://voe.sx/e/pnu1isicny5i',
  },
  {
    name: 'Google Drive',
    route: '/gdrive',
    url: 'https://drive.google.com/file/d/13-XgHcgb7DdS9lQBWPsu_Aw8hGuTe4_h/view',
  },
  {
    name: 'File-Upload',
    route: '/fileupload',
    url: 'https://file-upload.org/embed-tdmrphj1s75r.html',
  },
  {
    name: 'Lulustream',
    route: '/lulu',
    url: 'https://lulustream.com/e/pseuye8mdiw4',
  },
  {
    name: 'Mega.nz',
    route: '/mega',
    url: 'https://mega.nz/file/hqJGFIjC#UJmIpM71edJKQWCdiw8iLb3JPNSBU1LuzpUmhV150Rc',
  },
];

async function verifyStream(url, name) {
  let targetUrl = url;
  if (url.startsWith('/')) {
    targetUrl = BASE + url;
    console.log(`  [VERIFY] ${name}: Local proxy endpoint → ${targetUrl}`);
  }
  
  try {
    const r = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Range': 'bytes=0-8191',
      },
      timeout: 15000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    console.log(`  [VERIFY] ${name}: ${r.status} ${r.headers['content-type']} ${r.headers['content-length'] || '?'} bytes`);
    return r.status === 200 || r.status === 206;
  } catch(e) {
    console.log(`  [VERIFY] ${name}: FAILED - ${e.message}`);
    return false;
  }
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║         STREAM PROXY VERIFICATION REPORT              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  const results = [];
  
  for (const test of tests) {
    console.log(`\n━━━ ${test.name} ━━━`);
    const enc = Buffer.from(test.url).toString('base64');
    
    try {
      console.log(`  [EXTRACT] ${test.route}?url=<base64>`);
      const res = await axios.get(`${BASE}${test.route}?url=${enc}`, {
        timeout: 30000,
        validateStatus: () => true,
      });
      
      if (res.status !== 200 || res.data.error) {
        console.log(`  [EXTRACT] FAILED: ${res.status} ${JSON.stringify(res.data)}`);
        results.push({ name: test.name, status: '❌ EXTRACT FAILED', url: '', error: res.data.error || res.status });
        continue;
      }
      
      const extractedUrl = res.data.url;
      console.log(`  [EXTRACT] OK → ${(extractedUrl || '').substring(0, 80)}`);
      
      if (res.data.fileName) console.log(`  [META] File: ${res.data.fileName}`);
      if (res.data.fileSize) console.log(`  [META] Size: ${(res.data.fileSize / 1048576).toFixed(1)} MB`);
      if (res.data.contentType) console.log(`  [META] Type: ${res.data.contentType}`);
      
      // Verify the extracted URL
      const verified = await verifyStream(extractedUrl, test.name);
      
      results.push({
        name: test.name,
        status: verified ? '✅ WORKING' : '⚠️ EXTRACTED (unverified)',
        url: extractedUrl,
      });
      
    } catch(e) {
      console.log(`  [ERROR] ${e.message}`);
      results.push({ name: test.name, status: '❌ ERROR', error: e.message });
    }
  }
  
  // Summary table
  console.log('\n\n╔════════════════════════════════════════════════════════╗');
  console.log('║                   FINAL RESULTS                       ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  for (const r of results) {
    const padded = (r.name + '           ').substring(0, 14);
    console.log(`║ ${padded} ${r.status.padEnd(38)} ║`);
  }
  console.log('╚════════════════════════════════════════════════════════╝');
}

run().catch(console.error);
