const JSZip = require('jszip');
const cheerio = require('cheerio');
const axios = require('axios');

const LANG_NAMES = {
  en: 'English', de: 'Deutsch', fr: 'Français',
  es: 'Español', pt: 'Português', pl: 'Polski', it: 'Italiano',
};

async function generateZip(article, translations, screenshotItems, newScreenshots) {
  const zip = new JSZip();

  // Build lookup: all possible keys for a screenshot item → portal screenshot data
  // Keys: item.src, item.absoluteUrl, decoded variants
  const portalShotMap = new Map();
  for (const item of screenshotItems) {
    const shot = newScreenshots[item.src] || newScreenshots[item.absoluteUrl];
    if (shot) {
      portalShotMap.set(item.src, shot);
      portalShotMap.set(item.absoluteUrl, shot);
      try { portalShotMap.set(decodeURIComponent(item.src), shot); } catch (_) {}
      try { portalShotMap.set(decodeURIComponent(item.absoluteUrl), shot); } catch (_) {}
    }
  }

  // Build lookup for original images: src → absoluteUrl
  const originalUrlMap = new Map();
  for (const item of screenshotItems) {
    originalUrlMap.set(item.src, item.absoluteUrl);
    originalUrlMap.set(item.absoluteUrl, item.absoluteUrl);
  }

  console.log(`[generator] portalShotMap size: ${portalShotMap.size}`);
  console.log(`[generator] screenshotItems: ${screenshotItems.length}, newScreenshots keys: ${Object.keys(newScreenshots).length}`);

  for (const [lang, translation] of Object.entries(translations)) {
    const langFolder = zip.folder(lang);
    const imgFolder = langFolder.folder('images');

    // Load translated HTML into cheerio
    const $ = cheerio.load(translation.contentHtml, { decodeEntities: false });

    let imgCounter = 0;
    const downloadQueue = []; // { fileName, url } — оригинальные скрины для скачивания

    $('img').each((i, el) => {
      // Try src, then data-src, then data-lazy-src
      const rawSrc = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      if (!rawSrc) return;

      imgCounter++;
      const fileName = `image_${imgCounter}.png`;

      // 1. Есть новый портальный скрин?
      const portalShot = portalShotMap.get(rawSrc);
      if (portalShot) {
        imgFolder.file(fileName, Buffer.from(portalShot.data, 'base64'));
        $(el).attr('src', `images/${fileName}`);
        $(el).removeAttr('data-src');
        $(el).removeAttr('data-lazy-src');
        console.log(`[generator] ✅ Portal screenshot → ${fileName} (src: ${rawSrc.slice(0, 60)})`);
        return;
      }

      // 2. Скачать оригинальный скрин как fallback
      const absoluteUrl = originalUrlMap.get(rawSrc);
      if (absoluteUrl && absoluteUrl.startsWith('http')) {
        downloadQueue.push({ fileName, absoluteUrl, el: $(el) });
        $(el).attr('src', `images/${fileName}`);
        $(el).removeAttr('data-src');
        $(el).removeAttr('data-lazy-src');
        console.log(`[generator] ⬇️  Will download original → ${fileName} (${absoluteUrl.slice(0, 60)})`);
        return;
      }

      // 3. Оставляем как есть (внешняя ссылка)
      if (rawSrc.startsWith('http')) {
        console.log(`[generator] 🔗 External image kept: ${rawSrc.slice(0, 60)}`);
      }
    });

    // Скачиваем оригинальные изображения параллельно
    if (downloadQueue.length > 0) {
      await Promise.allSettled(
        downloadQueue.map(async ({ fileName, absoluteUrl }) => {
          try {
            const resp = await axios.get(absoluteUrl, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            imgFolder.file(fileName, Buffer.from(resp.data));
            console.log(`[generator] ✅ Downloaded original: ${fileName}`);
          } catch (err) {
            console.warn(`[generator] ⚠️ Failed to download ${absoluteUrl}: ${err.message}`);
          }
        })
      );
    }

    // Получаем финальный HTML контента (body содержимое, без лишних оберток)
    const contentHtml = $('body').html() || $.html();
    const fullHtml = buildHtmlPage(translation.title, contentHtml, lang);
    langFolder.file('index.html', fullHtml);
  }

  zip.file('README.txt', buildReadme(Object.keys(translations)));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return buffer;
}

function buildHtmlPage(title, content, lang) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      max-width: 960px;
      margin: 0 auto;
      padding: 48px 24px;
      color: #1e293b;
      line-height: 1.75;
      background: #fff;
    }
    h1 { font-size: 30px; font-weight: 700; margin: 0 0 32px; color: #0f172a; line-height: 1.3; }
    h2 { font-size: 22px; font-weight: 600; margin: 40px 0 16px; color: #0f172a; }
    h3 { font-size: 18px; font-weight: 600; margin: 28px 0 12px; color: #1e293b; }
    h4 { font-size: 16px; font-weight: 600; margin: 20px 0 10px; }
    p { margin: 0 0 16px; }
    ul, ol { padding-left: 28px; margin: 0 0 16px; }
    li { margin-bottom: 8px; }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      margin: 20px 0;
      display: block;
    }
    code {
      background: #f1f5f9;
      padding: 2px 7px;
      border-radius: 5px;
      font-family: 'SFMono-Regular', Consolas, monospace;
      font-size: 0.9em;
      color: #0f172a;
    }
    pre {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 20px;
      overflow-x: auto;
      margin: 20px 0;
    }
    pre code { background: none; padding: 0; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f8fafc; font-weight: 600; text-align: left; }
    th, td { padding: 10px 14px; border: 1px solid #e2e8f0; }
    tr:nth-child(even) { background: #f8fafc; }
    blockquote {
      border-left: 4px solid #3b82f6;
      margin: 20px 0;
      padding: 12px 20px;
      background: #eff6ff;
      border-radius: 0 8px 8px 0;
      color: #1e40af;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${content}
</body>
</html>`;
}

function buildReadme(langs) {
  return `Bitrix24 Localized Articles\n===========================\n\nLanguages: ${langs.join(', ')}\n\nEach folder: index.html + images/\n`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateZip };
