#!/usr/bin/env node
/**
 * Poll-based pipeline: submit job, poll /api/download until ready (no SSE).
 */
require('dotenv').config();
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const BASE = 'https://bitrix-localizer-backend-production-1dd4.up.railway.app';
const LANGS = ['en'];
const OUT   = path.join(__dirname, 'test_10articles_out');

const ARTICLES = [
  { id: 7,  label: 'Employees — Структура', url: 'https://helpdesk.bitrix24.ru/open/23039004/', section: 'Сотрудники' },
  { id: 8,  label: 'Marketing — Рассылки',  url: 'https://helpdesk.bitrix24.ru/open/12302778/', section: 'Маркетинг' },
  { id: 9,  label: 'Automation — Роботы',   url: 'https://helpdesk.bitrix24.ru/open/6908975/',  section: 'CRM' },
  { id: 10, label: 'Sites — Конструктор',   url: 'https://helpdesk.bitrix24.ru/open/19564392/', section: 'Сайты' },
];

function mod() { return BASE.startsWith('https') ? https : http; }

async function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(BASE + urlPath);
    const req  = mod().request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// Poll /api/download until 200, max 25 min
async function pollDownload(jobId, outFile) {
  const url = new URL(`${BASE}/api/download/${jobId}`);
  for (let attempt = 1; attempt <= 50; attempt++) {
    await new Promise(r => setTimeout(r, 30_000)); // 30s between polls
    const bytes = await new Promise((resolve) => {
      const req = mod().get({ hostname: url.hostname, port: 443, path: url.pathname }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            const buf = Buffer.concat(chunks);
            fs.writeFileSync(outFile, buf);
            resolve(buf.length);
          } else {
            process.stdout.write(`    poll ${attempt}: HTTP ${res.statusCode}\n`);
            resolve(0);
          }
        });
      });
      req.on('error', () => resolve(0));
    });
    if (bytes > 0) return bytes;
  }
  throw new Error('Poll timeout after 25 min');
}

function extractImages(zipFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  try { execSync(`unzip -o "${zipFile}" -d "${outDir}" 2>/dev/null`); } catch {}
  const imgs = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(png|jpg)$/i.test(f)) imgs.push(full);
    }
  }
  walk(outDir);
  return imgs.sort();
}

async function testArticle(art) {
  console.log('\n' + '═'.repeat(80));
  console.log(`  #${art.id}  ${art.label}`);
  console.log(`  ${art.url}`);
  console.log('═'.repeat(80));

  console.log('  Submitting to Railway...');
  const res = await apiPost('/api/localize', { articleUrl: art.url, languages: LANGS });
  if (res.error) { console.error('  API error:', res.error); return { art, pipelineError: res.error }; }
  console.log('  Job:', res.jobId);
  console.log('  Polling for ZIP (30s intervals)...');

  const zipFile = path.join(OUT, `art${art.id}.zip`);
  const imgDir  = path.join(OUT, `art${art.id}_imgs`);
  fs.mkdirSync(OUT, { recursive: true });

  let zipBytes;
  try {
    zipBytes = await pollDownload(res.jobId, zipFile);
    console.log(`  ZIP: ${(zipBytes/1024).toFixed(0)} KB`);
  } catch(e) { console.error('  Poll error:', e.message); return { art, pipelineError: e.message }; }

  const images = extractImages(zipFile, imgDir);
  console.log(`  Screenshots: ${images.length}`);
  for (const img of images) console.log('    ' + path.relative(OUT, img));

  return { art, jobId: res.jobId, zipFile, imgDir, images };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('\n[poll-based: art7-10]');
  for (const art of ARTICLES) {
    await testArticle(art);
    console.log('  --- 10s pause ---');
    await new Promise(r => setTimeout(r, 10_000));
  }
  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
