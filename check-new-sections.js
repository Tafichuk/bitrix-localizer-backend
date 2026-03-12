const axios = require('axios');
const cheerio = require('cheerio');
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const NEW_SECTIONS = [
  { name: 'Bitrix24 Support',       url: '/section/148858/' },
  { name: 'Registration and Login', url: '/section/152008/' },
  { name: 'Employee Widget',        url: '/section/122803/' },
  { name: 'General Questions',      url: '/section/47492/'  },
  { name: 'Bitrix24 On-Premise',    url: '/section/110893/' },
  { name: 'Bitrix24 Messenger',     url: '/section/122989/' },
  { name: 'Collabs',                url: '/section/162876/' },
  { name: 'Online Store',           url: '/section/108779/' },
  { name: 'CRM + Online Store',     url: '/section/141094/' },
  { name: 'CRM Payment',            url: '/section/134832/' },
  { name: 'e-Signature for HR',     url: '/section/159756/' },
  { name: 'Market',                 url: '/section/47490/'  },
];

async function main() {
  let total = 0;
  for (const s of NEW_SECTIONS) {
    const r = await axios.get('https://helpdesk.bitrix24.com' + s.url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(r.data);
    const links = new Set();
    $('a[href*="/open/"]').each((_, el) => links.add($(el).attr('href')));
    console.log(`  ${links.size.toString().padStart(3)} статей  ${s.name}`);
    total += links.size;
    await sleep(400);
  }
  console.log(`  ${'—'.repeat(30)}`);
  console.log(`  ${total.toString().padStart(3)} ИТОГО новых статей`);
}
main().catch(console.error);
