#!/usr/bin/env node
/**
 * Тест navigation-planner + Computer Use на двух статьях хелпдеска.
 * Запуск: node test-computer-use.js
 */
const axios = require('axios');
const fs = require('fs');
const { takeScreenshotWithComputerUse, loadPortalAuth, openBrowserSession, closeBrowserSession } = require('./src/computer-use-screenshot');

const PORTAL_URL = process.env.PORTAL_URL || 'https://testportal.bitrix24.com/stream/';

const ARTICLES = [
  {
    name: 'Умное слежение (Лента)',
    section: 'Лента',
    screenshotUrl: 'https://helpdesk.bitrix24.ru/upload/medialibrary/425/xdyj0520od0xvq8d8wsyuziu5rotpque/2.jpg',
    description: 'Feed news stream with settings menu open — gear/settings icon (⚙️) clicked showing smart follow option',
    outFile: 'test_article1_gear.png',
  },
  {
    name: 'Закреплённые сообщения (Лента)',
    section: 'Лента',
    screenshotUrl: 'https://helpdesk.bitrix24.ru/upload/medialibrary/425/xdyj0520od0xvq8d8wsyuziu5rotpque/2.jpg',
    description: 'Feed news stream showing a pinned post banner at the top of the feed',
    outFile: 'test_article2_pinned.png',
  },
];

// Попробуем найти реальный скрин из второй статьи
async function getScreenshotUrl(articleUrl) {
  try {
    const resp = await axios.get(articleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    });
    const cheerio = require('cheerio');
    const $ = cheerio.load(resp.data);
    const imgs = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (src.includes('upload') || src.includes('medialibrary')) {
        imgs.push(src.startsWith('http') ? src : `https://helpdesk.bitrix24.ru${src}`);
      }
    });
    return imgs;
  } catch (e) {
    return [];
  }
}

async function downloadOriginal(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0' } });
  return Buffer.from(resp.data).toString('base64');
}

async function runArticle(article, session) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📰 Статья: ${article.name}`);
  console.log(`🖼️  Скрин: ${article.screenshotUrl}`);
  console.log(`📝 Раздел: ${article.section}`);
  console.log('='.repeat(60));

  let origBase64;
  try {
    origBase64 = await downloadOriginal(article.screenshotUrl);
    console.log(`✅ Оригинал загружен: ${origBase64.length} chars (${Math.round(origBase64.length * 0.75 / 1024)} KB)`);
  } catch (e) {
    console.error(`❌ Не удалось скачать оригинал: ${e.message}`);
    return;
  }

  console.log('\n🤖 Запускаю Computer Use...\n');
  try {
    const result = await takeScreenshotWithComputerUse(
      session.context,
      PORTAL_URL,
      article.description,
      origBase64,
      article.section,
    );
    fs.writeFileSync(article.outFile, result);
    console.log(`\n✅ Сохранён: ${article.outFile} (${Math.round(result.length / 1024)} KB)`);
  } catch (e) {
    console.error(`\n❌ Ошибка: ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  }
}

async function main() {
  console.log('=== TEST: Navigation Planner + Computer Use ===\n');

  // Пробуем найти реальный скрин из второй статьи
  console.log('🔍 Ищу скрины в статье 2: https://helpdesk.bitrix24.ru/open/12395284/');
  const imgs2 = await getScreenshotUrl('https://helpdesk.bitrix24.ru/open/12395284/');
  if (imgs2.length > 0) {
    console.log(`  Найдено ${imgs2.length} изображений:`);
    imgs2.forEach((u, i) => console.log(`    ${i + 1}. ${u}`));
    ARTICLES[1].screenshotUrl = imgs2[0];
    ARTICLES[1].description = 'Feed showing pinned message banner at the top';
  } else {
    console.log('  Изображения не найдены, использую скрин из статьи 1');
  }

  const cookies = loadPortalAuth();
  console.log(`\n🍪 Куки: ${cookies.length} шт.`);

  console.log(`🌐 Открываю браузер: ${PORTAL_URL}`);
  let session;
  try {
    session = await openBrowserSession(PORTAL_URL, cookies);
  } catch (e) {
    console.error('❌ Не удалось открыть браузер:', e.message);
    process.exit(1);
  }

  try {
    for (const article of ARTICLES) {
      await runArticle(article, session);
      // Пауза между статьями
      if (article !== ARTICLES[ARTICLES.length - 1]) {
        console.log('\n⏳ Пауза 5с между статьями...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  } finally {
    await closeBrowserSession(session);
  }

  console.log('\n=== ГОТОВО ===');
  console.log('Открываю скрины...');
  for (const a of ARTICLES) {
    if (fs.existsSync(a.outFile)) {
      require('child_process').exec(`open ${a.outFile}`);
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
