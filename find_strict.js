#!/usr/bin/env node
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { parseArticle } = require('./src/scraper');
const fs = require('fs'), path = require('path');

const IDS = fs.readFileSync(path.join(__dirname, '../data/article_urls.txt'), 'utf8')
  .trim().split('\n').map(s => s.trim()).filter(Boolean);

const TARGETS = {
  'Employees — Структура': {
    titleKws: ['структура компании', 'оргструктур', 'сотрудники в битрикс', 'отдел'],
    bodyKws:  ['структура компании', 'организационная структура', 'органиграмм'],
    maxImgs: 15, found: null,
  },
  'Automation — Роботы': {
    titleKws: ['робот', 'автоматизация crm', 'автоматизация в crm', 'триггер'],
    bodyKws:  ['роботы', 'настроить робот', 'добавить робот', 'автоматическ'],
    maxImgs: 15, found: null,
  },
  'Sites — Конструктор': {
    titleKws: ['конструктор сайт', 'создать сайт', 'сайт в битрикс', 'лендинг'],
    bodyKws:  ['создать сайт', 'конструктор сайт', 'страниц сайт', 'сайт битрикс24'],
    maxImgs: 15, found: null,
  },
};

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' };

async function getTitle(id) {
  try {
    const res = await axios.get(`https://helpdesk.bitrix24.ru/open/${id}/`, { headers: HEADERS, timeout: 8000 });
    const $ = cheerio.load(res.data);
    const h1s = [];
    $('h1').each((_, el) => { const t = $(el).text().trim(); if (t) h1s.push(t); });
    return h1s.length > 1 ? h1s[1].toLowerCase() : '';
  } catch { return ''; }
}

async function main() {
  console.log('Strict search for Employees, Automation, Sites...\n');
  for (const id of IDS) {
    if (Object.values(TARGETS).every(t => t.found)) break;
    const title = await getTitle(id);
    if (!title) { await new Promise(r => setTimeout(r, 100)); continue; }

    for (const [label, cfg] of Object.entries(TARGETS)) {
      if (cfg.found) continue;
      if (!cfg.titleKws.some(kw => title.includes(kw))) continue;
      try {
        const p = await parseArticle(`https://helpdesk.bitrix24.ru/open/${id}/`);
        const body = p.blocks.map(b => b.text.toLowerCase()).join(' ');
        const bodyMatch = cfg.bodyKws.some(kw => body.includes(kw));
        if (bodyMatch && p.screenshots.length >= 2 && p.screenshots.length <= cfg.maxImgs) {
          cfg.found = { id, url: `https://helpdesk.bitrix24.ru/open/${id}/`, title, imgs: p.screenshots.length };
          console.log(`  ✅ [${label}] ${id} — "${title.slice(0,60)}" (${p.screenshots.length} imgs)`);
        }
      } catch {}
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  for (const [label, cfg] of Object.entries(TARGETS)) {
    if (!cfg.found) console.log(`  ❌ ${label}: NOT FOUND`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
