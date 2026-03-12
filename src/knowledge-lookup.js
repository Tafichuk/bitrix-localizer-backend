/**
 * ЭТАП 3: Поиск паттерна в базе знаний
 * Используется в computer-use-screenshot.js вместо navigation-planner.js
 * когда KB уже верифицирована.
 */
const fs = require('fs');
const path = require('path');

let kb = null;
let kbLoadedAt = 0;
const KB_TTL_MS = 5 * 60 * 1000; // перезагружать раз в 5 минут

function loadKB() {
  const now = Date.now();
  if (kb && now - kbLoadedAt < KB_TTL_MS) return kb;

  const kbPath = path.join(__dirname, '..', 'knowledge-base.json');
  if (!fs.existsSync(kbPath)) {
    kb = [];
    return kb;
  }

  try {
    const all = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    kb = all.filter(p => p.verified === true && !p.noScreenshots && p.id);
    kbLoadedAt = now;
    console.log(`📚 KB загружена: ${kb.length} верифицированных паттернов`);
  } catch (e) {
    console.warn('[kb] Ошибка чтения KB:', e.message);
    kb = [];
  }

  return kb;
}

/**
 * Ищет наиболее подходящий паттерн.
 * @param {string} section   — раздел из хлебных крошек статьи
 * @param {string} context   — текстовый контекст скрина
 * @param {string} alt       — alt-текст img
 * @returns {object|null}    — паттерн или null
 */
function findBestPattern(section, context, alt) {
  const patterns = loadKB();
  if (patterns.length === 0) return null;

  const secLow = (section || '').toLowerCase();
  const ctxLow = (context || '').toLowerCase();
  const altLow = (alt || '').toLowerCase();

  // Все слова из запроса для широкого матчинга
  const allQueryWords = `${ctxLow} ${altLow} ${secLow}`.split(/\s+/).filter(w => w.length > 3);

  const scored = patterns.map(p => {
    let score = 0;

    // Совпадение раздела (50 очков)
    const pSec = (p.section || '').toLowerCase();
    if (pSec === secLow) score += 50;
    else if (pSec.includes(secLow) || secLow.includes(pSec)) score += 25;

    // Совпадение контекста (до 40 очков)
    if (ctxLow && p.screenshotContext) {
      const pCtx = p.screenshotContext.toLowerCase();
      const words = ctxLow.split(/\s+/).filter(w => w.length > 4);
      const matches = words.filter(w => pCtx.includes(w)).length;
      score += Math.min(matches * 8, 40);
    }

    // Совпадение alt (15 очков)
    if (altLow && p.screenshotAlt) {
      const pAlt = p.screenshotAlt.toLowerCase();
      if (pAlt.includes(altLow) || altLow.includes(pAlt)) score += 15;
    }

    // Совпадение по pageTitle (до 40 очков) — компенсирует несовпадение секции
    if (p.pageTitle) {
      const pTitle = p.pageTitle.toLowerCase();
      const titleMatches = allQueryWords.filter(w => pTitle.includes(w)).length;
      score += Math.min(titleMatches * 10, 40);
      // Бонус за редкие/специфичные слова (>7 символов) — уникальные термины важнее раздела
      const rareMatches = allQueryWords.filter(w => w.length > 7 && pTitle.includes(w)).length;
      score += rareMatches * 25;
    }

    // Совпадение по articleTitle (до 30 очков)
    if (p.articleTitle) {
      const pArt = p.articleTitle.toLowerCase();
      const artMatches = allQueryWords.filter(w => pArt.includes(w)).length;
      score += Math.min(artMatches * 10, 30);
      const rareArtMatches = allQueryWords.filter(w => w.length > 7 && pArt.includes(w)).length;
      score += rareArtMatches * 20;
    }

    // Совпадение по keyElements (до 15 очков)
    if (p.keyElements && Array.isArray(p.keyElements)) {
      const keysText = p.keyElements.join(' ').toLowerCase();
      const keyMatches = allQueryWords.filter(w => keysText.includes(w)).length;
      score += Math.min(keyMatches * 5, 15);
    }

    // Простые паттерны надёжнее
    if (p.complexity === 'simple') score += 5;
    else if (p.complexity === 'complex') score -= 5;

    // Качество верификации
    score += (p.verificationScore || 0) * 0.2;

    return { pattern: p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 50) {
    console.log(`📚 KB match: "${best.pattern.pageTitle}" (score: ${Math.round(best.score)}, article: "${best.pattern.articleTitle?.slice(0, 50)}")`);
    return best.pattern;
  }

  console.log(`📚 KB: нет совпадений (лучший score: ${Math.round(scored[0]?.score ?? 0)})`);
  return null;
}

/**
 * Статистика базы знаний.
 */
function getKBStats() {
  const patterns = loadKB();
  const bySection = {};
  for (const p of patterns) {
    bySection[p.section] = (bySection[p.section] || 0) + 1;
  }
  return { total: patterns.length, bySection };
}

module.exports = { findBestPattern, loadKB, getKBStats };
