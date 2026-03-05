const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Navigation map ────────────────────────────────────────────────────────────
const NAV_MAP_PATH = path.join(__dirname, '..', 'navigation-map.json');
let navMap = {};
try {
  navMap = JSON.parse(fs.readFileSync(NAV_MAP_PATH, 'utf8'));
  console.log(`[vision] Navigation map loaded: ${Object.keys(navMap).length} sections`);
} catch {
  console.warn('[vision] navigation-map.json not found — will use Feed as fallback');
}

const SECTION_KEYS = Object.keys(navMap);
const FALLBACK_SECTION = 'Feed';
const FALLBACK_STEP = 'default';

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Analyzes a screenshot from the Russian Bitrix24 helpdesk.
 * NEW APPROACH: Vision only classifies (section + step).
 * Navigation steps come from navigation-map.json — no AI-generated Playwright code.
 *
 * Returns:
 *   { section, step, description, path, urlPath }
 */
async function analyzeScreenshot(imageUrl, _targetLanguage) {
  const imageData = await downloadImage(imageUrl);
  if (!imageData) throw new Error(`Cannot download image: ${imageUrl}`);

  const sectionList = SECTION_KEYS.length
    ? SECTION_KEYS.join(', ')
    : 'Feed, CRM_Deals, CRM_Leads, CRM_Contacts, CRM_Companies, CRM_Settings, Tasks, Calendar, Drive, Messenger, Employees, Telephony, Settings, Tariff_Widget, Analytics, Marketing, Knowledge_Base, Automation, Contact_Center, CoPilot, Inventory, Timeman';

  // Build step hints from the map so Claude knows what steps exist per section
  const stepHints = Object.entries(navMap)
    .map(([sec, cfg]) => {
      const steps = Object.keys(cfg.steps || {}).filter(s => s !== 'default');
      return steps.length ? `  ${sec}: ${steps.join(', ')}` : null;
    })
    .filter(Boolean)
    .join('\n');

  const prompt = `You are analyzing a screenshot from a RUSSIAN Bitrix24 helpdesk article.
Your task: identify which section of the Bitrix24 portal is shown and which specific step/state is visible.

═══ AVAILABLE SECTIONS ══════════════════════════════════════
${sectionList}

═══ AVAILABLE STEPS PER SECTION ════════════════════════════
Every section has "default" (standard page view). Special steps:
${stepHints}

═══ CLASSIFICATION RULES ════════════════════════════════════
Feed        — compose area with MESSAGE/СОБЫТИЕ/ЗАДАЧА/ОПРОС buttons, OR activity stream with posts
CRM_Deals   — list or kanban of deals/сделки
CRM_Leads   — list of leads/лиды
CRM_Contacts— list of contacts/контакты
CRM_Companies—list of companies/компании
CRM_Settings— CRM configuration/settings page
Tasks       — task list or task board
Calendar    — calendar view with events
Drive       — file/folder list
Messenger   — chat/messenger interface
Employees   — employee list with columns like Department, Email (NOT the Feed!)
Telephony   — telephony/phone settings
Settings    — portal settings pages
Tariff_Widget — tariff/plan/limits widget OR demo period banner
Analytics   — analytics charts, sales funnel, reports
Marketing   — marketing campaigns
Knowledge_Base — wiki / knowledge base articles
Automation  — bizproc / automation rules
Contact_Center — contact center / open channels
CoPilot     — AI CoPilot interface
Inventory   — warehouse / inventory management
Timeman     — time tracking

STEP RULES:
- "default" = standard page view, nothing special open
- "pinned_messages" = pin icon or pinned message banner visible at top of Feed
- "favorites_filter" = favorites/избранное filter is active or its dropdown is open
- "kanban_view" = kanban board is active (cards in columns)
- "list_view" = list/table view is active
- "create_deal/create_task/create_contact/create_lead" = creation form is open
- "settings" = settings panel is open within the section
- "structure" = org structure chart is shown
- "limits" = limits page or limits counter widget

⚠️ CRITICAL: If compose area with message buttons OR activity posts = Feed (NOT Employees)
⚠️ CRITICAL: Employee list with table columns = Employees (NOT Feed)

═══ RESPONSE FORMAT ═════════════════════════════════════════
Respond ONLY with valid JSON, no markdown, no explanation:
{
  "section": "Feed",
  "step": "default",
  "description": "Activity feed showing posts (max 80 chars)"
}`;

  const response = await callWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  const parsed = parseClaudeJSON(text);

  // Validate section exists in map; fall back gracefully
  const section = (parsed.section && navMap[parsed.section]) ? parsed.section : FALLBACK_SECTION;
  const sectionCfg = navMap[section] || {};
  const availableSteps = Object.keys(sectionCfg.steps || {});
  const step = availableSteps.includes(parsed.step) ? parsed.step : FALLBACK_STEP;

  const urlPath = sectionCfg.urlPath || '/stream/';
  const description = parsed.description || `${section} — ${step}`;

  console.log(`[vision] ${section}/${step} → ${urlPath} | "${description}"`);

  return {
    section,
    step,
    description,
    urlPath,
    path: urlPath, // back-compat with index.js filter: s.analysis.path
  };
}

// ─── Robust JSON parser ────────────────────────────────────────────────────────

const VISION_FALLBACK_OBJ = {
  section: FALLBACK_SECTION,
  step: FALLBACK_STEP,
  description: 'Feed (fallback — JSON parse failed)',
};

function parseClaudeJSON(text) {
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Attempt 1: direct
  try { return JSON.parse(text); } catch {}

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    console.warn('[vision] parseClaudeJSON: no JSON found. Raw:', text.slice(0, 200));
    return { ...VISION_FALLBACK_OBJ };
  }
  let s = m[0];

  // Attempt 2: extracted block
  try { return JSON.parse(s); } catch {}

  // Attempt 3: fix trailing commas
  let fixed = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch {}

  // Attempt 4: escape literal control chars inside strings
  try {
    let fixed2 = fixed.replace(/"((?:[^"\\]|\\.)*)"/gs, (full, inner) => {
      const esc = inner
        .replace(/\r\n/g, '\\n').replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r').replace(/\t/g, '\\t')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      return `"${esc}"`;
    });
    return JSON.parse(fixed2);
  } catch {}

  // Attempt 5: collapse all whitespace
  try {
    let fixed3 = s
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed3);
  } catch {}

  console.warn('[vision] parseClaudeJSON: all attempts failed. Raw:', text.slice(0, 300));
  return { ...VISION_FALLBACK_OBJ };
}

// ─── Retry with exponential backoff on 429 ────────────────────────────────────

async function callWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const waitMs = Math.pow(2, i) * 5000;
        console.warn(`[vision] Rate limit 429, waiting ${waitMs / 1000}s (attempt ${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

// ─── Download + compress image ─────────────────────────────────────────────────

async function downloadImage(url) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    let compressed;
    try {
      compressed = await sharp(Buffer.from(resp.data))
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    } catch {
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
