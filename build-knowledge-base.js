#!/usr/bin/env node
/**
 * ЭТАП 1: Сбор базы знаний Bitrix24
 * Сканирует все разделы хелпдеска, скачивает скрины, строит паттерны навигации.
 * Запуск: node build-knowledge-base.js
 * Возобновляемый — можно останавливать и запускать снова.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SECTIONS = [
  // ── Общие ─────────────────────────────────────────────────────────────────
  { name: 'Bitrix24 Support',       url: '/section/148858/' },
  { name: 'Registration and Login', url: '/section/152008/' },
  { name: 'Getting Started',        url: '/section/93303/'  },
  { name: 'Employee Widget',        url: '/section/122803/' },
  { name: 'Plans and Payments',     url: '/section/47912/'  },
  { name: 'General Questions',      url: '/section/47492/'  },
  { name: 'Bitrix24 On-Premise',    url: '/section/110893/' },

  // ── Коммуникации ──────────────────────────────────────────────────────────
  { name: 'Feed',                   url: '/section/47478/'  },
  { name: 'Messenger',              url: '/section/47489/'  },
  { name: 'Bitrix24 Messenger',     url: '/section/122989/' }, // desktop app
  { name: 'Collabs',                url: '/section/162876/' },
  { name: 'Calendar',               url: '/section/47483/'  },
  { name: 'Mail',                   url: '/section/47480/'  },
  { name: 'Workgroups',             url: '/section/47484/'  },

  // ── Продуктивность ────────────────────────────────────────────────────────
  { name: 'Tasks',                  url: '/section/47481/'  },
  { name: 'Drive',                  url: '/section/77623/'  },
  { name: 'Knowledge Base',         url: '/section/127124/' },
  { name: 'Workflows',              url: '/section/77629/'  },
  { name: 'Automation',             url: '/section/157580/' },
  { name: 'CoPilot',                url: '/section/157576/' },

  // ── CRM и продажи ─────────────────────────────────────────────────────────
  { name: 'CRM',                    url: '/section/47482/'  },
  { name: 'Contact Center',         url: '/section/107059/' },
  { name: 'Sales Center',           url: '/section/122783/' },
  { name: 'Online Store',           url: '/section/108779/' },
  { name: 'CRM + Online Store',     url: '/section/141094/' },
  { name: 'CRM Payment',            url: '/section/134832/' },
  { name: 'Booking',                url: '/section/162944/' },
  { name: 'Telephony',              url: '/section/47487/'  },

  // ── Аналитика и маркетинг ─────────────────────────────────────────────────
  { name: 'Analytics',              url: '/section/122485/' },
  { name: 'BI Builder',             url: '/section/157574/' },
  { name: 'Marketing',              url: '/section/98283/'  },

  // ── Сайты и магазины ──────────────────────────────────────────────────────
  { name: 'Sites',                  url: '/section/95157/'  },
  { name: 'Inventory',              url: '/section/143966/' },

  // ── HR и компания ─────────────────────────────────────────────────────────
  { name: 'Employees',              url: '/section/47823/'  },
  { name: 'e-Signature',            url: '/section/152650/' },
  { name: 'e-Signature for HR',     url: '/section/159756/' },

  // ── Настройки и система ───────────────────────────────────────────────────
  { name: 'Settings',               url: '/section/47836/'  },
  { name: 'Market',                 url: '/section/47490/'  },
];

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callClaudeWithRetry(params, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (e) {
      if (e.status === 429) {
        const wait = Math.pow(2, i) * 8000;
        console.log(`  ⏳ Rate limit, жду ${wait / 1000}с...`);
        await sleep(wait);
      } else throw e;
    }
  }
  throw new Error('Превышено число попыток rate limit');
}

// ── Этап 1а: Сбор URL статей ──────────────────────────────────────────────────

async function getAllArticleUrls() {
  const cacheFile = 'kb-articles.json';
  if (fs.existsSync(cacheFile)) {
    const articles = JSON.parse(fs.readFileSync(cacheFile));
    console.log(`📋 Загружено ${articles.length} статей из кэша\n`);
    return articles;
  }

  const articles = [];
  const seen = new Set();

  for (const section of SECTIONS) {
    console.log(`📂 Сканирую: ${section.name}`);
    try {
      const resp = await axios.get(`https://helpdesk.bitrix24.com${section.url}`, {
        headers: HTTP_HEADERS, timeout: 20000,
      });
      const $ = cheerio.load(resp.data);

      $('a[href*="/open/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const title = $(el).text().trim();
        if (!href || title.length < 4) return;
        const fullUrl = href.startsWith('http') ? href : `https://helpdesk.bitrix24.com${href}`;
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);
        articles.push({ section: section.name, title: title.substring(0, 120), url: fullUrl });
      });

      console.log(`  → ${articles.length} статей всего`);
    } catch (e) {
      console.log(`  ❌ Ошибка раздела ${section.name}: ${e.message}`);
    }
    await sleep(600);
  }

  fs.writeFileSync(cacheFile, JSON.stringify(articles, null, 2));
  console.log(`\n✅ Найдено ${articles.length} статей\n`);
  return articles;
}

// ── Этап 1б: Парсинг скринов статьи ──────────────────────────────────────────

async function getScreenshotsFromArticle(url) {
  const resp = await axios.get(url, { headers: HTTP_HEADERS, timeout: 20000 });
  const $ = cheerio.load(resp.data);

  // Удаляем шум
  $('script,style,nav,footer,.breadcrumb,.help-social,.feedback-form').remove();

  const contentSels = ['.help-article__content', '.article-content', 'article', 'main', '.content'];
  let $content = null;
  for (const sel of contentSels) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) { $content = el; break; }
  }
  if (!$content) $content = $('body');

  const screenshots = [];
  $content.find('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    const alt = $(el).attr('alt') || '';

    // Фильтры мусора
    if (!src) return;
    if (src.includes('resize_cache')) return;
    if (src.match(/\/main\/[a-f0-9]{3}\//)) return;
    if (alt.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/)) return;  // имена авторов
    if (src.includes('logo') || src.includes('icon') || src.includes('avatar')) return;
    if (src.endsWith('.svg') || src.endsWith('.gif')) return;

    const fullSrc = src.startsWith('http') ? src : `https://helpdesk.bitrix24.com${src}`;

    // Контекст — ближайший предшествующий заголовок или параграф
    let context = '';
    let $node = $(el);
    for (let j = 0; j < 6; j++) {
      $node = $node.parent();
      const prev = $node.prevAll('h1,h2,h3,h4,h5,p,li').first();
      if (prev.length) {
        const txt = prev.text().trim();
        if (txt.length > 5) { context = txt.substring(0, 200); break; }
      }
    }

    screenshots.push({ src: fullSrc, alt: alt.trim(), context, index: i });
  });

  return screenshots;
}

// ── Этап 1в: Анализ скрина → паттерн навигации ───────────────────────────────

async function buildPattern(article, screenshot) {
  const imgResp = await axios.get(screenshot.src, {
    responseType: 'arraybuffer', timeout: 25000, headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const compressed = await sharp(Buffer.from(imgResp.data))
    .resize({ width: 640, withoutEnlargement: true })
    .jpeg({ quality: 45 })
    .toBuffer();

  const response = await callClaudeWithRetry({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Analyze this Bitrix24 English helpdesk screenshot.
Article: "${article.title}"
Section: ${article.section}
Context: "${screenshot.context}"

Identify the exact interface state shown and how to reproduce it.

Bitrix24 URL map:
Feed/News → /stream/
CRM Deals → /crm/deal/
CRM Contacts → /crm/contact/
CRM Leads → /crm/leads/
CRM Companies → /crm/company/
Tasks → /tasks/
Calendar → /calendar/
Drive → /disk/
Employees → /company/
Settings → /settings/
Messenger → /im/
Telephony → /telephony/
Automation → /bizproc/
Marketing → /marketing/
Analytics → /analytics/
Knowledge Base → /knowledge/
Sites → /site/
Inventory → /store/

Return ONLY valid JSON (no markdown):
{
  "portalUrl": "/stream/",
  "pageTitle": "what page this is",
  "interfaceState": "describe exact state: what is open/visible/highlighted",
  "keyElements": ["element1", "element2"],
  "waitSelector": ".css-selector-to-wait-for",
  "steps": [
    {
      "action": "navigate|click|hover|scroll|wait",
      "description": "plain english description",
      "targetElement": "describe the element to interact with",
      "approximateX": 640,
      "approximateY": 400,
      "waitAfterMs": 1000
    }
  ],
  "screenshotAfterStepIndex": -1,
  "isStaticPage": true,
  "complexity": "simple|medium|complex"
}`,
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: compressed.toString('base64') } },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const pattern = JSON.parse(jsonMatch[0]);

  return {
    id: `${article.section}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    articleUrl: article.url,
    articleTitle: article.title,
    section: article.section,
    screenshotUrl: screenshot.src,
    screenshotContext: screenshot.context,
    screenshotAlt: screenshot.alt,
    verified: false,
    ...pattern,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Строю базу знаний Bitrix24...\n');

  const articles = await getAllArticleUrls();

  // Загружаем прогресс
  let kb = [];
  let processedUrls = new Set();
  const kbFile = 'knowledge-base.json';

  if (fs.existsSync(kbFile)) {
    kb = JSON.parse(fs.readFileSync(kbFile));
    processedUrls = new Set(kb.map(p => p.articleUrl));
    const patterns = kb.filter(p => !p.noScreenshots).length;
    console.log(`📚 Продолжаю: ${patterns} паттернов, ${processedUrls.size} обработанных статей\n`);
  }

  let total = 0;
  let errors = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    if (processedUrls.has(article.url)) continue;

    const prefix = `[${i + 1}/${articles.length}] ${article.section}: ${article.title.substring(0, 45)}`;
    process.stdout.write(`${prefix}... `);

    try {
      const screenshots = await getScreenshotsFromArticle(article.url);

      if (screenshots.length === 0) {
        console.log('(нет скринов)');
        kb.push({ articleUrl: article.url, articleTitle: article.title, section: article.section, noScreenshots: true });
        processedUrls.add(article.url);
        continue;
      }

      console.log(`(${screenshots.length} скринов)`);

      for (const screenshot of screenshots) {
        try {
          const pattern = await buildPattern(article, screenshot);
          if (pattern) {
            kb.push(pattern);
            total++;
            console.log(`  ✅ ${pattern.pageTitle} [${pattern.complexity}]`);
          }
          await sleep(2500);
        } catch (e) {
          errors++;
          console.log(`  ⚠️  ${e.message.slice(0, 80)}`);
          await sleep(1000);
        }
      }

      processedUrls.add(article.url);
    } catch (e) {
      errors++;
      console.log(`❌ ${e.message.slice(0, 80)}`);
    }

    if ((i + 1) % 5 === 0) {
      fs.writeFileSync(kbFile, JSON.stringify(kb, null, 2));
      console.log(`  💾 Прогресс сохранён (${kb.length} записей)`);
    }

    await sleep(800);
  }

  fs.writeFileSync(kbFile, JSON.stringify(kb, null, 2));

  console.log('\n' + '='.repeat(50));
  console.log(`✅ ГОТОВО!`);
  console.log(`📊 Паттернов собрано: ${total}`);
  console.log(`❌ Ошибок: ${errors}`);
  console.log(`💾 Сохранено: ${kbFile}`);
}

main().catch(console.error);
