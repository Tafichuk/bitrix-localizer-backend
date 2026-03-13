#!/usr/bin/env node
/**
 * Local routing analysis for 10 articles.
 * Fast — no Railway, no screenshots. Just nav_map matching.
 */
require('dotenv').config();
const { parseArticle } = require('./src/scraper');
const { findNavMapMatch, navMapStateToPlan } = require('./src/navigation-planner');

const ARTICLES = [
  { id: 1,  label: 'CRM — Сделки',          url: 'https://helpdesk.bitrix24.ru/open/17707848/', section: 'CRM' },
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

function trunc(s, n) {
  n = n || 40;
  if (!s) return '—';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function analyzeArticle(art) {
  let parsed;
  try {
    parsed = await parseArticle(art.url);
  } catch(e) {
    return { art, error: e.message, rows: [] };
  }

  const rows = [];
  for (const img of parsed.screenshots) {
    const nav = findNavMapMatch(img.context, img.alt, art.section);
    if (nav) {
      const plan = navMapStateToPlan(nav);
      rows.push({
        idx:     'img_' + (img.index + 1),
        heading: img.heading || img.context || '—',
        found:   nav.label,
        url:     plan.url || '—',
        score:   nav._score || '?',
        source:  'NavMap',
      });
    } else {
      rows.push({
        idx:     'img_' + (img.index + 1),
        heading: img.heading || img.context || '—',
        found:   '(no match)',
        url:     '—',
        score:   0,
        source:  'Claude',
      });
    }
  }

  return { art, title: parsed.title, imgCount: parsed.screenshots.length, rows };
}

async function main() {
  console.log('\n[nav_map routing analysis — all 10 articles]\n');
  const allResults = [];

  for (const art of ARTICLES) {
    process.stdout.write(`  Fetching #${art.id} ${art.label}...`);
    const r = await analyzeArticle(art);
    allResults.push(r);
    process.stdout.write(r.error ? ` ERROR: ${r.error}\n` : ` ${r.imgCount} imgs\n`);
    await new Promise(res => setTimeout(res, 300));
  }

  // Print tables
  for (const r of allResults) {
    console.log('\n' + '═'.repeat(100));
    console.log(`  #${r.art.id}  ${r.art.label}  —  ${r.art.url}`);
    if (r.error) { console.log('  ERROR:', r.error); continue; }
    console.log(`  Title: ${r.title}   Images: ${r.imgCount}`);
    console.log('═'.repeat(100));

    const C = [8, 36, 36, 30, 8];
    const hdr = ['Скрин', 'Heading/context', 'Найдено (nav_map)', 'URL', 'Source'];
    const sep  = C.map(n => '─'.repeat(n)).join('─┼─');
    const row  = (cols) => cols.map((c, i) => String(c||'').padEnd(C[i]).slice(0, C[i])).join(' │ ');

    console.log('  ' + row(hdr));
    console.log('  ' + sep);
    for (const rr of r.rows) {
      console.log('  ' + row([rr.idx, trunc(rr.heading, 34), trunc(rr.found, 34), trunc(rr.url, 28), rr.source]));
    }
  }

  // Summary stats
  let total = 0, navmap = 0, claude = 0;
  for (const r of allResults) {
    if (r.error) continue;
    for (const rr of r.rows) {
      total++;
      if (rr.source === 'NavMap') navmap++;
      else claude++;
    }
  }
  console.log('\n' + '═'.repeat(100));
  console.log('  ROUTING SUMMARY');
  console.log(`  Total images : ${total}`);
  console.log(`  NavMap hits  : ${navmap} (${Math.round(navmap/total*100)}%)`);
  console.log(`  → Claude     : ${claude} (${Math.round(claude/total*100)}%)`);
  console.log('═'.repeat(100));

  // Machine-readable JSON for E2E script
  const outPath = require('path').join(__dirname, 'test_10articles_routing.json');
  require('fs').writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log('\n  Saved routing data →', outPath);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
