#!/usr/bin/env node
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { parseArticle } = require('./src/scraper');
const fs = require('fs'), path = require('path');

const IDS = fs.readFileSync(path.join(__dirname, '../data/article_urls.txt'), 'utf8')
  .trim().split('\n').map(s => s.trim()).filter(Boolean);

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' };

async function getTitle(id) {
  try {
    const res = await axios.get(`https://helpdesk.bitrix24.ru/open/${id}/`, { headers: HEADERS, timeout: 8000 });
    const $ = cheerio.load(res.data);
    const h1s = [];
    $('h1').each((_, el) => { const t = $(el).text().trim(); if (t) h1s.push(t); });
    return h1s.length > 1 ? h1s[1] : '';
  } catch { return ''; }
}

async function main() {
  console.log('Scanning all articles for "сайт" in title...\n');
  const found = [];
  for (const id of IDS) {
    const title = await getTitle(id);
    if (!title) { await new Promise(r => setTimeout(r, 80)); continue; }
    const t = title.toLowerCase();
    if (t.includes('сайт') || t.includes('лендинг') || t.includes('landing')) {
      process.stdout.write(`  ${id}: ${title}\n`);
      found.push({ id, title });
      if (found.length >= 10) break;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  if (!found.length) console.log('  None found.');

  // Check image counts for found
  for (const f of found.slice(0, 5)) {
    try {
      const p = await parseArticle(`https://helpdesk.bitrix24.ru/open/${f.id}/`);
      console.log(`  ${f.id}: ${p.screenshots.length} imgs — ${f.title}`);
    } catch {}
  }
}
main().catch(e => { console.error(e); process.exit(1); });
