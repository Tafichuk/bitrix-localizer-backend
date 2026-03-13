#!/usr/bin/env node
/**
 * Finds articles with correct topics AND small image counts (≤10 images).
 * Uses article title (second H1) to classify, not just body keywords.
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { parseArticle } = require('./src/scraper');
const fs = require('fs'), path = require('path');

const IDS = fs.readFileSync(path.join(__dirname, '../data/article_urls.txt'), 'utf8')
  .trim().split('\n').map(s => s.trim()).filter(Boolean);

// Target sections with keywords that must appear in ARTICLE TITLE
const TARGETS = {
  'CRM — Сделки':         { titleKws: ['сделк'], maxImgs: 15, found: null },
  'CRM — Контакты':       { titleKws: ['контакт', 'клиент в crm', 'карточка контакт'], maxImgs: 15, found: null },
  'Tasks — Создание':     { titleKws: ['задач', 'задани'], maxImgs: 12, found: null },
  'Tasks — Канбан':       { titleKws: ['канбан', 'доска задач'], maxImgs: 15, found: null },
  'Calendar — События':   { titleKws: ['календар', 'событ'], maxImgs: 12, found: null },
  'Messenger — Чаты':     { titleKws: ['мессенджер', 'чат', 'сообщени'], maxImgs: 15, found: null },
  'Employees — Структура':{ titleKws: ['сотрудник', 'оргструктур', 'структур компани', 'отдел', 'компани'], maxImgs: 12, found: null },
  'Marketing — Рассылки': { titleKws: ['маркетинг', 'рассылк', 'email кампани', 'смс', 'аудитори'], maxImgs: 12, found: null },
  'Automation — Роботы':  { titleKws: ['робот', 'автоматизаци', 'триггер', 'бизнес-процесс'], maxImgs: 12, found: null },
  'Sites — Конструктор':  { titleKws: ['сайт', 'конструктор', 'лендинг', 'форм сайт'], maxImgs: 12, found: null },
};

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'ru-RU,ru;q=0.9' };

async function getArticleTitle(id) {
  try {
    const res = await axios.get(`https://helpdesk.bitrix24.ru/open/${id}/`, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(res.data);
    const h1s = [];
    $('h1').each((_, el) => { const t = $(el).text().trim(); if (t) h1s.push(t); });
    // Second H1 is the article title (first is site name "Поддержка24")
    return h1s.length > 1 ? h1s[1].toLowerCase() : (h1s[0] || '').toLowerCase();
  } catch { return ''; }
}

async function main() {
  const allDone = () => Object.values(TARGETS).every(t => t.found);
  console.log('Finding articles by title keywords + image count...\n');

  for (const id of IDS) {
    if (allDone()) break;
    const title = await getArticleTitle(id);
    if (!title || title.length < 5) { await new Promise(r => setTimeout(r, 100)); continue; }

    for (const [label, cfg] of Object.entries(TARGETS)) {
      if (cfg.found) continue;
      if (!cfg.titleKws.some(kw => title.includes(kw))) continue;

      // Title matches — check image count
      try {
        const p = await parseArticle(`https://helpdesk.bitrix24.ru/open/${id}/`);
        const imgs = p.screenshots.length;
        if (imgs >= 2 && imgs <= cfg.maxImgs) {
          cfg.found = { id, url: `https://helpdesk.bitrix24.ru/open/${id}/`, title, imgs };
          console.log(`  ✅ [${label}] ${id} — "${title.slice(0, 60)}" (${imgs} imgs)`);
        } else if (imgs > cfg.maxImgs) {
          process.stdout.write(`  [${label}] ${id} has ${imgs} imgs (too many, max ${cfg.maxImgs})\n`);
        }
      } catch {}
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n=== RESULT ===');
  for (const [label, cfg] of Object.entries(TARGETS)) {
    if (cfg.found) {
      console.log(`  ✅ ${label.padEnd(25)}: ${cfg.found.url}  (${cfg.found.imgs} imgs)`);
    } else {
      console.log(`  ❌ ${label.padEnd(25)}: NOT FOUND`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
