const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Navigation map (built by scripts/build-nav-map.js) ──────────────────────
let navMap = null;
try {
  navMap = require(path.join(__dirname, '..', 'navigation-map.json'));
  console.log(`[vision] Navigation map loaded: ${Object.keys(navMap.urlPatternMap || {}).length} URL patterns`);
} catch {
  console.log('[vision] Navigation map not found — full AI analysis will be used for every image');
}

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

═══ CRITICAL SECTION → URL MAPPING (always use these, no exceptions) ═══
Лента / Лента новостей / Feed / Activity Stream / "MESSAGE СОБЫТИЕ ОПРОС" buttons → /stream/
Сотрудники / Employees / HR / Staff / People                                        → /company/
CRM                                                                                  → /crm/
Сделки / Deals                                                                       → /crm/deal/list/
Лиды / Leads                                                                         → /crm/lead/list/
Контакты / Contacts                                                                  → /crm/contact/list/
Компании / Companies                                                                 → /crm/company/list/
Счета / Invoices                                                                     → /crm/invoice/list/
Задачи / Tasks                                                                       → /tasks/
Проекты / Workgroups / Groups                                                        → /workgroups/
Диск / Drive                                                                         → /disk/
Календарь / Calendar                                                                 → /calendar/
Почта / Mail                                                                         → /mail/
Чат / Chat / Messenger / IM                                                          → /im/
Телефония / Telephony                                                                → /telephony/
Маркетинг / Marketing                                                                → /marketing/
Аналитика / Analytics / Sales Funnel                                                 → /crm/analytics/
Сайты / Sites                                                                        → /sites/
База знаний / Knowledge Base                                                         → /knowledge/
CoPilot / Копилот                                                                    → /ai/
Учёт рабочего времени / Time Tracking                                                → /timeman/
Бизнес-процессы / Workflows / Bizproc                                                → /bizproc/
Склад / Inventory / Catalog                                                          → /inventory/
Настройки / Settings                                                                 → /settings/
Мой тариф / My Plan / Тариф / Tariff / Лимиты / Limits / Demo banner                → navigationType="widget", urlPath="/"

⚠️ FEED RULE: If the screenshot shows a text compose area with buttons like
   "MESSAGE", "СОБЫТИЕ", "ЗАДАЧА", "ОПРОС", "ФАЙЛ" OR shows a news/activity stream
   with posts from colleagues — urlPath MUST be "/stream/", NEVER "/company/".

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

═══ SPECIFIC UI ELEMENTS (set elementToShow + additionalActions) ═══
Scan the screenshot for these specific elements and set accordingly:
  Pinned messages banner / закреплённые сообщения (pin/булавка icon visible)
    → elementToShow: "pinned_message_banner", additionalActions: ["scroll_to_pinned"]
  Favorites filter open / фильтр Избранное активен
    → elementToShow: "favorites_filter", additionalActions: ["click_filter_button", "select_favorites_filter"]
  "Ещё" / "More" menu open (dropdown with extra options)
    → elementToShow: "more_menu_open", additionalActions: ["click_more_menu"]
  Collapsed/expanded post section
    → elementToShow: "collapsed_posts", additionalActions: ["expand_pinned_messages"]
  Search bar open
    → elementToShow: "search_open", additionalActions: []
  Notification panel / колокольчик open
    → elementToShow: "notification_panel", additionalActions: []
  No specific element — just the default page view
    → elementToShow: null, additionalActions: []

