const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const sharp = require('sharp');

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

═══ NAVIGATION TYPES ════════════════════════════════════════════════
Set "navigationType" to one of:
  "left_menu" — page reached via left sidebar (most common)
  "widget"    — content shown after clicking a homepage widget (tariff, limits, demo banner)
  "modal"     — a modal/popup dialog open over another page
  "settings"  — page within /settings/ section
  "top_menu"  — reached via top bar / notification bell

Widget navigation examples (use navigationType="widget"):
  - "Мой тариф" / tariff info panel — shown after clicking tariff widget (bottom-right or top-right area)
  - Limits counter (Лимиты) — clicked from homepage widget
  - Demo period / trial expiry banners — click to open tariff upgrade screen
  For all widget screenshots: urlPath="/", widgetSelectors=[list of candidate CSS selectors]

Known widget selectors (provide the most likely ones in widgetSelectors):
  Tariff widget:  [".b24-tariff-info", ".tariff-block", "[class*='tariff']", ".b24net-tariff", ".feed-desktop__plan"]
  Limits widget:  [".b24-limits-widget", "[class*='limits']", ".feed-desktop-limits"]
  Demo banner:    [".b24-demo-panel", "[class*='demo']", ".feed-desktop__demo"]

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
{"action":"clickWidget",     "widgetSelectors":[".b24-tariff-info","[class*='tariff']"]}
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
  "navigationType": "left_menu",
  "widgetSelectors": [],
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
9. Keep steps minimal — only what reproduces what's visible
10. If navigationType="widget": urlPath="/", first goto "/", then wait 2000ms, then {"action":"clickWidget","widgetSelectors":[...]}
11. Always set "navigationType" — default to "left_menu" if unsure`;

  const response = await callWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
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

  // Ensure navigationType is set
  if (!result.navigationType) result.navigationType = 'left_menu';
  if (!result.widgetSelectors) result.widgetSelectors = [];

  return result;
}

// ─── Retry with exponential backoff on 429 ───────────────────────────────────

async function callWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const waitMs = Math.pow(2, i) * 5000; // 5s, 10s, 20s
        console.warn(`[vision] Rate limit 429, waiting ${waitMs / 1000}s (attempt ${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

// ─── Download + compress image ────────────────────────────────────────────────

async function downloadImage(url) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    // Compress: resize to max 800px wide, JPEG 60% quality
    let compressed;
    try {
      compressed = await sharp(Buffer.from(resp.data))
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    } catch {
      // sharp failed (e.g. GIF/SVG) — use original
      compressed = Buffer.from(resp.data);
    }

    const originalKb = Math.round(resp.data.byteLength / 1024);
    const compressedKb = Math.round(compressed.byteLength / 1024);
    console.log(`[vision] Image compressed: ${originalKb}KB → ${compressedKb}KB`);

    return { base64: compressed.toString('base64'), mediaType: 'image/jpeg' };
  } catch (err) {
    console.error(`[vision] Failed to download ${url}: ${err.message}`);
    return null;
  }
}

module.exports = { analyzeScreenshot };
