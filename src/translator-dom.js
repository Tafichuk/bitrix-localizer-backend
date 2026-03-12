const cheerio = require('cheerio');

const SKIP_TAGS = new Set(['script', 'style', 'code', 'pre', 'kbd', 'var', 'samp']);

function parseTextBlocks(contentHtml) {
  const $ = cheerio.load(`<div id="__root__">${contentHtml}</div>`, { decodeEntities: false });
  const items = [];
  collectTextNodes($, $('#__root__')[0], items);
  return items.map(item => ({ text: item.node.data, node: item.node }));
}

function applyTranslations(contentHtml, blocks, translations) {
  const $ = cheerio.load(`<div id="__root__">${contentHtml}</div>`, { decodeEntities: false });
  const items = [];
  collectTextNodes($, $('#__root__')[0], items);

  items.forEach((item, i) => {
    const t = translations[i];
    if (t) item.node.data = t;
  });

  return $('#__root__').html() || '';
}

function collectTextNodes($, el, result) {
  if (!el || !el.childNodes) return;
  for (const node of el.childNodes) {
    if (node.type === 'text') {
      if ((node.data || '').trim().length > 1) {
        result.push({ node });
      }
    } else if (node.type === 'tag') {
      const tag = (node.name || '').toLowerCase();
      if (!SKIP_TAGS.has(tag)) {
        collectTextNodes($, node, result);
      }
    }
  }
}

module.exports = { parseTextBlocks, applyTranslations };
