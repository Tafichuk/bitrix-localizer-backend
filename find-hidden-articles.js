const axios = require('axios');
const cheerio = require('cheerio');
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // 1. Sitemap
  console.log('=== Sitemap ===');
  try {
    const sm = await axios.get('https://helpdesk.bitrix24.com/sitemap.xml', { headers: HEADERS, timeout: 10000 });
    const urls = sm.data.match(/\/open\/\d+\//g) || [];
    console.log('URLs /open/ в sitemap:', new Set(urls).size);
    console.log('Первые 5:', [...new Set(urls)].slice(0, 5).join(', '));
  } catch (e) {
    console.log('sitemap.xml:', e.message);
  }

  // 2. robots.txt
  console.log('\n=== robots.txt ===');
  try {
    const rb = await axios.get('https://helpdesk.bitrix24.com/robots.txt', { headers: HEADERS, timeout: 10000 });
    console.log(rb.data.substring(0, 400));
  } catch (e) {
    console.log(e.message);
  }

  // 3. Реальный CRM HTML — разбираем структуру
  console.log('\n=== CRM HTML структура ===');
  const r = await axios.get('https://helpdesk.bitrix24.com/section/47482/', { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(r.data);

  const openLinks = [];
  $('a[href*="/open/"]').each((_, el) => {
    const h = $(el).attr('href') || '';
    const t = $(el).text().trim();
    openLinks.push({ url: h, text: t.substring(0, 60) });
  });
  console.log('Статей /open/ на странице:', openLinks.length);
  openLinks.forEach(l => console.log(`  ${l.url} — ${l.text}`));

  // Смотрим какие классы/блоки содержат эти ссылки
  console.log('\nКонтейнеры статей:');
  $('a[href*="/open/"]').first().parents().each((i, el) => {
    if (i > 4) return;
    const cls = $(el).attr('class') || '';
    const tag = el.tagName;
    console.log(`  ${tag}.${cls.split(' ')[0]}`);
  });

  // 4. Ищем ссылки на OTHER секции внутри CRM (не глобальные)
  console.log('\nВсе теги H1/H2/H3 на странице:');
  $('h1, h2, h3').each((_, el) => {
    console.log(`  <${el.tagName}> ${$(el).text().trim().substring(0, 70)}`);
  });

  // 5. Пробуем разные паттерны пагинации
  console.log('\n=== Попытки пагинации ===');
  const paginationTests = [
    '/section/47482/?PAGEN_1=2',
    '/section/47482/page/2/',
    '/section/47482/?page=2',
    '/section/47482/?p=2',
  ];
  for (const url of paginationTests) {
    try {
      const pr = await axios.get('https://helpdesk.bitrix24.com' + url, { headers: HEADERS, timeout: 10000 });
      const p$ = cheerio.load(pr.data);
      const pLinks = new Set();
      p$('a[href*="/open/"]').each((_, el) => pLinks.add(p$(el).attr('href')));
      // Сравниваем с page 1
      const same = [...pLinks].filter(l => openLinks.find(o => o.url === l)).length;
      console.log(`  ${url}: ${pLinks.size} статей (${same} совпадают с page 1)`);
    } catch (e) {
      console.log(`  ${url}: ${e.message}`);
    }
    await sleep(300);
  }
}

main().catch(console.error);
