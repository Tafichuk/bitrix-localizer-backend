const axios = require('axios');
const cheerio = require('cheerio');
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Рекурсивно собираем все /open/ ссылки из раздела + его подразделов
async function deepScan(sectionUrl, visited = new Set(), depth = 0) {
  if (visited.has(sectionUrl) || depth > 3) return { articles: new Set(), subsections: new Set() };
  visited.add(sectionUrl);

  const r = await axios.get('https://helpdesk.bitrix24.com' + sectionUrl, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(r.data);

  const articles = new Set();
  const subsections = new Set();

  $('a[href*="/open/"]').each((_, el) => {
    const h = $(el).attr('href');
    if (h) articles.add(h);
  });

  // Ищем /section/ ссылки ТОЛЬКО в основном контенте (не сайдбар/хедер)
  // Убираем глобальную навигацию — берём только ссылки которые ведут
  // на подразделы текущего раздела (обычно они вложены в контент страницы)
  const knownTopSections = new Set([
    '/section/148858/','/section/152008/','/section/47912/','/section/93303/',
    '/section/122803/','/section/47478/','/section/47489/','/section/122989/',
    '/section/162876/','/section/47483/','/section/77623/','/section/47480/',
    '/section/47484/','/section/157576/','/section/47481/','/section/47482/',
    '/section/162944/','/section/107059/','/section/122783/','/section/122485/',
    '/section/157574/','/section/143966/','/section/98283/','/section/95157/',
    '/section/108779/','/section/141094/','/section/134832/','/section/152650/',
    '/section/159756/','/section/47823/','/section/127124/','/section/157580/',
    '/section/77629/','/section/47487/','/section/47490/','/section/47836/',
    '/section/47492/','/section/110893/',
  ]);

  $('a[href*="/section/"]').each((_, el) => {
    const h = $(el).attr('href');
    if (!h || knownTopSections.has(h) || h === sectionUrl) return;
    // Только числовые section ID которые не в нашем глобальном списке
    if (h.match(/\/section\/\d+\//)) subsections.add(h);
  });

  return { articles, subsections };
}

async function checkSection(name, sectionUrl) {
  const { articles: topArticles, subsections } = await deepScan(sectionUrl, new Set(), 0);

  let allArticles = new Set(topArticles);
  const subResults = {};

  for (const sub of subsections) {
    await sleep(300);
    const { articles: subArticles } = await deepScan(sub, new Set(), 1);
    subResults[sub] = subArticles.size;
    for (const a of subArticles) allArticles.add(a);
  }

  return { name, sectionUrl, topLevel: topArticles.size, subsections: subResults, total: allArticles.size };
}

async function main() {
  // Проверяем несколько ключевых разделов детально
  const CHECKS = [
    { name: 'CRM',        url: '/section/47482/' },
    { name: 'Automation', url: '/section/157580/' },
    { name: 'Settings',   url: '/section/47836/' },
    { name: 'Feed',       url: '/section/47478/' },
    { name: 'Tasks',      url: '/section/47481/' },
  ];

  let grandTotal = 0;
  for (const s of CHECKS) {
    const res = await checkSection(s.name, s.url);
    console.log(`\n=== ${res.name} (${res.sectionUrl}) ===`);
    console.log(`  Топ-уровень: ${res.topLevel} статей`);
    if (Object.keys(res.subsections).length > 0) {
      console.log(`  Подразделы (${Object.keys(res.subsections).length}):`);
      for (const [sub, cnt] of Object.entries(res.subsections)) {
        console.log(`    ${sub}: ${cnt} статей`);
      }
    } else {
      console.log(`  Подразделов нет`);
    }
    console.log(`  ИТОГО уникальных: ${res.total}`);
    grandTotal += res.total;
    await sleep(500);
  }
}

main().catch(console.error);
