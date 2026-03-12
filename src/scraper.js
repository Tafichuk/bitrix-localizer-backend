const axios = require('axios');
const cheerio = require('cheerio');

const HELPDESK_BASE = 'https://helpdesk.bitrix24.ru';

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

async function parseArticle(url) {
  const response = await axios.get(url, {
    headers: HTTP_HEADERS,
    timeout: 30000,
    maxRedirects: 5,
  });

  const $ = cheerio.load(response.data);

  // ── Breadcrumbs (before removing nav elements) ──────────────────────────────
  const breadcrumbs = [];
  $('.breadcrumb a, .breadcrumbs a, .nav-chain a, .help-breadcrumbs a').each((_, el) => {
    const text = $(el).text().trim();
    if (text) breadcrumbs.push(text);
  });

  // ── Remove noise ─────────────────────────────────────────────────────────────
  $('script, style, nav, footer, .breadcrumb, .breadcrumbs, .nav-chain, .help-breadcrumbs, .help-social, .feedback-form, .b24-widget-button-wrapper, .popup-window').remove();

  // ── Title ────────────────────────────────────────────────────────────────────
  const title =
    $('h1.help-article__title').text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().replace(/\s*[-|].*$/, '').trim() ||
    'Untitled';

  // ── Main content block ───────────────────────────────────────────────────────
  const contentSelectors = [
    '.help-article__content', '.article-content', '.help-content',
    'article .content', 'article', 'main .content', 'main', '.content',
  ];
  let $content = null;
  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) { $content = el; break; }
  }
  if (!$content) $content = $('body');

  // ── Text blocks ──────────────────────────────────────────────────────────────
  const blocks = [];
  $content.find('p, h1, h2, h3, h4, li, td, th').each((i, el) => {
    const text = $(el).text().trim();
    if (text.length > 3) blocks.push({ type: el.name, text, index: i });
  });

  // ── Screenshots ──────────────────────────────────────────────────────────────
  const screenshots = [];
  const seen = new Set();

  $content.find('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (!src) return;

    // Skip icons, logos, spacers, SVG, GIF
    if (src.includes('icon') || src.includes('logo') || src.includes('pixel') || src.includes('spacer')) return;
    if (src.endsWith('.svg') || src.endsWith('.gif')) return;
    if (seen.has(src)) return;

    // Skip author photos
    const alt = $(el).attr('alt') || '';
    if (isAuthorPhoto(src, alt, $, el)) return;

    // Skip tiny images
    if (isTooSmall($, el)) return;

    seen.add(src);
    const absoluteUrl = src.startsWith('http') ? src : `${HELPDESK_BASE}${src.startsWith('/') ? '' : '/'}${src}`;
    const imgCtx = getImageContext($, el);

    // combined = rich haystack for nav_map matching + Claude context
    const combined = [imgCtx.heading, imgCtx.text_before, alt, imgCtx.text_after, imgCtx.caption]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);

    screenshots.push({
      index: screenshots.length,
      src,
      absoluteUrl,
      alt,
      heading:     imgCtx.heading,
      text_before: imgCtx.text_before,
      text_after:  imgCtx.text_after,
      caption:     imgCtx.caption,
      context:     combined,   // backward-compat field — now contains full combined text
      combined,                // explicit alias for new callers
    });
  });

  const contentHtml = $content.html() || '';

  return { title, breadcrumbs, blocks, screenshots, contentHtml, sourceUrl: url };
}

// ── Rich image context extraction ────────────────────────────────────────────
// Walks UP the ancestor chain at each level collecting prev/next sibling text,
// stopping once we have heading + text or have gone 8 levels deep.
function getImageContext($, imgEl) {
  const $img = $(imgEl);

  let heading     = '';
  let text_before = '';
  let text_after  = '';

  // Walk up ancestor levels, collecting sibling text at each level.
  // Typical helpdesk structure: img → a → div[center] → article-content
  // At the article-content level, the h2 tags are direct siblings of the div.
  let $node = $img;
  for (let depth = 0; depth < 8; depth++) {
    const $parent = $node.parent();
    if (!$parent.length || $parent.is('body,html')) break;

    // ── prev siblings at this level ───────────────────────────────────────
    if (!heading || !text_before) {
      const prevParts = [];
      let prev = $node.prev();
      for (let i = 0; i < 8 && prev.length; i++) {
        if (!heading && prev.is('h2,h3')) {
          heading = prev.text().trim().slice(0, 120);
        } else if (!heading && prev.is('h1,h4')) {
          heading = prev.text().trim().slice(0, 120);
        }
        const t = prev.text().replace(/\s+/g, ' ').trim();
        if (t && !prev.is('img')) prevParts.unshift(t);
        prev = prev.prev();
      }
      if (!text_before && prevParts.length) {
        text_before = prevParts.join(' ').slice(-300);
      }
    }

    // ── next siblings at this level ───────────────────────────────────────
    if (!text_after) {
      const afterParts = [];
      let next = $node.next();
      for (let i = 0; i < 5 && next.length; i++) {
        const t = next.text().replace(/\s+/g, ' ').trim();
        if (t && !next.is('img')) afterParts.push(t);
        next = next.next();
      }
      if (afterParts.length) text_after = afterParts.join(' ').slice(0, 300);
    }

    // Stop early once we have everything
    if (heading && text_before && text_after) break;

    $node = $parent;
  }

  // Fallback heading: first h2/h3 in the enclosing article block
  if (!heading) {
    heading = $img.closest('[class*="article"], [class*="content"], section, article')
      .find('h2,h3').first().text().trim().slice(0, 120);
  }

  // ── Figcaption ────────────────────────────────────────────────────────────
  const caption = $img.closest('figure').find('figcaption').text().trim().slice(0, 150);

  return { heading, text_before, text_after, caption };
}

// ── Author photo detection ────────────────────────────────────────────────────
function isAuthorPhoto(src, alt, $, el) {
  if (/\/main\/[a-f0-9]{3}\//i.test(src)) return true;
  if (/\/(avatar|portrait|author)\//i.test(src)) return true;
  if (/resize_cache.*\/(photo|avatar|portrait)/i.test(src)) return true;
  if (/^[A-ZА-ЯЁ][a-zа-яё]+ [A-ZА-ЯЁ][a-zа-яё]+$/.test(alt.trim())) return true;
  if ($) {
    if ($(el).closest('[class*="author"], .help-article__author, .article__author').length) return true;
  }
  return false;
}

// ── Size filter ───────────────────────────────────────────────────────────────
function isTooSmall($, el) {
  const w = parseInt($(el).attr('width') || '0', 10);
  const h = parseInt($(el).attr('height') || '0', 10);
  if (w > 0 && w < 100) return true;
  if (h > 0 && h < 100) return true;
  return false;
}

module.exports = { parseArticle };
