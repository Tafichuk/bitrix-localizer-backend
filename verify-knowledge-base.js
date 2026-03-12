#!/usr/bin/env node
/**
 * ЭТАП 2: Верификация базы знаний (двухуровневая)
 *
 * Уровень 3 (Уровень A — лучший): complexity: "simple" + isStaticPage: true
 *   → открыть страницу + сравнить скрин с оригиналом (Claude Haiku), порог 40%
 *
 * Уровень 1 (Уровень B): isStaticPage: true (не simple)
 *   → просто проверить что страница открылась без 404 → score: 75
 *
 * Уровень 2 (Уровень C): isStaticPage: false или complexity: "complex"
 *   → принять без верификации → score: 50
 *
 * Возобновляемый. Запуск: node verify-knowledge-base.js
 * Тест: LIMIT=20 node verify-knowledge-base.js
 */
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORTAL_URL = process.env.PORTAL_URL || 'https://testportal.bitrix24.com';
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : Infinity;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Загрузка авторизации ──────────────────────────────────────────────────────

function loadCookies() {
  const b64 = process.env.PORTAL_AUTH_JSON;
  if (!b64) { console.warn('⚠️  PORTAL_AUTH_JSON не задан'); return []; }
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return json.cookies || [];
  } catch { return []; }
}

// ── Определение уровня верификации ───────────────────────────────────────────

function getVerifyLevel(pattern) {
  const isSimple = pattern.complexity === 'simple';
  const isStatic = pattern.isStaticPage === true;
  const isComplex = pattern.complexity === 'complex';

  if (isSimple && isStatic) return 'screenshot'; // Level 3 — сравнение скринов
  if (isStatic) return 'url';                    // Level 1 — проверка URL
  if (!isStatic || isComplex) return 'auto';     // Level 2 — авто-принятие
  return 'auto';
}

// ── Навигация на страницу ─────────────────────────────────────────────────────

async function navigateToPattern(page, pattern) {
  const targetUrl = `${PORTAL_URL}${pattern.portalUrl}`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (pattern.waitSelector) {
    await page.waitForSelector(pattern.waitSelector, { timeout: 8000 }).catch(() => {});
  }

  // Координаты из 640px изображений → масштаб на 1280px браузер
  const SCALE = DISPLAY_WIDTH / 640;

  for (const step of (pattern.steps || [])) {
    const x = Math.round((step.approximateX || 0) * SCALE);
    const y = Math.round((step.approximateY || 0) * SCALE);
    const wait = step.waitAfterMs || 800;

    switch (step.action) {
      case 'click':
        if (x && y) await page.mouse.click(x, y);
        break;
      case 'hover':
        if (x && y) await page.mouse.move(x, y);
        break;
      case 'scroll':
        await page.mouse.wheel(0, 300);
        break;
      case 'wait':
        await page.waitForTimeout(wait);
        continue;
      case 'navigate':
        if (step.url) {
          await page.goto(`${PORTAL_URL}${step.url}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForLoadState('networkidle').catch(() => {});
        }
        break;
      default:
        break;
    }
    await page.waitForTimeout(wait);
  }
}

// ── Уровень 1: проверка что URL открывается (не 404) ─────────────────────────

async function verifyByUrl(page, pattern) {
  try {
    const targetUrl = `${PORTAL_URL}${pattern.portalUrl}`;
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    const status = response?.status() || 0;

    // Проверяем редиректы на ошибочные страницы
    const isError = finalUrl.includes('/404') || finalUrl.includes('/error') ||
                    finalUrl.includes('login') || status === 404 || status >= 500;

    if (isError) {
      return { verified: false, score: 0, reason: `Error page: ${finalUrl.slice(-50)}` };
    }

    return { verified: true, score: 75, reason: `Page opened successfully (${status})` };
  } catch (e) {
    return { verified: false, score: 0, reason: e.message.slice(0, 80) };
  }
}

// ── Уровень 3: сравнение скринов через Claude ─────────────────────────────────

async function compareScreenshots(origBase64, resultBase64) {
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are comparing two Bitrix24 portal screenshots.
IMAGE 1 = TARGET (from English helpdesk article)
IMAGE 2 = RESULT (current state of French portal)

Question: Does IMAGE 2 show the SAME Bitrix24 section/feature as IMAGE 1?

Rules:
- IGNORE: dates, times, language, usernames, avatar photos
- IGNORE: minor UI differences between versions
- FOCUS ON: which section is open, what feature is shown
- score 80-100: same section AND same feature visible
- score 50-79: same section but different state
- score 0-49: completely different section

If IMAGE 1 shows a person's photo (not interface) → score: 0, match: false

Reply ONLY with JSON: {"match": true/false, "score": 0-100, "reason": "one line"}`,
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: origBase64 } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: resultBase64 } },
      ],
    }],
  });

  const text = resp.content[0].text;
  const json = text.match(/\{[\s\S]*\}/);
  return json ? JSON.parse(json[0]) : { match: false, score: 0, reason: 'parse error' };
}

