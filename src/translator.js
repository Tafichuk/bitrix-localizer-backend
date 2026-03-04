const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  pl: 'Polish',
  it: 'Italian',
};

const LANGUAGE_LABELS = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  pl: 'Polski',
  it: 'Italiano',
};

async function translateContent(article, targetLanguage) {
  const langName = LANGUAGE_NAMES[targetLanguage];
  if (!langName) throw new Error(`Unknown language: ${targetLanguage}`);

  // Translate title
  const titleResp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: 'You are a professional translator for Bitrix24 documentation. Translate ONLY the given text, return nothing else.',
    messages: [{ role: 'user', content: `Translate to ${langName}:\n${article.title}` }],
  });
  const translatedTitle = titleResp.content[0].text.trim();

  // Translate HTML content — chunk if too long (> 60k chars)
  const chunks = chunkHtml(article.contentHtml, 50000);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const resp = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: `You are a professional technical translator for Bitrix24 help documentation.
Translate the HTML content from Russian to ${langName}.
Rules:
- Preserve ALL HTML tags, attributes, and structure exactly
- Keep product names as-is: Bitrix24, CoPilot, CRM, REST API, etc.
- Translate UI labels and button names naturally for ${langName} speakers
- Do NOT translate content inside <code> or <pre> tags
- Do NOT translate URLs or email addresses
- Return ONLY the translated HTML, no explanations or markdown`,
      messages: [{
        role: 'user',
        content: `Translate this HTML to ${langName}:\n\n${chunk}`,
      }],
    });
    translatedChunks.push(resp.content[0].text.trim());
  }

  return {
    title: translatedTitle,
    contentHtml: translatedChunks.join('\n'),
    language: targetLanguage,
    languageName: LANGUAGE_NAMES[targetLanguage],
    languageLabel: LANGUAGE_LABELS[targetLanguage],
  };
}

function chunkHtml(html, maxChars) {
  if (html.length <= maxChars) return [html];

  const chunks = [];
  let start = 0;
  while (start < html.length) {
    let end = start + maxChars;
    if (end >= html.length) {
      chunks.push(html.slice(start));
      break;
    }
    // Find last closing tag before limit
    const lastTag = html.lastIndexOf('>', end);
    if (lastTag > start) end = lastTag + 1;
    chunks.push(html.slice(start, end));
    start = end;
  }
  return chunks;
}

module.exports = { translateContent, LANGUAGE_NAMES, LANGUAGE_LABELS };
