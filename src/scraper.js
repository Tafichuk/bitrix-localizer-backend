const axios = require('axios');
const cheerio = require('cheerio');

const HELPDESK_BASE = 'https://helpdesk.bitrix24.ru';

async function scrapeArticle(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    },
    timeout: 30000,
    maxRedirects: 5,
  });

  const $ = cheerio.load(response.data);

  // Remove noise
  $('script, style, nav, footer, .breadcrumb, .help-social, .feedback-form, .b24-widget-button-wrapper, .popup-window').remove();

  // Extract title
  const title =
    $('h1.help-article__title').text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().replace(/\s*[-|].*$/, '').trim() ||
    'Untitled';

  // Find main content
  const contentSel = [
    '.help-article__content',
    '.article-content',
    '.help-content',
    'article .content',
    'article',
    'main .content',
    'main',
    '.content',
  ];

  let $content = null;
  for (const sel of contentSel) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) {
      $content = el;
      break;
    }
  }
  if (!$content) $content = $('body');

  // Extract images
  const images = [];
  const seen = new Set();

  $content.find('img').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (!src) return;

    // Skip icons, logos, spacers
    if (src.includes('icon') || src.includes('logo') || src.includes('pixel') || src.includes('spacer')) return;
    if (src.endsWith('.svg') || src.endsWith('.gif')) return;
    if (seen.has(src)) return;
    seen.add(src);

    const absoluteUrl = src.startsWith('http') ? src : `${HELPDESK_BASE}${src.startsWith('/') ? '' : '/'}${src}`;

    images.push({
      src,           // original src attribute value
      absoluteUrl,   // full URL for downloading
      alt: $(el).attr('alt') || '',
      index: images.length,
    });
  });

  // Get content HTML (preserving structure)
  const contentHtml = $content.html() || '';

  return { title, contentHtml, images, sourceUrl: url };
}

module.exports = { scrapeArticle };
