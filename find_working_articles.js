#!/usr/bin/env node
/**
 * Finds working articles from article_urls.txt for each target section.
 * Checks breadcrumbs to identify section.
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const IDS = fs.readFileSync(
  path.join(__dirname, '../data/article_urls.txt'), 'utf8'
).trim().split('\n').map(s => s.trim()).filter(Boolean);

const TARGETS = {
  'CRM': ['crm', 'сделк', 'контакт', 'лид', 'счёт', 'воронк'],
  'Tasks': ['задач', 'task', 'канбан', 'проект', 'спринт', 'дедлайн'],
  'Calendar': ['календар', 'событ', 'расписани'],
  'Messenger': ['мессенджер', 'чат', 'канал', 'звонк', 'видеозвон'],
  'Employees': ['сотрудник', 'структур', 'отдел', 'оргструктур', 'компани'],
  'Marketing': ['маркетинг', 'рассылк', 'сегмент', 'аудитори'],
  'Automation': ['робот', 'автоматизаци', 'триггер', 'бизнес-процесс'],
  'Sites': ['сайт', 'конструктор', 'лендинг', 'форм'],
};

const found = {};
for (const k of Object.keys(TARGETS)) found[k] = null;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

async function checkArticle(id) {
  try {
    const url = `https://helpdesk.bitrix24.ru/open/${id}/`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 10000, maxRedirects: 3 });
    const $ = cheerio.load(res.data);
    const title = $('h1').first().text().trim().toLowerCase();
    const breadtext = $('.breadcrumb, .nav-chain, .help-breadcrumbs').text().toLowerCase();
    const combined = title + ' ' + breadtext;

    for (const [section, kws] of Object.entries(TARGETS)) {
      if (found[section]) continue;
      if (kws.some(kw => combined.includes(kw))) {
        found[section] = { id, url, title: $('h1').first().text().trim() };
        return section;
      }
    }
  } catch {}
  return null;
}

async function main() {
  console.log(`Scanning ${IDS.length} articles for 8 sections...\n`);

  // Prioritise high-ID articles (newer, more likely to be live)
  const sorted = [...IDS].sort((a, b) => parseInt(b) - parseInt(a));

  let checked = 0;
  for (const id of sorted) {
    if (Object.values(found).every(v => v !== null)) break;
    const section = await checkArticle(id);
    checked++;
    if (section) {
      console.log(`  ✅ [${section}] ${found[section].url} — ${found[section].title}`);
    }
    if (checked % 20 === 0) {
      const missing = Object.entries(found).filter(([,v]) => !v).map(([k]) => k);
      process.stdout.write(`  Checked ${checked}, still missing: ${missing.join(', ')}\n`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('\n=== RESULTS ===');
  for (const [section, info] of Object.entries(found)) {
    if (info) console.log(`  ${section.padEnd(12)}: ${info.url}  —  ${info.title}`);
    else console.log(`  ${section.padEnd(12)}: NOT FOUND`);
  }

  // Output as JS-ready ARTICLES array
  console.log('\n// ARTICLES array:');
  const extras = [
    { section: 'CRM', label: 'CRM — Сделки',         knownUrl: 'https://helpdesk.bitrix24.ru/open/26161116/' },
    { section: 'Drive', label: 'Drive',               knownUrl: 'https://helpdesk.bitrix24.ru/open/20811344/' },
  ];
  for (const [section, info] of Object.entries(found)) {
    if (info) console.log(`  { label: '${section}', url: '${info.url}' },`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
