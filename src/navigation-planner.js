const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { findBestPattern } = require('./knowledge-lookup');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PLAN_TIMEOUT = 30_000;

const PORTAL_WIDTH  = 1280;
const PORTAL_HEIGHT = 800;

// ─── navigation_map.json loader (TTL 5 min) ────────────────────────────────
let _navMap = null;
let _navMapLoadedAt = 0;
const NAV_MAP_TTL = 5 * 60 * 1000;

function loadNavMap() {
  const now = Date.now();
  if (_navMap && now - _navMapLoadedAt < NAV_MAP_TTL) return _navMap;
  const p = path.join(__dirname, '..', '..', 'data', 'navigation_map.json');
  try {
    _navMap = JSON.parse(fs.readFileSync(p, 'utf8'));
    _navMapLoadedAt = now;
    const total = Object.values(_navMap).reduce((s, v) => s + (v.states?.length || 0), 0);
    console.log(`[nav_map] Loaded: ${Object.keys(_navMap).length} sections, ${total} states`);
  } catch (e) {
    console.warn('[nav_map] Could not load navigation_map.json:', e.message);
    _navMap = {};
  }
  return _navMap;
}

/**
 * Searches navigation_map.json for the best state matching the screenshot context.
 * Uses only screenshotContext + screenshotAlt (NOT articleSection) to avoid false
 * positives from the "Feed" fallback section name polluting keyword matches.
 *
 * Scoring rules:
 *  - keywords_ru match: 2 pts   (Cyrillic/specific terms)
 *  - keywords_en match: 1 pt    (generic English terms)
 *  - Each unique keyword counted at most once (deduplication prevents double-counting
 *    when the same word appears in both keywords_ru and keywords_en)
 *  - Minimum score to return a match: 1 pt
 *
 * Returns the state with the highest score, or null if haystack is empty.
 */
function findNavMapMatch(screenshotContext, screenshotAlt, articleSection) {
  const navMap = loadNavMap();
  if (!navMap || Object.keys(navMap).length === 0) return null;

  // Use screenshot text only — do NOT include articleSection to avoid false positives
  // from the "Feed" fallback name matching messenger states.
  const haystack = `${screenshotContext || ''} ${screenshotAlt || ''}`.toLowerCase().trim();

  if (!haystack) {
    console.log('[nav_map] Empty context+alt — no match possible');
    return null;
  }

  let bestScore = 0;
  let bestState = null;
  let bestSection = null;

  for (const [sectionKey, sectionData] of Object.entries(navMap)) {
    for (const state of (sectionData.states || [])) {
      // Deduplicate: collect each unique matched keyword with its max point value.
      // This prevents "feed" appearing in both keywords_ru and keywords_en from
      // scoring 3 (2+1) instead of the correct 2.
      const matched = new Map(); // keyword → max_pts
      for (const kw of (state.keywords_ru || [])) {
        const k = kw.toLowerCase();
        if (haystack.includes(k)) matched.set(k, Math.max(matched.get(k) || 0, 2));
      }
      for (const kw of (state.keywords_en || [])) {
        const k = kw.toLowerCase();
        if (haystack.includes(k)) matched.set(k, Math.max(matched.get(k) || 0, 1));
      }
      const score = Array.from(matched.values()).reduce((s, v) => s + v, 0);
      if (score > bestScore) {
        bestScore = score;
        bestState = state;
        bestSection = sectionKey;
      }
    }
  }

  if (bestScore >= 2 && bestState) {
    console.log(`[nav_map] ✅ Match: "${bestState.label}" (section: ${bestSection}, score: ${bestScore})`);
    return bestState;
  }

  console.log(`[nav_map] No match (best score: ${bestScore})`);
  return null;
}

/**
 * Converts a navigation_map state into a navigation plan.
 */
