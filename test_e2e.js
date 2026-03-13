#!/usr/bin/env node
/**
 * End-to-end localization test.
 * Calls the Railway backend, streams progress via SSE, downloads ZIP, extracts screenshots.
 * Usage: node test_e2e.js [--local]
 */
require('dotenv').config();
const http  = require('https');
const https = require('https');
const http2 = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const BASE = process.argv.includes('--local')
  ? 'http://localhost:3000'
  : 'https://bitrix-localizer-backend-production-1dd4.up.railway.app';

const LANGUAGES = ['en'];   // one language to keep it fast
const OUT_DIR   = path.join(__dirname, 'test_e2e_out');

const ARTICLES = [
  { id: 1, label: 'Drive',         url: 'https://helpdesk.bitrix24.ru/open/20811344/' },
  { id: 2, label: 'CRM Deals',     url: 'https://helpdesk.bitrix24.ru/open/18198814/' },
  { id: 3, label: 'Tasks/CardDAV', url: 'https://helpdesk.bitrix24.ru/open/6800919/'  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

async function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const mod  = BASE.startsWith('https') ? https : http2;
    const url  = new URL(BASE + path);
    const req  = mod.request({
      hostname: url.hostname,
      port:     url.port || (BASE.startsWith('https') ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function streamJob(jobId) {
  return new Promise((resolve, reject) => {
    const mod = BASE.startsWith('https') ? https : http2;
    const url = new URL(`${BASE}/api/stream/${jobId}`);
    const req = mod.get({
      hostname: url.hostname,
      port:     url.port || (BASE.startsWith('https') ? 443 : 80),
      path:     url.pathname,
      headers:  { Accept: 'text/event-stream' },
      timeout:  300_000,
    }, res => {
      const rows = [];   // table rows collected from events
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
              if (d.message) process.stdout.write(`  ${d.message}\n`);

              // Capture screenshot routing info from progress messages
              if (d.step === 'screenshot' && d.source && d.imgAlt !== undefined) {
                rows.push({
                  idx:     d.imgIdx,
                  context: d.heading || d.context || '—',
                  url:     d.url || '—',
                  source:  d.source,
                });
              }

              if (eventType === 'complete' || d.step === 'done') {
                done = true;
              }
              if (eventType === 'error') {
                reject(new Error(d.message || 'Pipeline error'));
              }
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
    const mod = BASE.startsWith('https') ? https : http2;
    const url = new URL(`${BASE}/api/download/${jobId}`);
    const req = mod.get({
      hostname: url.hostname,
      port:     url.port || (BASE.startsWith('https') ? 443 : 80),
      path:     url.pathname,
    }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(outFile, buf);
        resolve(buf.length);
      });
    });
    req.on('error', reject);
  });
}

function extractZipImages(zipFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  try {
    execSync(`cd "${outDir}" && unzip -o "${zipFile}" "*.png" "*.jpg" "*.jpeg" -d . 2>/dev/null || true`);
    execSync(`find "${outDir}" -name "*.png" -o -name "*.jpg" | head -20`);
  } catch {}
  // List all images extracted
  const images = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(png|jpg|jpeg)$/i.test(f)) images.push(full);
    }
  }
  walk(outDir);
  return images;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function testArticle(art) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  #${art.id}  ${art.label}  —  ${art.url}`);
  console.log('═'.repeat(80));

  // Start job
  let jobId;
  try {
    const res = await apiPost('/api/localize', { articleUrl: art.url, languages: LANGUAGES });
    if (res.error) { console.error(`  ❌ API error: ${res.error}`); return null; }
    jobId = res.jobId;
    console.log(`  🆔 Job: ${jobId}`);
  } catch (e) {
    console.error(`  ❌ Start failed: ${e.message}`);
    return null;
  }

  // Stream progress
  console.log('  📡 Streaming...');
  try {
    await streamJob(jobId);
  } catch (e) {
    console.error(`  ⚠️  Stream error: ${e.message}`);
  }

  // Download ZIP
  const zipFile = path.join(OUT_DIR, `article_${art.id}.zip`);
  const imgDir  = path.join(OUT_DIR, `article_${art.id}_imgs`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let zipBytes = 0;
  try {
    zipBytes = await downloadZip(jobId, zipFile);
    console.log(`  📦 ZIP: ${(zipBytes / 1024).toFixed(0)} KB → ${zipFile}`);
  } catch (e) {
    console.error(`  ⚠️  Download failed: ${e.message}`);
    return { label: art.label, url: art.url, images: [] };
  }

  // Extract screenshots
  const images = extractZipImages(zipFile, imgDir);
  console.log(`  🖼️  Screenshots extracted: ${images.length}`);
  for (const img of images) {
    const rel = path.relative(OUT_DIR, img);
    console.log(`     ${rel}`);
  }

  return { label: art.label, url: art.url, jobId, zipFile, images };
}

async function main() {
  console.log(`\n🚀 E2E test against: ${BASE}`);
  console.log(`📁 Output: ${OUT_DIR}\n`);

  const results = [];
  for (const art of ARTICLES) {
    const r = await testArticle(art);
    if (r) results.push(r);
    // Brief pause between articles
    await new Promise(res => setTimeout(res, 2000));
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  ИТОГ');
  console.log('═'.repeat(80));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(15)}: ${r.images.length} screenshots → ${r.zipFile || '—'}`);
  }
  console.log(`\n  📁 All files: ${OUT_DIR}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