═══ REQUIRED RESPONSE FORMAT ════════════════════════════════════════
Respond ONLY with valid JSON (no markdown, no explanation):
{
  "section": "CRM",
  "subsection": "Deals",
  "urlPath": "/crm/deal/list/",
  "viewType": "list",
  "navigationType": "left_menu",
  "widgetSelectors": [],
  "elementToShow": null,
  "additionalActions": [],
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
11. Always set "navigationType" — default to "left_menu" if unsure
12. Set elementToShow and additionalActions based on SPECIFIC UI ELEMENTS rules above`;

  const response = await callWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  // Проблема 1: robustly parse JSON, never crash on malformed output
  const result = parseClaudeJSON(text);

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

  // Enrich with navigation map data (validated from bulk analysis)
  enrichWithNavMap(result);

  return result;
}

// ─── Robust JSON parser (Problem 1) ──────────────────────────────────────────

const VISION_FALLBACK = {
  navigationType: 'left_menu',
  urlPath: '/stream/',
  section: 'Feed',
  subsection: null,
  viewType: 'list',
  widgetSelectors: [],
  elementToShow: null,
  additionalActions: [],
  description: 'Feed (fallback — JSON parse failed)',
  hasUserContent: false,
  steps: [
    { action: 'goto', path: '/stream/' },
    { action: 'waitNetworkIdle' },
    { action: 'wait', ms: 1500 },
  ],
};

function parseClaudeJSON(text) {
  // Strip markdown code blocks if present
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Attempt 1: direct parse
  try { return JSON.parse(text); } catch {}

  // Extract the outermost {...} object
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    console.warn('[vision] parseClaudeJSON: no JSON object found. Raw:', text.slice(0, 200));
    return { ...VISION_FALLBACK };
  }
  let s = m[0];

  // Attempt 2: parse extracted block
  try { return JSON.parse(s); } catch {}

  // Attempt 3: fix trailing commas
  let fixed = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch {}

  // Attempt 4: escape literal control characters inside JSON string values
  // Matches "..." including escaped sequences, fixes unescaped \n \r \t inside
  try {
    let fixed2 = fixed.replace(/"((?:[^"\\]|\\.)*)"/gs, (full, inner) => {
      const escaped = inner
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      return `"${escaped}"`;
    });
    return JSON.parse(fixed2);
  } catch {}

  // Attempt 5: collapse all whitespace (drastic but handles most layout issues)
  try {
    let fixed3 = s
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed3);
  } catch {}

  // Fallback: never crash, return safe default
  console.warn('[vision] parseClaudeJSON: all attempts failed. Raw:', text.slice(0, 300));
  return { ...VISION_FALLBACK };
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

// ─── Nav map enrichment ────────────────────────────────────────────────────────

/**
 * Enriches a Vision AI result with data from the navigation map.
 * Uses longest-prefix matching on urlPath so /crm/deal/list/ matches /crm/.
 * Merges navigationType (map wins if AI returned default 'left_menu'),
 * and appends any known widgetSelectors.
 */
function enrichWithNavMap(result) {
  if (!navMap || !navMap.urlPatternMap) return;

  const urlPath = result.urlPath || result.path || '/';

  // Exact match first
  let match = navMap.urlPatternMap[urlPath];

  // Longest-prefix match (skip the bare "/" catch-all unless nothing else fits)
  if (!match) {
    let bestLen = 0;
    for (const [pattern, data] of Object.entries(navMap.urlPatternMap)) {
      if (pattern === '/') continue; // skip generic fallback for now
      if (urlPath.startsWith(pattern) && pattern.length > bestLen) {
        match = data;
        bestLen = pattern.length;
      }
    }
  }

  // Final fallback: bare "/"
  if (!match) match = navMap.urlPatternMap['/'];

  if (!match) return;

  // Only override navigationType if AI returned the generic default and map has something specific
  if (result.navigationType === 'left_menu' && match.navigationType && match.navigationType !== 'left_menu') {
    result.navigationType = match.navigationType;
    console.log(`[vision] navMap override navigationType → ${match.navigationType} for ${urlPath}`);
  }

  // Merge widgetSelectors from map
  if (match.widgetSelectors && match.widgetSelectors.length > 0) {
    result.widgetSelectors = [...new Set([...(result.widgetSelectors || []), ...match.widgetSelectors])];
  }

  // Set menuSection hint if AI left it empty
  if (!result.section && match.section) {
    result.section = match.section;
  }
}

module.exports = { analyzeScreenshot };
