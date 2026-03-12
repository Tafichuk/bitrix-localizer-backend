const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };

async function main() {
  const r = await axios.get('https://helpdesk.bitrix24.com/', { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(r.data);

  console.log('=== Все /section/ ссылки на главной странице ===\n');
  const seen = new Set();
  $('a[href*="/section/"]').each((_, el) => {
    const h = $(el).attr('href') || '';
    const t = $(el).text().trim();
    const m = h.match(/\/section\/(\d+)\//);
    if (m && !seen.has(m[1]) && t.length > 2) {
      seen.add(m[1]);
      console.log(`  { name: '${t.substring(0,60)}', url: '${h}' },   // ID: ${m[1]}`);
    }
  });
}

main().catch(console.error);
