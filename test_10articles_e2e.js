#!/usr/bin/env node
/**
 * Full E2E test: 10 articles × Railway pipeline.
 * Writes results progressively to test_10articles_results.json.
 */
require('dotenv').config();
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');
const { parseArticle } = require('./src/scraper');
const { findNavMapMatch, navMapStateToPlan } = require('./src/navigation-planner');

const BASE = 'https://bitrix-localizer-backend-production-1dd4.up.railway.app';
const LANGS = ['en'];
const OUT   = path.join(__dirname, 'test_10articles_out');

const ARTICLES = [
  { id: 1,  label: 'CRM — Сделки',         url: 'https://helpdesk.bitrix24.ru/open/17707848/', section: 'CRM' },
  { id: 2,  label: 'CRM — Контакты',        url: 'https://helpdesk.bitrix24.ru/open/24856238/', section: 'CRM' },
  { id: 3,  label: 'Tasks — Создание',      url: 'https://helpdesk.bitrix24.ru/open/27047638/', section: 'Задачи и проекты' },
  { id: 4,  label: 'Tasks — Канбан',        url: 'https://helpdesk.bitrix24.ru/open/21839648/', section: 'Задачи и проекты' },
  { id: 5,  label: 'Calendar — События',    url: 'https://helpdesk.bitrix24.ru/open/25570792/', section: 'Календарь' },
  { id: 6,  label: 'Messenger — Чаты',      url: 'https://helpdesk.bitrix24.ru/open/25548220/', section: 'Мессенджер' },
  { id: 7,  label: 'Employees — Структура', url: 'https://helpdesk.bitrix24.ru/open/23039004/', section: 'Сотрудники' },
  { id: 8,  label: 'Marketing — Рассылки',  url: 'https://helpdesk.bitrix24.ru/open/12302778/', section: 'Маркетинг' },
  { id: 9,  label: 'Automation — Роботы',   url: 'https://helpdesk.bitrix24.ru/open/6908975/',  section: 'CRM' },
  { id: 10, label: 'Sites — Конструктор',   url: 'https://helpdesk.bitrix24.ru/open/19564392/', section: 'Сайты' },
];

const RESULTS_FILE = path.join(__dirname, 'test_10articles_results.json');
const allResults = [];

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
}

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

function streamJob(jobId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/api/stream/${jobId}`);
    const req = mod().get({
      hostname: url.hostname, port: 443, path: url.pathname,
      headers: { Accept: 'text/event-stream' }, timeout: 600_000,
    }, res => {
      let eventType = '', done = false;
      res.on('data', chunk => {
        for (const line of chunk.toString().split('\n')) {
          if (line.startsWith('event:')) { eventType = line.slice(6).trim(); }
          else if (line.startsWith('data:')) {
            try {
              const d = JSON.parse(line.slice(5).trim());
              if (d.message) process.stdout.write('    ' + d.message + '\n');
              if (eventType === 'complete' || d.step === 'done') done = true;
              if (eventType === 'error') reject(new Error(d.message));
            } catch {}
          } else if (line === '' && done) { resolve(); res.destroy(); }
        }
      });
      res.on('end', resolve); res.on('error', reject);
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
  try { execSync(`cd "${outDir}" && unzip -o "${zipFile}" "*.png" "*.jpg" -d . 2>/dev/null || true`); } catch {}
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

// Build routing table from scraper + nav_map (local, fast)
async function buildRoutingTable(art) {
  try {
    const p = await parseArticle(art.url);
    const rows = [];
    for (const img of p.screenshots) {
      const nav = findNavMapMatch(img.context, img.alt, art.section);
      rows.push({
        idx:     'img_' + (img.index + 1),
        heading: (img.heading || img.context || '').slice(0, 50),
        found:   nav ? nav.label : '(no match)',
        url:     nav ? (navMapStateToPlan(nav).url || '—') : '—',
        source:  nav ? 'NavMap' : 'Claude',
        score:   nav ? (nav._score || '?') : 0,
      });
    }
    return { title: p.title, imgCount: p.screenshots.length, rows };
  } catch(e) {
    return { error: e.message, rows: [] };
  }
}

async function testArticle(art) {
  console.log('\n' + '═'.repeat(80));
  console.log(`  #${art.id}  ${art.label}`);
  console.log(`  ${art.url}`);
  console.log('═'.repeat(80));

  // 1. Local routing
  process.stdout.write('  Building routing table...');
  const routing = await buildRoutingTable(art);
  if (routing.error) {
    console.log(' ERROR:', routing.error);
    return { art, error: routing.error };
  }
  console.log(` ${routing.imgCount} imgs`);

  // Print routing table
  const C = [8, 32, 32, 28, 7];
  const hdr = ['Скрин', 'Heading', 'nav_map match', 'URL', 'Source'];
  const sep  = C.map(n => '─'.repeat(n)).join('─┼─');
  const row  = cols => cols.map((c, i) => String(c||'').padEnd(C[i]).slice(0, C[i])).join(' │ ');
  console.log('\n  ' + row(hdr));
  console.log('  ' + sep);
  for (const r of routing.rows) {
    const h = r.heading.replace(/\s+/g,' ').slice(0,30);
    const f = r.found.slice(0,30);
    const u = r.url.slice(0,26);
    console.log('  ' + row([r.idx, h, f, u, r.source]));
  }

  // 2. Railway pipeline
  console.log('\n  Starting Railway pipeline...');
  const res = await apiPost('/api/localize', { articleUrl: art.url, languages: LANGS });
  if (res.error) { console.error('  API error:', res.error); return { art, routing, pipelineError: res.error }; }
  console.log('  Job:', res.jobId);

  try { await streamJob(res.jobId); } catch(e) { console.error('  Stream error:', e.message); }

  // 3. Download + extract
  const zipFile = path.join(OUT, `art${art.id}.zip`);
  const imgDir  = path.join(OUT, `art${art.id}_imgs`);
  fs.mkdirSync(OUT, { recursive: true });

  let zipBytes = 0;
  try {
    zipBytes = await downloadZip(res.jobId, zipFile);
    console.log(`\n  ZIP: ${(zipBytes/1024).toFixed(0)} KB`);
  } catch(e) { console.error('  Download error:', e.message); return { art, routing, pipelineError: e.message }; }

  const images = extractImages(zipFile, imgDir);
  console.log(`  Screenshots: ${images.length}`);
  for (const img of images) console.log('    ' + path.relative(OUT, img));

  const result = { art, routing, jobId: res.jobId, zipFile, imgDir, images };
  allResults.push(result);
  saveResults();
  return result;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('\n🚀 E2E test: 10 articles against Railway');
  console.log('📁 Output:', OUT);

  const results = [];
  for (const art of ARTICLES) {
    const r = await testArticle(art);
    results.push(r);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  ИТОГ');
  console.log('═'.repeat(80));
  for (const r of results) {
    const nm = (r.routing?.rows||[]).filter(x=>x.source==='NavMap').length;
    const cl = (r.routing?.rows||[]).filter(x=>x.source==='Claude').length;
    const total = (r.routing?.rows||[]).length;
    console.log(`  #${r.art.id} ${r.art.label.padEnd(25)}: ${r.images?.length||0} screenshots, routing NavMap=${nm}/${total}`);
  }

  console.log('\n✅ Done. Results:', RESULTS_FILE);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
