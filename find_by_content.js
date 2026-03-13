#!/usr/bin/env node
require('dotenv').config();
const { parseArticle } = require('./src/scraper');
const fs = require('fs'), path = require('path');

// Known good articles
const KNOWN = {
  'CRM — Сделки':         '26161116',
  'Drive':                '20811344',
  'Tasks':                '27359038',
  'Calendar':             '25570792',
  'Messenger':            '17373696',
};

// IDs to test for missing sections
const TARGETS = {
  'Tasks — Канбан':       { kws: ['канбан', 'kanban', 'доска задач', 'карточки задач'] },
  'Employees':            { kws: ['структура компании', 'оргструктура', 'отдел', 'сотрудник', 'органиграмма'] },
  'Marketing':            { kws: ['рассылк', 'маркетинг', 'сегмент', 'аудитори', 'email кампани'] },
  'Automation — Роботы':  { kws: ['робот', 'автоматизаци', 'триггер', 'бизнес-процесс'] },
  'Sites — Конструктор':  { kws: ['конструктор сайт', 'лендинг', 'страниц сайт', 'блок сайт'] },
  'CRM — Контакты':       { kws: ['контакт', 'клиент', 'физическое лицо', 'контрагент'] },
};

const IDS = fs.readFileSync(path.join(__dirname, '../data/article_urls.txt'), 'utf8')
  .trim().split('\n').map(s=>s.trim()).filter(Boolean);

// Candidate IDs to test — skip known ones, sample from different ranges
const known = new Set(Object.values(KNOWN));
const candidates = IDS.filter(id => !known.has(id));

async function check(id) {
  const url = `https://helpdesk.bitrix24.ru/open/${id}/`;
  try {
    const p = await parseArticle(url);
    if (p.screenshots.length < 2) return null; // skip near-empty
    const text = p.blocks.map(b => b.text).join(' ').toLowerCase();
    for (const [label, cfg] of Object.entries(TARGETS)) {
      if (cfg.found) continue;
      if (cfg.kws.some(kw => text.includes(kw))) {
        cfg.found = { id, url, title: p.title, imgs: p.screenshots.length };
        return label;
      }
    }
    return null;
  } catch { return null; }
}

async function main() {
  console.log('Scanning for missing sections...\n');
  let checked = 0;
  for (const id of candidates) {
    if (Object.values(TARGETS).every(t => t.found)) break;
    const hit = await check(id);
    checked++;
    if (hit) {
      const t = TARGETS[hit].found;
      console.log(`  ✅ [${hit}] ${t.url} — ${t.title} (${t.imgs} imgs)`);
    }
    if (checked % 30 === 0) {
      const missing = Object.entries(TARGETS).filter(([,v])=>!v.found).map(([k])=>k);
      process.stdout.write(`  [${checked}] missing: ${missing.join(', ')}\n`);
    }
    await new Promise(r=>setTimeout(r, 150));
  }
  console.log('\n=== FINAL ARTICLES LIST ===\n');
  for (const [label, id] of Object.entries(KNOWN)) {
    console.log(`  { id: _, label: '${label}', url: 'https://helpdesk.bitrix24.ru/open/${id}/' },`);
  }
  for (const [label, cfg] of Object.entries(TARGETS)) {
    if (cfg.found) {
      console.log(`  { id: _, label: '${label}', url: '${cfg.found.url}' },  // ${cfg.found.title}`);
    } else {
      console.log(`  // NOT FOUND: ${label}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
