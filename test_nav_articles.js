#!/usr/bin/env node
/**
 * Test script: nav_map + KB lookup for 5 articles.
 * Run from backend/ : node test_nav_articles.js
 */
require('dotenv').config();

const { parseArticle } = require('./src/scraper');
const { findNavMapMatch, navMapStateToPlan } = require('./src/navigation-planner');
const { findBestPattern } = require('./src/knowledge-lookup');

const ARTICLES = [
  { id: 1, label: 'CRM (numeric)', url: 'https://helpdesk.bitrix24.ru/open/26161116/'  },
  { id: 2, label: 'Tasks (numeric)', url: 'https://helpdesk.bitrix24.ru/open/27359038/' },
  { id: 3, label: 'Calendar (numeric)', url: 'https://helpdesk.bitrix24.ru/open/25570792/' },
  { id: 4, label: 'Drive',        url: 'https://helpdesk.bitrix24.ru/open/20811344/'  },
  { id: 5, label: 'Messenger',    url: 'https://helpdesk.bitrix24.ru/open/17373696/'  },
];

function trunc(s, n = 40) {
  if (!s) return '—';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function getArticleSection(breadcrumbs) {
  const filtered = (breadcrumbs || []).filter(b => b && b !== 'Helpdesk' && b !== 'Битрикс24');
  return filtered[filtered.length - 1] || 'Feed';
}

async function testArticle(art) {
  console.log(`\n${'='.repeat(100)}`);
  console.log(`  #${art.id} ${art.label}  —  ${art.url}`);
  console.log('='.repeat(100));

  let parsed;
  try {
    parsed = await parseArticle(art.url);
  } catch (e) {
    console.error(`  ❌ Parse error: ${e.message}`);
    return { label: art.label, url: art.url, rows: [], error: e.message };
  }

  const section = getArticleSection(parsed.breadcrumbs);
  console.log(`  Title:      ${parsed.title}`);
  console.log(`  Section:    ${section}`);
  console.log(`  Breadcrumbs:${parsed.breadcrumbs.join(' > ')}`);
  console.log(`  Images:     ${parsed.screenshots.length}`);
  console.log();

  // Column widths: idx, alt, heading, found, url, source
  const C = [7, 20, 32, 32, 30, 9];
  const hdr = ['Скрин', 'Alt', 'Heading (h2/h3)', 'Найдено (label)', 'URL', 'Источник'];
  const line = (char) => C.map(n => char.repeat(n)).join('┼');
  const row  = (cols) => '│' + cols.map((c, i) => String(c || '').padEnd(C[i]).slice(0, C[i])).join('│') + '│';

  console.log('┌' + line('─').replace(/┼/g, '┬') + '┐');
  console.log(row(hdr));
  console.log('├' + line('─') + '┤');

  const rows = [];

  for (const img of parsed.screenshots) {
    const idx = `img_${img.index + 1}`;
    const altCtx = img.alt ? trunc(img.alt, 18) : '(empty)';

    const headingCol = trunc(img.heading || '', 30);

    // 1. NavMap — img.context is now the full combined text (heading + text_before + alt + text_after)
    const navState = findNavMapMatch(img.context, img.alt, section);
    if (navState) {
      const plan = navMapStateToPlan(navState);
      console.log(row([idx, altCtx, headingCol, trunc(navState.label, 30), trunc(plan.url, 28), 'NavMap']));
      rows.push({ idx, alt: img.alt, heading: img.heading, context: img.context, found: navState.label, url: plan.url, source: 'NavMap' });
      continue;
    }

    // 2. KB — same guard logic as navigation-planner.js
    const isFallbackSection = !section || section === 'Feed' || section === 'Лента';
    const hasContext = img.context && img.context.length > 10;
    const skipKB = isFallbackSection && !hasContext;

    const kbPat = skipKB ? null : findBestPattern(section, img.context, img.alt);
    if (kbPat) {
      const found = kbPat.pageTitle || kbPat.interfaceState || '';
      const url   = kbPat.portalUrl || '';
      console.log(row([idx, altCtx, headingCol, trunc(found, 30), trunc(url, 28), 'KB']));
      rows.push({ idx, alt: img.alt, heading: img.heading, context: img.context, found, url, source: 'KB' });
      continue;
    }

    // 3. Claude / no-match
    const noContent = !img.alt && !img.context;
    const srcLabel = noContent ? 'NoMatch' : 'Claude';
    const note = skipKB ? '→ Claude (KB skipped)' : noContent ? '(no alt/ctx)' : '(no nav_map match)';
    console.log(row([idx, altCtx, headingCol, note, '—', srcLabel]));
    rows.push({ idx, alt: img.alt, heading: img.heading, context: img.context, found: null, url: null, source: srcLabel });
  }

  console.log('└' + line('─').replace(/┼/g, '┴') + '┘');

  return { label: art.label, url: art.url, section, title: parsed.title, rows };
}

async function main() {
  const allResults = [];

  for (const art of ARTICLES) {
    const result = await testArticle(art);
    allResults.push(result);
    await new Promise(r => setTimeout(r, 400));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  ИТОГОВАЯ СВОДКА');
  console.log('═'.repeat(100));

  let total = 0, nm = 0, kb = 0, cl = 0, no = 0;
  for (const res of allResults) {
    if (res.error) continue;
    for (const r of res.rows) {
      total++;
      if (r.source === 'NavMap') nm++;
      else if (r.source === 'KB') kb++;
      else if (r.source === 'Claude') cl++;
      else no++;
    }
  }

  const pct = (n) => `${n} (${total > 0 ? Math.round(n / total * 100) : 0}%)`;
  console.log(`\n  Статей протестировано : ${allResults.length}`);
  console.log(`  Всего скринов         : ${total}`);
  console.log(`  NavMap попаданий      : ${pct(nm)}`);
  console.log(`  KB попаданий          : ${pct(kb)}`);
  console.log(`  Уйдёт к Claude        : ${pct(cl)}`);
  console.log(`  No match (empty)      : ${pct(no)}`);

  console.log('\n  Детали по статьям:');
  for (const res of allResults) {
    if (res.error) { console.log(`  ❌ ${res.label}: ${res.error}`); continue; }
    const rNm = res.rows.filter(r => r.source === 'NavMap').length;
    const rKb = res.rows.filter(r => r.source === 'KB').length;
    const rCl = res.rows.filter(r => r.source === 'Claude').length;
    const rNo = res.rows.filter(r => r.source === 'NoMatch').length;
    const t   = res.rows.length;
    console.log(`  ${res.label.padEnd(12)}: ${t} imgs  NavMap=${rNm}  KB=${rKb}  Claude=${rCl}  NoMatch=${rNo}`);
  }

  console.log('\n  ⚠️  Проверьте вручную URL на False Positives — URL должен соответствовать скрину.');
  console.log('═'.repeat(100));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
