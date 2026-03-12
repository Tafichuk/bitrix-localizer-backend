const axios = require('axios');
const cheerio = require('cheerio');
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALL_SECTIONS = [
  { name: 'Bitrix24 Support',       url: '/section/148858/' },
  { name: 'Registration and Login', url: '/section/152008/' },
  { name: 'Getting Started',        url: '/section/93303/'  },
  { name: 'Employee Widget',        url: '/section/122803/' },
  { name: 'Plans and Payments',     url: '/section/47912/'  },
  { name: 'General Questions',      url: '/section/47492/'  },
  { name: 'Bitrix24 On-Premise',    url: '/section/110893/' },
  { name: 'Feed',                   url: '/section/47478/'  },
  { name: 'Messenger',              url: '/section/47489/'  },
  { name: 'Bitrix24 Messenger',     url: '/section/122989/' },
  { name: 'Collabs',                url: '/section/162876/' },
  { name: 'Calendar',               url: '/section/47483/'  },
  { name: 'Mail',                   url: '/section/47480/'  },
  { name: 'Workgroups',             url: '/section/47484/'  },
  { name: 'Tasks',                  url: '/section/47481/'  },
  { name: 'Drive',                  url: '/section/77623/'  },
  { name: 'Knowledge Base',         url: '/section/127124/' },
  { name: 'Workflows',              url: '/section/77629/'  },
  { name: 'Automation',             url: '/section/157580/' },
  { name: 'CoPilot',                url: '/section/157576/' },
  { name: 'CRM',                    url: '/section/47482/'  },
  { name: 'Contact Center',         url: '/section/107059/' },
  { name: 'Sales Center',           url: '/section/122783/' },
  { name: 'Online Store',           url: '/section/108779/' },
  { name: 'CRM + Online Store',     url: '/section/141094/' },
  { name: 'CRM Payment',            url: '/section/134832/' },
  { name: 'Booking',                url: '/section/162944/' },
  { name: 'Telephony',              url: '/section/47487/'  },
  { name: 'Analytics',              url: '/section/122485/' },
  { name: 'BI Builder',             url: '/section/157574/' },
  { name: 'Marketing',              url: '/section/98283/'  },
  { name: 'Sites',                  url: '/section/95157/'  },
  { name: 'Inventory',              url: '/section/143966/' },
  { name: 'Employees',              url: '/section/47823/'  },
  { name: 'e-Signature',            url: '/section/152650/' },
  { name: 'e-Signature for HR',     url: '/section/159756/' },
  { name: 'Settings',               url: '/section/47836/'  },
  { name: 'Market',                 url: '/section/47490/'  },
];

async function main() {
  const allUrls = new Set();
  const results = [];

  for (const s of ALL_SECTIONS) {
    try {
      const r = await axios.get('https://helpdesk.bitrix24.com' + s.url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(r.data);
      const links = new Set();
      $('a[href*="/open/"]').each((_, el) => {
        let h = $(el).attr('href') || '';
        // нормализуем: добавляем trailing slash если нет
        if (h && !h.endsWith('/')) h = h + '/';
        if (h.startsWith('/')) h = 'https://helpdesk.bitrix24.com' + h;
        links.add(h);
      });
      results.push({ name: s.name, count: links.size });
      for (const l of links) allUrls.add(l);
      process.stdout.write('.');
    } catch (e) {
      results.push({ name: s.name, count: 0, err: e.message });
      process.stdout.write('x');
    }
    await sleep(400);
  }

  console.log('\n');
  console.log('=== По разделам (сортировка по убыванию) ===');
  results.sort((a, b) => b.count - a.count);
  let subtotal = 0;
  for (const r of results) {
    console.log(`  ${r.count.toString().padStart(3)}  ${r.name}`);
    subtotal += r.count;
  }
  console.log(`  ${'—'.repeat(35)}`);
  console.log(`  ${subtotal.toString().padStart(3)}  сумма (с дублями)`);
  console.log(`  ${allUrls.size.toString().padStart(3)}  УНИКАЛЬНЫХ статей`);
  console.log(`\nVS kb-articles.json: 312 уникальных`);
  console.log(`Разница: ${allUrls.size - 312} статей не охвачено текущим кэшем`);
}

main().catch(console.error);