async function verifyByScreenshot(page, pattern) {
  try {
    await navigateToPattern(page, pattern);

    const resultRaw = await page.screenshot({ type: 'jpeg', quality: 60 });
    const resultBase64 = (await sharp(resultRaw)
      .resize({ width: 640 })
      .jpeg({ quality: 50 })
      .toBuffer()).toString('base64');

    const origResp = await axios.get(pattern.screenshotUrl, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const origBase64 = (await sharp(Buffer.from(origResp.data))
      .resize({ width: 640 })
      .jpeg({ quality: 40 })
      .toBuffer()).toString('base64');

    const cmp = await compareScreenshots(origBase64, resultBase64);
    return {
      verified: cmp.match && cmp.score >= 40,
      score: cmp.score,
      reason: cmp.reason,
    };
  } catch (e) {
    return { verified: false, score: 0, reason: e.message.slice(0, 100) };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const kbFile = 'knowledge-base.json';
  if (!fs.existsSync(kbFile)) {
    console.error('❌ knowledge-base.json не найден. Сначала запусти build-knowledge-base.js');
    process.exit(1);
  }

  let kb = JSON.parse(fs.readFileSync(kbFile));
  const unverified = kb.filter(p => !p.verified && !p.noScreenshots && p.id);

  // Статистика по уровням
  const levels = { screenshot: 0, url: 0, auto: 0 };
  unverified.forEach(p => levels[getVerifyLevel(p)]++);

  console.log(`🔍 К верификации: ${unverified.length} паттернов`);
  console.log(`   📸 screenshot (simple+static): ${levels.screenshot}`);
  console.log(`   🔗 url (static):               ${levels.url}`);
  console.log(`   ⚡ auto (complex/dynamic):     ${levels.auto}`);
  console.log(`🌐 Портал: ${PORTAL_URL}\n`);

  const cookies = loadCookies();
  console.log(`🍪 Куки: ${cookies.length} шт.`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({ viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT } });

  if (cookies.length > 0) {
    const sanitized = cookies.map(c => {
      const cookie = { ...c };
      if (cookie.domain?.startsWith('.')) cookie.domain = cookie.domain.slice(1);
      delete cookie.url;
      return cookie;
    });
    await context.addCookies(sanitized);
    console.log('✅ Куки добавлены\n');
  }

  let verified = 0;
  let failed = 0;

  for (let i = 0; i < unverified.length && i < LIMIT; i++) {
    const pattern = unverified[i];
    const level = getVerifyLevel(pattern);
    const prefix = `[${i + 1}/${unverified.length}] ${pattern.pageTitle || pattern.section}`;

    let result;

    if (level === 'auto') {
      // Уровень 2: принять без верификации
      result = { verified: true, score: 50, reason: 'complex pattern — accepted without verification' };
      console.log(`${prefix} ⚡ ${result.score}% — ${result.reason}`);
    } else {
      process.stdout.write(`${prefix}... `);

      const page = await context.newPage();
      if (level === 'screenshot') {
        result = await verifyByScreenshot(page, pattern);
      } else {
        result = await verifyByUrl(page, pattern);
      }
      await page.close().catch(() => {});

      if (result.verified) {
        console.log(`✅ ${result.score}% — ${result.reason}`);
      } else {
        console.log(`❌ ${result.score}% — ${result.reason}`);
      }
    }

    const idx = kb.findIndex(p => p.id === pattern.id);
    if (idx !== -1) {
      kb[idx].verified = result.verified;
      kb[idx].verificationScore = result.score;
      kb[idx].verificationReason = result.reason;
      kb[idx].verificationLevel = level;
    }

    if (result.verified) verified++;
    else failed++;

    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(kbFile, JSON.stringify(kb, null, 2));
      console.log(`  💾 Прогресс сохранён (${i + 1} обработано)`);
    }

    // Пауза только для реальных запросов
    if (level !== 'auto') await sleep(1500);
  }

  await browser.close();
  fs.writeFileSync(kbFile, JSON.stringify(kb, null, 2));

  const total = verified + failed;
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Верифицировано: ${verified}`);
  console.log(`❌ Не прошло: ${failed}`);
  if (total > 0) console.log(`📊 Успешность: ${Math.round(verified / total * 100)}%`);
  console.log(`💾 Сохранено: ${kbFile}`);
}

main().catch(console.error);
