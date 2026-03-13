#!/usr/bin/env node
/**
 * E2E test: Drive (20811344) + CardDAV (6800919)
 * Checks ФИКС 1+2+3 in production Railway deployment.
 */
require('dotenv').config();
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const BASE    = process.argv.includes('--local')
  ? 'http://localhost:3000'
  : 'https://bitrix-localizer-backend-production-1dd4.up.railway.app';

const LANGUAGES = ['en'];
const OUT_DIR   = path.join(__dirname, 'test_e2e_out');

const ARTICLES = [
  { id: 1, label: 'Drive',   url: 'https://helpdesk.bitrix24.ru/open/20811344/' },
  { id: 2, label: 'CardDAV', url: 'https://helpdesk.bitrix24.ru/open/6800919/'  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function mod() { return BASE.startsWith('https') ? https : http; }

async function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(BASE + urlPath);
    const req  = mod().request({
      hostname: url.hostname,
      port:     url.port || (BASE.startsWith('https') ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function streamJob(jobId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/api/stream/${jobId}`);
    const req = mod().get({
      hostname: url.hostname,
      port:     url.port || (BASE.startsWith('https') ? 443 : 80),
      path:     url.pathname,
      headers:  { Accept: 'text/event-stream' },
      timeout:  600_000,
    }, res => {
      const rows = [];
      let eventType = '';
      let done = false;

      res.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            try {
              const d = JSON.parse(line.slice(5).trim());
              if (d.message) process.stdout.write('  ' + d.message + '\n');

              if (d.step === 'screenshot' && d.source) {
                rows.push({
                  idx:     d.imgIdx,
                  heading: d.heading || '—',
                  found:   d.label   || '—',
                  url:     d.url     || '—',
                  source:  d.source,
                });
              }

              if (eventType === 'complete' || d.step === 'done') done = true;
              if (eventType === 'error') reject(new Error(d.message || 'Pipeline error'));
            } catch {}
          } else if (line === '' && done) {
            resolve(rows);
            res.destroy();
          }
        }
      });
      res.on('end', () => resolve(rows));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SSE timeout')); });
  });
}

async function downloadZip(jobId, outFile) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/api/download/${jobId}`);
    const req = mod().get({
      hostname: url.hostname,
      port:     url.port || (BASE.startsWith('https') ? 443 : 80),
      path:     url.pathname,
    }, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); fs.writeFileSync(outFile, buf); resolve(buf.length); });
    });
    req.on('error', reject);
  });
}

function extractImages(zipFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  try { execSync(`cd "${outDir}" && unzip -o "${zipFile}" "*.png" "*.jpg" "*.jpeg" -d . 2>/dev/null || true`); } catch {}
  const imgs = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(png|jpg|jpeg)$/i.test(f)) imgs.push(full);
    }
  }
  walk(outDir);
  return imgs.sort();
}

// ── routing table ─────────────────────────────────────────────────────────────

function printTable(rows) {
  if (!rows.length) { console.log('  (no routing events captured)'); return; }
  const C = [8, 32, 32, 34, 10];
  const hdr = ['Скрин', 'Heading', 'Найдено', 'URL', 'Источник'];
  const sep  = C.map(n => '-'.repeat(n)).join('-+-');
  const row  = (cols) => cols.map((c, i) => String(c || '').padEnd(C[i]).slice(0, C[i])).join(' | ');
  console.log('\n  ' + row(hdr));
  console.log('  ' + sep);
  for (const r of rows) {
    const src  = String(r.url  || '').slice(0, 32);
    const found = String(r.found || '').slice(0, 30);
    const hdg   = String(r.heading || '—').slice(0, 30);
    console.log('  ' + row(['img_' + r.idx, hdg, found, src, r.source]));
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function testArticle(art) {
  console.log('\n' + '═'.repeat(90));
  console.log(`  #${art.id}  ${art.label}  —  ${art.url}`);
  console.log('═'.repeat(90));

  const res = await apiPost('/api/localize', { articleUrl: art.url, languages: LANGUAGES });
  if (res.error) { console.error('  ERROR:', res.error); return null; }
  console.log('  Job:', res.jobId);

  console.log('  Streaming progress...\n');
  let rows = [];
  try { rows = await streamJob(res.jobId); } catch(e) { console.error('  Stream error:', e.message); }

  printTable(rows);

  const zipFile = path.join(OUT_DIR, `article_${art.id}_${art.label.toLowerCase()}.zip`);
  const imgDir  = path.join(OUT_DIR, `article_${art.id}_${art.label.toLowerCase()}_imgs`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let zipBytes = 0;
  try {
    zipBytes = await downloadZip(res.jobId, zipFile);
    console.log(`\n  ZIP: ${(zipBytes / 1024).toFixed(0)} KB -> ${path.basename(zipFile)}`);
  } catch (e) { console.error('  Download failed:', e.message); return { label: art.label, rows, images: [] }; }

  const images = extractImages(zipFile, imgDir);
  console.log(`  Screenshots extracted: ${images.length}`);
  for (const img of images) console.log('    ' + path.relative(OUT_DIR, img));

  return { label: art.label, url: art.url, jobId: res.jobId, zipFile, imgDir, images, rows };
}

async function main() {
  console.log('\nE2E test against:', BASE);
  console.log('Output:', OUT_DIR);

  const results = [];
  for (const art of ARTICLES) {
    const r = await testArticle(art);
    if (r) results.push(r);
    if (art !== ARTICLES[ARTICLES.length - 1]) await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n' + '═'.repeat(90));
  console.log('  ИТОГ');
  console.log('═'.repeat(90));
  for (const r of results) {
    const navmap = r.rows.filter(x => x.source === 'NavMap').length;
    const claude = r.rows.filter(x => x.source === 'Claude').length;
    console.log(`  ${r.label.padEnd(10)}: ${r.images.length} screenshots, routing: NavMap=${navmap} Claude=${claude}`);
    console.log('  Images:', r.imgDir);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
