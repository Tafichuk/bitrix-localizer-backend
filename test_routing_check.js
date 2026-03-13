#!/usr/bin/env node
require('dotenv').config();
const { parseArticle } = require('./src/scraper');
const { findNavMapMatch, navMapStateToPlan } = require('./src/navigation-planner');

function trunc(s, n) {
  n = n || 40;
  if (!s) return '—';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

const ARTICLES = [
  { url: 'https://helpdesk.bitrix24.ru/open/20811344/', label: 'Drive',   section: 'Диск' },
  { url: 'https://helpdesk.bitrix24.ru/open/6800919/',  label: 'CardDAV', section: 'Настройки' },
];

async function check(art) {
  console.log('\n' + '='.repeat(90));
  console.log('  ' + art.label + ' — ' + art.url);
  console.log('='.repeat(90));

  const p = await parseArticle(art.url);
  console.log('  Title  :', p.title);
  console.log('  Section:', art.section);
  console.log('  Images :', p.screenshots.length);
  console.log();

  const C = [8, 28, 30, 34, 8];
  const hdr = ['Скрин', 'Heading', 'Найдено', 'URL', 'Source'];
  const sep  = C.map(n => '-'.repeat(n)).join('-+-');
  const row  = (cols) => cols.map((c, i) => String(c || '').padEnd(C[i]).slice(0, C[i])).join(' | ');

  console.log(row(hdr));
  console.log(sep);

  for (const img of p.screenshots) {
    const idx = 'img_' + (img.index + 1);
    const nav = findNavMapMatch(img.context, img.alt, art.section);
    if (nav) {
      const plan = navMapStateToPlan(nav);
      console.log(row([idx, trunc(img.heading, 26), trunc(nav.label, 28), trunc(plan.url, 32), 'NavMap']));
    } else {
      console.log(row([idx, trunc(img.heading, 26), '(no match)', '—', 'Claude']));
    }
  }
}

async function main() {
  for (const art of ARTICLES) {
    await check(art);
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