function navMapStateToPlan(state) {
  return {
    url: state.url,
    waitFor: null,
    steps: (state.click_sequence || []).map(c => ({
      description: c.label || '',
      action: 'click',
      target: c.selector || c.label || '',
      x: 0,
      y: 0,
      waitMs: 1200,
    })),
    screenshotTiming: 'after_all',
    notes: `[NavMap] ${state.label}`,
    _fromNavMap: true,
  };
}

/**
 * Конвертирует KB-паттерн в формат плана навигации.
 * Ключи паттерна: portalUrl, waitSelector, steps[{action,approximateX,approximateY,waitAfterMs,description,targetElement}]
 */
function patternToPlan(pattern) {
  return {
    url: pattern.portalUrl || '/stream/',
    waitFor: pattern.waitSelector || null,
    steps: (pattern.steps || []).map(s => ({
      description: s.description || s.targetElement || '',
      action: s.action || 'click',
      target: s.targetElement || s.description || '',
      x: s.approximateX || 0,
      y: s.approximateY || 0,
      waitMs: s.waitAfterMs || 800,
    })),
    screenshotTiming: 'after_all',
    notes: `[KB] ${pattern.interfaceState || ''}. Key elements: ${(pattern.keyElements || []).join(', ')}`,
    _fromKB: true,
    _kbScore: pattern.verificationScore,
  };
}

// Ключевые слова для страницы профиля пользователя
const PROFILE_KEYWORDS = [
  'profile', 'my page', 'security', 'synchronization', 'synchronize',
  'carddav', 'caldav', 'personal settings', 'mon profil', 'sécurité',
  'two-factor', 'authentication', 'password', 'access log', 'sessions',
];

/**
 * Определяет нужна ли страница профиля (/company/personal/user/1/).
 */
function isProfilePage(section, context, alt) {
  const text = `${section} ${context} ${alt}`.toLowerCase();
  return PROFILE_KEYWORDS.some(kw => text.includes(kw));
}

/**
 * Анализирует оригинальный скрин и составляет пошаговый план навигации.
 * Сначала ищет в KB, fallback — Claude Sonnet.
 * @param {string} originalScreenshotBase64 - base64 JPEG (1280px, без доп. сжатия)
 * @param {string} articleSection - раздел статьи из хлебных крошек
 * @param {string} screenshotContext - контекст скрина (параграф рядом с img)
 * @param {string} screenshotAlt - alt текст img
 * @param {string} [articleUrl=''] - URL исходной статьи helpdesk (опционально)
 * @param {string} [articleTitle=''] - заголовок статьи (опционально)
 * @returns {object|null} план навигации или null при ошибке
 */
