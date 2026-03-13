#!/usr/bin/env node
/**
 * Retry script: art1, art3, art7-10
 * Fix: SSE resolves immediately when done=true (no empty-line wait)
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
  { id: 1,  label: 'CRM — Сделки',         url: 'https://helpdesk.bitrix24.ru/open/17707848/', section: 'CRM' },
  { id: 3,  label: 'Tasks — Создание',      url: 'https://helpdesk.bitrix24.ru/open/27047638/', section: 'Задачи и проекты' },
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

// FIXED: resolve immediately when done=true, don't wait for empty line
function streamJob(jobId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/api/stream/${jobId}`);
    const req = mod().get({
      hostname: url.hostname, port: 443, path: url.pathname,
      headers: { Accept: 'text/event-stream' }, timeout: 600_000,
    }, res => {
      let eventType = '', done = false, resolveTimer = null;
      res.on('data', chunk => {
        for (const line of chunk.toString().split('\n')) {
          if (line.startsWith('event:')) { eventType = line.slice(6).trim(); }
          else if (line.startsWith('data:')) {
            try {
              const d = JSON.parse(line.slice(5).trim());
              if (d.message) process.stdout.write('    ' + d.message + '\n');
              if ((eventType === 'complete' || d.step === 'done') && !done) {
                done = true;
                // Resolve after 3s to let Railway finalize the ZIP
                resolveTimer = setTimeout(() => { res.destroy(); resolve(); }, 3000);
              }
              if (eventType === 'error') { clearTimeout(resolveTimer); reject(new Error(d.message)); }
            } catch {}
          }
        }
      });
      res.on('end', () => { if (!done) resolve(); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SSE timeout')); });
  });
}

async function downloadZip(jobId, outFile) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/api/download/${jobId}`);
    const req = mod().get({ hostname: url.hostname, port: 443, path: url.pathname }, res => {
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

  console.log('  Starting Railway pipeline...');
  const res = await apiPost('/api/localize', { articleUrl: art.url, languages: LANGS });
  if (res.error) { console.error('  API error:', res.error); return { art, pipelineError: res.error }; }
  console.log('  Job:', res.jobId);

  try { await streamJob(res.jobId); } catch(e) { console.error('  Stream error:', e.message); }

  // Extra 5s delay after stream ends to let Railway finalize ZIP
  console.log('  Waiting 5s for ZIP...');
  await new Promise(r => setTimeout(r, 5000));

  const zipFile = path.join(OUT, `art${art.id}.zip`);
  const imgDir  = path.join(OUT, `art${art.id}_imgs`);
  fs.mkdirSync(OUT, { recursive: true });

  let zipBytes = 0;
  try {
    zipBytes = await downloadZip(res.jobId, zipFile);
    console.log(`  ZIP: ${(zipBytes/1024).toFixed(0)} KB`);
  } catch(e) { console.error('  Download error:', e.message); return { art, pipelineError: e.message }; }

  const images = extractImages(zipFile, imgDir);
  console.log(`  Screenshots: ${images.length}`);
  for (const img of images) console.log('    ' + path.relative(OUT, img));

  return { art, jobId: res.jobId, zipFile, imgDir, images };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('\n[retry: art1, art3, art7-10]');
  console.log('Output:', OUT);

  for (const art of ARTICLES) {
    await testArticle(art);
    console.log('  --- 5s pause ---');
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
