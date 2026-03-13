#!/usr/bin/env node
/**
 * Quickly sample articles and get their sections via scraper.
 */
require('dotenv').config();
const { parseArticle } = require('./src/scraper');
const fs = require('fs'), path = require('path');

const IDS = fs.readFileSync(path.join(__dirname, '../data/article_urls.txt'), 'utf8')
  .trim().split('\n').map(s => s.trim()).filter(Boolean);

// Take every 8th article to get a diverse sample
const sample = IDS.filter((_, i) => i % 8 === 0).slice(0, 100);

async function check(id) {
  const url = `https://helpdesk.bitrix24.ru/open/${id}/`;
  try {
    const p = await parseArticle(url);
    const bc = (p.breadcrumbs || []).filter(b => b && b !== 'Helpdesk' && b !== 'Битрикс24');
    const section = bc[bc.length - 1] || '—';
    return { id, url, title: p.title.slice(0, 60), section, imgs: p.screenshots.length };
  } catch(e) {
    return { id, url, error: e.message.slice(0, 40) };
  }
}

async function main() {
  console.log(`Sampling ${sample.length} articles...\n`);
  const results = [];
  for (const id of sample) {
    const r = await check(id);
    if (r.error) {
      process.stdout.write(`  ${id}: ERROR ${r.error}\n`);
    } else {
      process.stdout.write(`  ${id}: [${r.section}] ${r.title} (${r.imgs} imgs)\n`);
      results.push(r);
    }
    await new Promise(res => setTimeout(res, 200));
  }
  console.log('\n=== SECTIONS FOUND ===');
  const bySect = {};
  for (const r of results) {
    if (!bySect[r.section]) bySect[r.section] = [];
    bySect[r.section].push(r);
  }
  for (const [sec, items] of Object.entries(bySect).sort()) {
    console.log(`\n  [${sec}] (${items.length} articles)`);
    for (const it of items.slice(0, 2)) console.log(`    ${it.url} — ${it.title}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