async function planNavigation(originalScreenshotBase64, articleSection, screenshotContext, screenshotAlt, articleUrl = '', articleTitle = '') {
  // ── Спецобработчик: страница профиля пользователя ────────────────────────────
  if (isProfilePage(articleSection, screenshotContext, screenshotAlt)) {
    console.log('[planner] 👤 Profile page detected → /company/personal/user/1/');
    return {
      url: '/company/personal/user/1/',
      waitFor: '.profile-page, .user-profile, [data-page="profile"]',
      steps: [],
      screenshotTiming: 'after_all',
      notes: 'User profile page. Claude should find the correct tab (Sécurité, Synchronisation, etc.) based on the TARGET image.',
      _profilePage: true,
    };
  }

  // ── Сначала ищем в navigation_map.json ──────────────────────────────────────
  const navMapState = findNavMapMatch(screenshotContext, screenshotAlt, articleSection);
  if (navMapState) {
    const plan = navMapStateToPlan(navMapState);
    console.log(`[planner] ✅ NavMap hit: ${navMapState.label} → ${navMapState.url}`);
    return plan;
  }

  console.warn(`[planner] ⚠️ No nav_map match for: ${`${screenshotContext || screenshotAlt || articleSection}`.slice(0, 50)}`);

  // ── Затем ищем в базе знаний ─────────────────────────────────────────────────
  // Guard: helpdesk breadcrumbs are JS-rendered so section is ALWAYS "Feed" (fallback).
  // In that case KB scoring is dominated by the section match (+50 pts) and returns
  // Feed patterns regardless of the actual screenshot content → false positives.
  // When section is the fallback we skip KB entirely and let Claude see the real screenshot.
  // Exception: if we have a non-empty context paragraph (>10 chars), KB may still be useful.
  const isFallbackSection = !articleSection || articleSection === 'Feed' || articleSection === 'Лента';
  const hasContext = screenshotContext && screenshotContext.length > 10;

  const kbPattern = (isFallbackSection && !hasContext)
    ? (() => { console.log('[planner] KB skipped — fallback section (breadcrumbs not loaded)'); return null; })()
    : findBestPattern(articleSection, screenshotContext, screenshotAlt);

  if (kbPattern) {
    const plan = patternToPlan(kbPattern);
    console.log(`[planner] ✅ KB hit (score ${kbPattern.verificationScore}%): ${kbPattern.pageTitle}`);
    return plan;
  }

  console.log('[planner] KB miss → Claude Sonnet...');

  // Build context block — include article URL and title when available for better Claude accuracy
  const contextLines = [
    `Article section: ${articleSection || 'unknown (breadcrumbs not loaded via JS)'}`,
    articleUrl   ? `Article URL: ${articleUrl}`     : null,
    articleTitle ? `Article title: ${articleTitle}` : null,
    screenshotAlt     ? `Image alt text: ${screenshotAlt}`            : null,
    screenshotContext ? `Image surrounding text: ${screenshotContext}` : null,
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are analyzing a Bitrix24 interface screenshot from a Russian helpdesk article.
${contextLines}

IMPORTANT: The target portal viewport is ${PORTAL_WIDTH}x${PORTAL_HEIGHT}px.
The screenshot you see is from a Russian Bitrix24 portal with the same layout.
Provide x,y coordinates as if clicking on a ${PORTAL_WIDTH}x${PORTAL_HEIGHT} viewport.

Analyze this screenshot and return a JSON navigation plan to reproduce this exact UI state.
Use the article URL and title (if provided) as strong hints about which Bitrix24 section this belongs to.

Bitrix24 URL map:
- Feed / Лента / Actualités → /stream/
- CRM Deals / Сделки → /crm/deal/
- CRM Contacts / Контакты → /crm/contact/
- CRM Leads / Лиды → /crm/leads/
- Tasks / Задачи → /tasks/
- Calendar / Календарь → /calendar/
- Drive / Диск → /disk/
- Employees / Сотрудники → /company/
- User profile / Профиль пользователя / Mon profil → /company/personal/user/1/
- Profile Security tab / Безопасность → /company/personal/user/1/ (then click Security tab)
- Profile Sync/CardDAV tab → /company/personal/user/1/ (then click Synchronization tab)
- Settings / Настройки → /settings/
- Messenger / Чат → /im/
- Knowledge base / База знаний → /knowledge/
- Telephony / Телефония → /telephony/
- Automation / Автоматизация → /bizproc/
- Marketing → /marketing/

Return ONLY valid JSON (no markdown, no code fences):
{
  "url": "/stream/",
  "waitFor": "CSS selector to wait for after page loads, or null",
  "steps": [
    {
      "description": "what to do in plain english",
      "action": "click|hover|scroll|wait",
      "target": "describe the element visually",
      "x": 0,
      "y": 0,
      "waitMs": 800
    }
  ],
  "screenshotTiming": "after_all",
  "notes": "any special instructions about the UI state shown"
}`,
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: originalScreenshotBase64,
              },
            },
          ],
        }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('planNavigation timeout')), PLAN_TIMEOUT)),
    ]);
  } catch (e) {
    console.warn('[planner] API error:', e.message?.slice(0, 120));
    return null;
  }

  try {
    const text = response.content[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[planner] No JSON in response'); return null; }
    const plan = JSON.parse(match[0]);
    return plan;
  } catch (e) {
    console.warn('[planner] JSON parse error:', e.message);
    return null;
  }
}

module.exports = { planNavigation, patternToPlan, findNavMapMatch, navMapStateToPlan };
