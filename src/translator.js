const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGE_NAMES = {
  en: 'English', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', pl: 'Polish', it: 'Italian',
};
const LANGUAGE_LABELS = {
  en: 'English', de: 'Deutsch', fr: 'Français',
  es: 'Español', pt: 'Português', pl: 'Polski', it: 'Italiano',
};

// Теги, внутри которых текст НЕ переводим
const SKIP_TAGS = new Set(['script', 'style', 'code', 'pre', 'kbd', 'var', 'samp']);

async function translateContent(article, targetLanguage) {
  const langName = LANGUAGE_NAMES[targetLanguage];
  if (!langName) throw new Error(`Unknown language: ${targetLanguage}`);

  // Загружаем HTML в cheerio
  const $ = cheerio.load(`<div id="__root__">${article.contentHtml}</div>`, { decodeEntities: false });

  // Собираем все текстовые узлы (только текст, без HTML-тегов)
  const items = []; // { node, originalData }
  collectTextNodes($, $('#__root__')[0], items);

  // Список строк для перевода (title первым)
  const texts = [article.title, ...items.map(it => it.node.data)];

  // Переводим батчами параллельно
  const translated = await translateAllTexts(texts, langName);

  // Применяем переводы к DOM
  const translatedTitle = translated[0] || article.title;
  items.forEach((item, i) => {
    const t = translated[i + 1];
    if (t) item.node.data = t;
  });

  return {
    title: translatedTitle,
    contentHtml: $('#__root__').html() || '',
    language: targetLanguage,
    languageName: langName,
    languageLabel: LANGUAGE_LABELS[targetLanguage],
  };
}

// Рекурсивно собирает текстовые узлы, пропуская code/pre/script
function collectTextNodes($, el, result) {
  if (!el || !el.childNodes) return;
  for (const node of el.childNodes) {
    if (node.type === 'text') {
      const text = node.data || '';
      // Пропускаем пустые строки и одиночные пробелы
      if (text.trim().length > 1) {
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

// Разбиваем тексты на батчи и переводим параллельно
async function translateAllTexts(texts, langName) {
  const BATCH_SIZE = 60;       // строк на батч
  const BATCH_CHARS = 6000;    // символов на батч

  const batches = [];
  let batch = [];
  let chars = 0;

  for (const text of texts) {
    if ((batch.length >= BATCH_SIZE || chars + text.length > BATCH_CHARS) && batch.length > 0) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length > 0) batches.push(batch);

  // Все батчи параллельно
  const results = await Promise.all(batches.map(b => translateBatch(b, langName)));
  return results.flat();
}

async function translateBatch(texts, langName) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: `You translate Russian text strings to ${langName} for Bitrix24 documentation.
Return ONLY a valid JSON array of translated strings, same count and order as input.
Rules: keep Bitrix24, CRM, CoPilot, REST API unchanged. No explanations.`,
    messages: [{
      role: 'user',
      content: JSON.stringify(texts),
    }],
  });

  const raw = response.content[0].text.trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Ответ модели не является JSON-массивом');

  const parsed = JSON.parse(match[0]);

  // Если количество не совпадает — возвращаем оригиналы для несовпадающих
  const result = texts.map((orig, i) => parsed[i] || orig);
  return result;
}

module.exports = { translateContent, LANGUAGE_NAMES, LANGUAGE_LABELS };
