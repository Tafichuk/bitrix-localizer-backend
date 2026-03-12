const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };

async function checkSection(name, sectionId) {
  const url = `https://helpdesk.bitrix24.com/section/${sectionId}/`;
  const r = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(r.data);

  // Все /open/ ссылки
  const openLinks = new Map();
  $('a[href*="/open/"]').each((_, el) => {
    const h = $(el).attr('href') || '';
    const t = $(el).text().trim();
    if (t.length > 2) openLinks.set(h, t.substring(0, 60));
  });

  // Все /section/ ссылки КРОМЕ самого раздела и nav
  const sectionLinks = new Map();
  $('a[href*="/section/"]').each((_, el) => {
    const h = $(el).attr('href') || '';
    const t = $(el).text().trim();
    // Пропускаем главные разделы навигации (известные)
    if (h.includes(`/section/${sectionId}/`)) return;
    if (t.length > 2) sectionLinks.set(h, t.substring(0, 50));
  });

  // Ищем пагинацию
  const pagenLinks = [];
  $('a').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (h.includes('PAGEN') || h.includes('page=')) pagenLinks.push(h);
  });

  console.log(`\n=== ${name} (${sectionId}) ===`);
  console.log(`  Статей /open/: ${openLinks.size}`);
  console.log(`  Подразделов /section/: ${sectionLinks.size}`);
  console.log(`  PAGEN: ${pagenLinks.length > 0 ? pagenLinks.join(', ') : 'нет'}`);

  // Показываем подразделы (не те что в навигации — только специфичные для этого раздела)
  // Главные разделы (которые мы уже знаем) обычно попадают через боковую панель
  if (sectionLinks.size > 0 && sectionLinks.size < 20) {
    console.log(`  Подразделы:`);
    for (const [h, t] of sectionLinks) {
      console.log(`    ${h} — ${t}`);
    }
  }

  return { name, sectionId, articles: openLinks.size, subsections: sectionLinks.size };
}

const SECTIONS = [
  { name: 'Feed',              id: 47478 },
  { name: 'Tasks',             id: 47481 },
  { name: 'CRM',               id: 47482 },
  { name: 'Calendar',          id: 47483 },
  { name: 'Drive',             id: 77623 },
  { name: 'Messenger',         id: 47489 },
  { name: 'Employees',         id: 47823 },
  { name: 'Settings',          id: 47836 },
  { name: 'Telephony',         id: 47487 },
  { name: 'Automation',        id: 157580 },
  { name: 'CoPilot',           id: 157576 },
  { name: 'Analytics',         id: 122485 },
  { name: 'Marketing',         id: 98283 },
  { name: 'Sites',             id: 95157 },
  { name: 'Contact Center',    id: 107059 },
  { name: 'Plans/Payments',    id: 47912 },
  { name: 'Knowledge Base',    id: 127124 },
  { name: 'Workflows',         id: 77629 },
  { name: 'Inventory',         id: 143966 },
  { name: 'Mail',              id: 47480 },
  { name: 'Workgroups',        id: 47484 },
  { name: 'Sales Center',      id: 122783 },
  { name: 'BI Builder',        id: 157574 },
  { name: 'Booking',           id: 162944 },
  { name: 'e-Signature',       id: 152650 },
  { name: 'Getting Started',   id: 93303 },
];

async function main() {
  const results = [];
  for (const s of SECTIONS) {
    try {
      const r = await checkSection(s.name, s.id);
      results.push(r);
    } catch (e) {
      console.log(`\n=== ${s.name} === ОШИБКА: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log('\n\n========== СВОДКА ==========');
  let total = 0;
  for (const r of results.sort((a, b) => b.articles - a.articles)) {
    total += r.articles;
    console.log(`  ${r.articles.toString().padStart(3)} статей  ${r.name}`);
  }
  console.log(`  ${'-'.repeat(30)}`);
  console.log(`  ${total.toString().padStart(3)} ИТОГО`);
}

main().catch(console.error);
