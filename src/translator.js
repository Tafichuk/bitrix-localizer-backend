const OpenAI = require('openai');

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const LANGUAGE_NAMES = {
  en: 'English', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', pl: 'Polish', it: 'Italian',
};
const LANGUAGE_LABELS = {
  en: 'English', de: 'Deutsch', fr: 'Français',
  es: 'Español', pt: 'Português', pl: 'Polski', it: 'Italiano',
};

async function translateArticle(blocks, languages) {
  const textsJson = JSON.stringify(blocks.map(b => b.text));

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'system',
      content: `Translate Bitrix24 helpdesk article from Russian.
Return ONLY a JSON object where keys are language codes and
values are arrays of translated texts in same order as input.
Keep HTML tags unchanged. Keep technical terms: CRM, Bitrix24, CoPilot, REST API, etc.
Languages to translate: ${languages.join(', ')}`,
    }, {
      role: 'user',
      content: textsJson,
    }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  return JSON.parse(response.choices[0].message.content);
}

// Main entry point used by index.js — translates one article to one language
async function translateContent(article, targetLanguage) {
  const langName = LANGUAGE_NAMES[targetLanguage];
  if (!langName) throw new Error(`Unknown language: ${targetLanguage}`);

  // Build flat list of text items: [title, ...text nodes from HTML]
  const { parseTextBlocks, applyTranslations } = require('./translator-dom');
  const blocks = [{ text: article.title }, ...parseTextBlocks(article.contentHtml)];

  const result = await translateArticle(blocks, [targetLanguage]);
  const translated = result[targetLanguage];
  if (!Array.isArray(translated) || translated.length < 1) {
    throw new Error(`OpenAI returned no translations for ${targetLanguage}`);
  }

  const translatedTitle = translated[0] || article.title;
  const translatedHtml = applyTranslations(article.contentHtml, blocks.slice(1), translated.slice(1));

  return {
    title: translatedTitle,
    contentHtml: translatedHtml,
    language: targetLanguage,
    languageName: langName,
    languageLabel: LANGUAGE_LABELS[targetLanguage],
  };
}

// Batch translate all languages in one API call
async function translateContentBatch(article, languages) {
  const { parseTextBlocks, applyTranslations } = require('./translator-dom');
  const blocks = [{ text: article.title }, ...parseTextBlocks(article.contentHtml)];

  const result = await translateArticle(blocks, languages);

  return languages.reduce((acc, lang) => {
    const translated = result[lang];
    if (!Array.isArray(translated) || translated.length < 1) return acc;
    acc[lang] = {
      title: translated[0] || article.title,
      contentHtml: applyTranslations(article.contentHtml, blocks.slice(1), translated.slice(1)),
      language: lang,
      languageName: LANGUAGE_NAMES[lang],
      languageLabel: LANGUAGE_LABELS[lang],
    };
    return acc;
  }, {});
}

module.exports = { translateContent, translateContentBatch, translateArticle, LANGUAGE_NAMES, LANGUAGE_LABELS };
