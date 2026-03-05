const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Analyzes a screenshot from the Russian Bitrix24 portal.
 * Returns structured navigation analysis + Playwright step plan.
 *
 * New step types (in addition to existing ones):
 *   { action: "waitNetworkIdle" }
 *   { action: "switchView",   viewType: "list|kanban|calendar" }
 *   { action: "expandMenu",   menuItem: "CRM" }
 *   { action: "openCreateForm" }
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
Your task: produce a precise Playwright action plan to reproduce this screenshot on a Western (English-language) Bitrix24 portal, translating all user-entered text to ${langName}.

═══ NAVIGATION STRUCTURE ════════════════════════════════════════════
Left-menu sections and their URLs:
  Feed / Activity     → /stream/
  Tasks               → /tasks/
  CRM                 → /crm/  (has sub-items below)
    ├─ Leads          → /crm/lead/list/
    ├─ Deals          → /crm/deal/list/   (kanban: /crm/deal/kanban/)
    ├─ Contacts       → /crm/contact/list/
    ├─ Companies      → /crm/company/list/
    ├─ Invoices       → /crm/invoice/list/
    ├─ Estimates      → /crm/quote/list/
    ├─ Products       → /crm/product/list/
    └─ CRM Settings   → /crm/configs/
  Projects/Groups     → /workgroups/
  Drive               → /disk/
  Calendar            → /calendar/
  Mail                → /mail/
  Chat                → /im/
  Telephony           → /telephony/
  HR / Employees      → /company/
  Time Tracking       → /timeman/
  Workflows           → /bizproc/
  Sites & Stores      → /sites/
  CoPilot AI          → /ai/
  Reports             → /report/
  Settings            → /settings/

═══ IMPORTANT DISTINCTIONS ══════════════════════════════════════════
- Bitrix24 UI labels (buttons, column headers, menu items) = DO NOT recreate in fill steps
- User-entered content (names, titles, descriptions, comments, field values) = MUST translate to ${langName}

═══ STEP TYPES AVAILABLE ════════════════════════════════════════════
{"action":"goto",            "path":"/crm/deal/list/"}
{"action":"waitNetworkIdle"}
{"action":"expandMenu",      "menuItem":"CRM"}
{"action":"switchView",      "viewType":"list"}        // list | kanban | calendar | gantt
{"action":"openCreateForm"}
{"action":"click",           "selector":".css", "fallbackText":"Button label"}
{"action":"clickText",       "text":"Visible text"}
{"action":"fill",            "selector":".css", "value":"translated text", "fallbacks":[".alt"]}
{"action":"fillByLabel",     "label":"Field label", "value":"translated text"}
{"action":"select",          "selector":"select.css", "value":"option value"}
{"action":"keyboard",        "key":"Escape"}
{"action":"wait",            "ms":1500}
{"action":"waitForSelector", "selector":".element"}
{"action":"scroll",          "y":300}

═══ COMMON SELECTORS ════════════════════════════════════════════════
View switchers:
  list view:   .ui-grid-header-btn, [data-id="list"], button[title*="List" i], .crm-toolbar-list-btn
  kanban view: [data-id="kanban"], button[title*="Kanban" i], .crm-toolbar-kanban-btn
  calendar:    [data-id="calendar"], button[title*="Calendar" i]

CRM:
  create button:   .crm-btn-add, [data-action="add"], button.ui-btn-success
  deal title:      [data-cid="TITLE"] input, input[placeholder*="title" i]
  stage select:    [data-cid="STAGE_ID"] select, .crm-entity-field-stage select

Tasks:
  create button:   .tasks-task-create-btn, [data-action="create-task"]
  title input:     input[name="TITLE"], .task-title-input
  description:     .task-description-field .ql-editor

Feed/post:
  comment input:   .feed-add-post-form textarea, .livefeed-post-text

General:
  search:          input[type="search"], .search-input input
  modal close:     .popup-window-close-icon, .ui-popup-close
  slide panel:     .side-panel-wrapper, .side-panel-content

═══ REQUIRED RESPONSE FORMAT ════════════════════════════════════════
Respond ONLY with valid JSON (no markdown, no explanation):
{
  "section": "CRM",
  "subsection": "Deals",
  "urlPath": "/crm/deal/list/",
  "viewType": "list",
  "description": "CRM Deals list view (max 80 chars, English)",
  "hasUserContent": false,
  "steps": [
    {"action": "goto", "path": "/crm/deal/list/"},
    {"action": "waitNetworkIdle"},
    {"action": "wait", "ms": 1500}
  ]
}

═══ STEP GENERATION RULES ═══════════════════════════════════════════
1. First step MUST be "goto" with the correct urlPath
2. Always add {"action":"waitNetworkIdle"} after every goto
3. If screenshot shows a sub-item of CRM (Deals, Leads, etc.) add {"action":"expandMenu","menuItem":"CRM"} as step 2
4. If a non-default view is active (kanban, calendar), add {"action":"switchView","viewType":"kanban"} after navigation
5. If a create/edit form is open, add {"action":"openCreateForm"} after navigation
6. Add "fill" steps ONLY for user-entered content visible in the screenshot — translate to ${langName}
7. If no user content: hasUserContent=false, omit fill steps
8. Translate ALL user-entered values to ${langName} (make them realistic)
9. Keep steps minimal — only what reproduces what's visible`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
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

  // Normalise: ensure steps array exists
  if (!result.steps || result.steps.length === 0) {
    result.steps = [
      { action: 'goto', path: result.urlPath || result.path || '/' },
      { action: 'waitNetworkIdle' },
      { action: 'wait', ms: 1500 },
    ];
  }

  // Ensure first step is goto
  if (result.steps[0].action !== 'goto') {
    result.steps.unshift({ action: 'goto', path: result.urlPath || result.path || '/' });
  }

  // Ensure waitNetworkIdle follows every goto (if not already there)
  const enriched = [];
  for (const step of result.steps) {
    enriched.push(step);
    if (step.action === 'goto') {
      const next = result.steps[result.steps.indexOf(step) + 1];
      if (!next || next.action !== 'waitNetworkIdle') {
        enriched.push({ action: 'waitNetworkIdle' });
      }
    }
  }
  result.steps = enriched;

  // Back-compat: populate .path for downstream consumers
  result.path = result.urlPath || result.path || '/';
  if (!result.path.startsWith('/')) result.path = '/';

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
