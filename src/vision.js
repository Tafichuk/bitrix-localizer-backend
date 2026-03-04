const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Analyzes a screenshot from the Russian Bitrix24 portal.
 * Returns a step-by-step Playwright action plan to recreate the same screenshot
 * on the Western portal, with all user-entered content translated to targetLanguage.
 *
 * Step types:
 *   { action: "goto",          path: "/crm/deal/list/" }
 *   { action: "click",         selector: ".css-selector", fallbackText: "Button text" }
 *   { action: "clickText",     text: "Visible button label" }
 *   { action: "fill",          selector: ".css", value: "Translated text", fallbacks: [".alt1", ".alt2"] }
 *   { action: "fillByLabel",   label: "Title", value: "Translated text" }
 *   { action: "select",        selector: "select.status", value: "In progress" }
 *   { action: "keyboard",      key: "Escape" }
 *   { action: "wait",          ms: 1000 }
 *   { action: "waitForSelector", selector: ".element" }
 *   { action: "scroll",        y: 300 }
 */
async function analyzeScreenshot(imageUrl, targetLanguage) {
  const imageData = await downloadImage(imageUrl);
  if (!imageData) throw new Error(`Cannot download image: ${imageUrl}`);

  const langLabels = {
    en: 'English', de: 'German', fr: 'French',
    es: 'Spanish', pt: 'Portuguese', pl: 'Polish', it: 'Italian',
  };
  const langName = langLabels[targetLanguage] || targetLanguage;

  const prompt = `You are analyzing a screenshot from a RUSSIAN Bitrix24 portal.
Your task: create a step-by-step Playwright action plan to recreate this exact screenshot on a Western (English-language) Bitrix24 portal, with all user-entered text content translated to ${langName}.

IMPORTANT DISTINCTIONS:
- Interface elements (buttons, menu labels, column headers) = part of Bitrix24 UI, do NOT put them in "fill" steps
- User-entered content (task titles, descriptions, CRM field values, names, comments, notes) = MUST be recreated in ${langName}

COMMON BITRIX24 URL PATHS:
/crm/deal/list/ — CRM Deals list
/crm/deal/kanban/ — CRM Deals Kanban
/crm/lead/list/ — Leads
/crm/contact/list/ — Contacts
/crm/company/list/ — Companies
/tasks/list/ — Tasks list
/tasks/ — Tasks
/im/ — Chat & Messages
/calendar/ — Calendar
/disk/ — Files & Disk
/stream/ — Activity Feed
/company/ — Employees
/timeman/ — Worktime
/bizproc/ — Workflows & Automation
/settings/ — Settings
/sites/ — Sites & Stores
/shop/ — Online Store
/ai/ — CoPilot AI
/telephony/ — Telephony
/report/ — Reports
/workgroups/ — Workgroups / Projects

COMMON BITRIX24 SELECTORS:
- CRM create button: .crm-btn-add, .ui-btn-success, [data-role="create-btn"]
- Task create: .tasks-task-create-btn, [data-action="create-task"]
- Task title input: input[name="TITLE"], .task-title-input
- Task description: .task-description-field .ql-editor, [data-entity="task-description"]
- CRM deal title: [data-cid="TITLE"] input, input[placeholder*="title" i], input[placeholder*="name" i]
- Comment/note input: .feed-add-post-form textarea, .livefeed-post-text
- Search input: input[type="search"], .search-input input
- Modal close: .popup-window-close-icon, .ui-popup-close
- Slide panel: .side-panel-wrapper

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "module": "Module name in English",
  "path": "/initial/navigation/path/",
  "description": "What is shown in this screenshot (max 80 chars, in English)",
  "hasUserContent": true,
  "steps": [
    {"action": "goto", "path": "/crm/deal/list/"},
    {"action": "clickText", "text": "Create Deal"},
    {"action": "fill", "selector": "input[placeholder*='title' i]", "value": "Translated deal title here", "fallbacks": ["[data-cid='TITLE'] input", ".crm-entity-field-title input"]},
    {"action": "fill", "selector": ".feed-add-post-form textarea", "value": "User comment text translated to ${langName}"},
    {"action": "wait", "ms": 1500}
  ]
}

Rules for steps:
1. First step MUST be "goto" with the correct path
2. Only include "fill" steps for USER-ENTERED content visible in the screenshot (not UI labels)
3. If no user content: hasUserContent=false, steps = [{"action":"goto","path":"..."}, {"action":"wait","ms":1500}]
4. Translate ALL user-entered text values to ${langName} — make them realistic and meaningful
5. Keep steps minimal — only what's needed to recreate what's visible`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Vision did not return JSON');

  const result = JSON.parse(jsonMatch[0]);

  // Ensure goto is first step
  if (!result.steps || result.steps.length === 0) {
    result.steps = [{ action: 'goto', path: result.path || '/' }];
  }
  if (result.steps[0].action !== 'goto') {
    result.steps.unshift({ action: 'goto', path: result.path || '/' });
  }

  // Ensure path starts with /
  if (!result.path || !result.path.startsWith('/')) result.path = '/';

  return result;
}

async function downloadImage(url) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const ct = resp.headers['content-type'] || 'image/png';
    const mediaType =
      ct.includes('jpeg') || ct.includes('jpg') ? 'image/jpeg' :
      ct.includes('webp') ? 'image/webp' :
      ct.includes('gif') ? 'image/gif' : 'image/png';
    return {
      base64: Buffer.from(resp.data).toString('base64'),
      mediaType,
    };
  } catch (err) {
    console.error(`[vision] Failed to download ${url}: ${err.message}`);
    return null;
  }
}

module.exports = { analyzeScreenshot };
