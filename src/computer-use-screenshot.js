const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const { planNavigation } = require('./navigation-planner');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ITERATIONS = 8;
const DISPLAY_WIDTH  = 1280;  // реальный вьюпорт браузера
const DISPLAY_HEIGHT = 800;
const CLAUDE_TIMEOUT = 90_000;
const ITER_PAUSE_MS  = 3000;

// Размер скринов которые Claude ВИДИТ (должен совпадать с display_width/height в tool-config)
const VISION_WIDTH  = 1280;
const VISION_HEIGHT = 800;

// Коэффициенты масштабирования координат: Claude-координата → Playwright-координата
const SCALE_X = DISPLAY_WIDTH  / VISION_WIDTH;   // 1.0 при совпадении
const SCALE_Y = DISPLAY_HEIGHT / VISION_HEIGHT;  // 1.0 при совпадении

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Сжимает скрин до VISION_WIDTH сохраняя пропорции */
async function compressForVision(buffer) {
  return sharp(buffer)
    .resize({ width: VISION_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();
}

/**
 * Вызов Claude Computer Use с retry при 429.
 * Exponential backoff: 10s → 20s → 40s → 80s → 160s
 */
async function callClaudeWithRetry(params, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await Promise.race([
        anthropic.beta.messages.create(params),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Claude API timeout')), CLAUDE_TIMEOUT)),
      ]);
    } catch (e) {
      if (e.status === 429) {
        const wait = Math.pow(2, i) * 10000;
        console.log(`[computer-use] ⏳ Rate limit 429, жду ${wait / 1000}с (попытка ${i + 1}/${maxRetries})`);
        await sleep(wait);
      } else {
        throw e;
      }
    }
  }
  throw new Error('Превышено число попыток после rate limit');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function loadPortalAuth() {
  const b64 = process.env.PORTAL_AUTH_JSON;
  if (!b64) { console.warn('[computer-use] PORTAL_AUTH_JSON not set'); return []; }
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const cookies = json.cookies || [];
    console.log(`[computer-use] Loaded ${cookies.length} cookies`);
    return cookies;
  } catch (e) {
    console.error('[computer-use] Failed to parse PORTAL_AUTH_JSON:', e.message);
    return [];
  }
}

// ── Browser session ───────────────────────────────────────────────────────────

async function openBrowserSession(portalUrl, cookies) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
  });

  if (Array.isArray(cookies) && cookies.length > 0) {
    const sanitized = cookies.map(c => {
      const cookie = { ...c };
      if (cookie.domain?.startsWith('.')) cookie.domain = cookie.domain.slice(1);
      delete cookie.url;
      return cookie;
    });
    await context.addCookies(sanitized);
  }

  console.log('[computer-use] Browser session opened');
  return { browser, context };
}

async function closeBrowserSession({ browser }) {
  await browser.close().catch(() => {});
}

// ── Computer Use ──────────────────────────────────────────────────────────────

async function takeScreenshotWithComputerUse(context, portalUrl, targetDescription, originalScreenshotB64, articleSection, screenshotContext, screenshotAlt) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  try {
    // Сжимаем оригинальный русский скрин
    let origBase64 = null;
    if (originalScreenshotB64) {
      console.log('Original screenshot size:', originalScreenshotB64.length, 'chars (base64)');
      const origBuf = Buffer.from(originalScreenshotB64, 'base64');
      origBase64 = (await compressForVision(origBuf)).toString('base64');
      console.log('Original screenshot compressed:', origBase64.length, 'chars');
    } else {
      console.log('Original screenshot size: EMPTY');
    }

    // ── Шаг 1: Планируем навигацию ───────────────────────────────────────────
    // Используем оригинал (1280px) для планировщика, чтобы координаты совпадали с вьюпортом
    let plan = null;
    let planContext = 'No plan available, navigate manually.';
    const planInput = originalScreenshotB64 || origBase64;
    if (planInput) {
      console.log('🗺️ Планирую навигацию...');
      plan = await planNavigation(planInput, articleSection || targetDescription, screenshotContext, screenshotAlt);
      if (plan) {
        console.log('📍 URL:', plan.url);
        console.log('📋 Шагов:', plan.steps?.length ?? 0);
        console.log('📝 Notes:', plan.notes?.slice(0, 120));
        console.log('🗺️ План:', JSON.stringify(plan, null, 2));
      } else {
        console.log('⚠️ Планировщик вернул null, работаем без плана');
      }
    }

    // ── Шаг 2: Переходим на нужный URL ───────────────────────────────────────
    const baseOrigin = (() => { try { return new URL(portalUrl).origin; } catch { return portalUrl.replace(/\/$/, ''); } })();
    const targetUrl = plan?.url ? `${baseOrigin}${plan.url}` : portalUrl;
    console.log(`🌐 Навигация на: ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // ФИКС 1: Wait longer so skeleton loaders have time to resolve
    await page.waitForTimeout(8000);
    await page.waitForFunction(() => {
      const skeletons = document.querySelectorAll(
        '.ui-skeleton, [class*="skeleton"], [class*="loader"], [class*="loading"]'
      );
      return skeletons.length === 0;
    }, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // ФИКС 2: URL guard — if we were redirected away from expected section, re-navigate
    if (plan?.url) {
      const expectedBase = plan.url.split('/').filter(Boolean)[0];
      const currentPath = new URL(page.url()).pathname;
      if (expectedBase && !currentPath.includes(expectedBase)) {
        console.warn(`[computer-use] ⚠️ Redirect detected: expected ${plan.url}, got ${currentPath}. Re-navigating...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(8000);
        await page.waitForFunction(() => {
          const s = document.querySelectorAll('.ui-skeleton,[class*="skeleton"],[class*="loader"],[class*="loading"]');
          return s.length === 0;
        }, { timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(5000);
      }
    }

    // Координаты из плана ненадёжны (разные размеры скринов) — передаём шаги
    // как текстовые инструкции в Computer Use, а не выполняем вслепую.
    // Computer Use сам найдёт элементы по описанию на живом портале.

    // Контекст для Computer Use
    planContext = plan
      ? `You are already on ${targetUrl}. Follow this plan:
${(plan.steps || []).map((s, i) => {
  const hint = (s.x && s.y) ? ` (approx x:${s.x}, y:${s.y} in 1280x800 viewport)` : '';
  return `  Step ${i + 1}: [${s.action}] ${s.description} — look for: "${s.target}"${hint}`;
}).join('\n')}
Notes: ${plan.notes}

The coordinates above are approximate hints for a 1280x800 viewport.
Execute these steps to reproduce the target UI state, then call take_final_screenshot.`
      : 'No plan available. Navigate manually to reproduce the target.';

    // ── Шаг 4: Снимаем текущий скрин после выполнения плана ──────────────────
    const initRaw = await page.screenshot({ type: 'jpeg', quality: 65 });
    const initCompressed = await compressForVision(initRaw);
    const initBase64 = initCompressed.toString('base64');

    const hasOriginal = !!origBase64;

    const systemPrompt = `You are controlling a Bitrix24 portal browser to reproduce a target screenshot.

You will receive:
1. TARGET IMAGE - a screenshot from a Russian helpdesk article showing the exact UI state to reproduce
2. CURRENT IMAGE - the live browser state of the Western (French/English) portal

Your job: navigate the browser so it matches the TARGET IMAGE exactly.

ANALYSIS STEPS:
1. Study the TARGET IMAGE carefully:
   - What page/section is shown? (Feed, Tasks, CRM, etc.)
   - What UI elements are visible?
   - What state is the interface in? (menu open, dropdown visible, button highlighted, etc.)
   - Are there any overlays, popups, or hover states?
2. Compare with CURRENT IMAGE to understand where you are now
3. Navigate step by step to reproduce the target state

CRITICAL RULES:
- Do NOT copy pixel coordinates from TARGET — find elements by visual appearance
- Interface language differs (Russian → French/English) but layout is identical
- Take a screenshot after each action to verify progress
- When the portal state matches the TARGET IMAGE, call take_final_screenshot IMMEDIATELY
- Do NOT scroll after opening a dropdown/menu — it will close it
- If a dropdown is open and visible, call take_final_screenshot right away

FORBIDDEN ACTIONS — never do these:
- Do NOT click on tabs MESSAGE/ÉVÈNEMENT/SONDAGE/FICHIER/PLUS in the Feed post creation form (top of Feed) unless TARGET explicitly shows one of these tabs selected
- Do NOT click "Calendrier" in the top navigation menu unless TARGET shows the Calendar section
- Do NOT open creation dialogs (new event, new task, new post) unless TARGET explicitly shows such a dialog open
- Do NOT click buttons that open modal windows with confirmations
- Do NOT click on user avatars
- Do NOT interact with the right column (Processus d'entreprise, Mes tâches, upcoming events)

REQUIRED ACTIONS — always do these:
- First study the TARGET image and identify EXACTLY what is shown (section, UI state, open menus)
- If TARGET shows a menu/dropdown open — find the BUTTON that opens it, click that button
- If TARGET shows a post with action buttons underneath — hover over the post first to reveal the buttons
- If unsure whether current state matches TARGET — take a screenshot and compare before next action
- If something unexpected opened (modal, dialog) — close it with Escape key and try again
- If you pressed Escape — take a screenshot to verify the state before continuing`;

    const userText = `You are reproducing a specific Bitrix24 portal screenshot.

${planContext}

TARGET SCREENSHOT is IMAGE 1 below.
CURRENT BROWSER STATE is IMAGE 2 below (taken after executing the plan above).

Context/description: ${targetDescription}

Compare TARGET vs CURRENT carefully. If they match — call take_final_screenshot immediately.
If not — make small adjustments, then call take_final_screenshot.`;

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...(hasOriginal ? [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: origBase64 },
          }] : []),
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: initBase64 } },
        ],
      },
    ];

    let finalScreenshot = null;
    let iterations = 0;

    while (!finalScreenshot && iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`[computer-use] Iteration ${iterations}/${MAX_ITERATIONS}`);

      let response;
      try {
        response = await callClaudeWithRetry({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          betas: ['computer-use-2025-01-24'],
          tools: [
            {
              type: 'computer_20250124',
              name: 'computer',
              display_width_px: VISION_WIDTH,
              display_height_px: VISION_HEIGHT,
              display_number: 1,
            },
            {
              name: 'take_final_screenshot',
              description: 'Call this when the browser state matches the target. Call immediately if already matching.',
              input_schema: {
                type: 'object',
                properties: { reason: { type: 'string' } },
                required: ['reason'],
              },
            },
          ],
          messages,
        });
      } catch (err) {
        console.warn('[computer-use] API error:', err.message?.slice(0, 200));
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === 'text') console.log(`[computer-use] Claude: ${block.text.slice(0, 200)}`);
        if (block.type === 'tool_use') {
          console.log(`  Итерация ${iterations}: ${block.name} - ${JSON.stringify(block.input).substring(0, 120)}`);
          if (block.name === 'take_final_screenshot') {
            console.log(`[computer-use] ✅ ${block.input.reason?.slice(0, 80)}`);
            finalScreenshot = await page.screenshot({ type: 'png' });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' });
          } else if (block.name === 'computer') {
            await executeAction(page, cdp, block.input);
            // Сжимаем скрин после действия
            const shotRaw = await page.screenshot({ type: 'jpeg', quality: 65 });
            const shotCompressed = await compressForVision(shotRaw);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shotCompressed.toString('base64') } }],
            });
          }
        }
      }

      if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });

      if (response.stop_reason === 'end_turn' && !finalScreenshot) {
        finalScreenshot = await page.screenshot({ type: 'png' });
      }

      // Оставляем первое сообщение + последние 4 (2 полные пары assistant+user)
      // Удаляем только парами, иначе висят orphan tool_result без tool_use
      while (messages.length > 5) messages.splice(1, 2);

      // Пауза между итерациями чтобы не бить по rate limit
      if (!finalScreenshot && iterations < MAX_ITERATIONS) {
        await sleep(ITER_PAUSE_MS);
      }
    }

    if (!finalScreenshot) finalScreenshot = await page.screenshot({ type: 'png' });
    return finalScreenshot;

  } finally {
    await page.close().catch(() => {});
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function executeAction(page, cdp, action) {
  // Масштабируем координаты из VISION-пространства в реальный вьюпорт
  const sx = c => Math.round(c * SCALE_X);
  const sy = c => Math.round(c * SCALE_Y);
  const coord = action.coordinate ? [sx(action.coordinate[0]), sy(action.coordinate[1])] : null;

  console.log(`[computer-use] ${action.action}`, coord || action.text || '');
  switch (action.action) {
    case 'left_click':
      await page.mouse.click(coord[0], coord[1]);
      await page.waitForTimeout(1000);
      break;
    case 'right_click':
      await page.mouse.click(coord[0], coord[1], { button: 'right' });
      await page.waitForTimeout(1000);
      break;
    case 'double_click':
      await page.mouse.dblclick(coord[0], coord[1]);
      await page.waitForTimeout(1000);
      break;
    case 'triple_click':
      await page.mouse.click(coord[0], coord[1], { clickCount: 3 });
      await page.waitForTimeout(500);
      break;
    case 'mouse_move':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coord[0], y: coord[1], modifiers: 0 });
      await page.waitForTimeout(1000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coord[0] + 1, y: coord[1] + 1, modifiers: 0 });
      await page.waitForTimeout(500);
      break;
    case 'type':
      await page.keyboard.type(action.text);
      await page.waitForTimeout(300);
      break;
    case 'key':
      await page.keyboard.press(action.text || action.key);
      await page.waitForTimeout(300);
      break;
    case 'scroll': {
      if (coord) await page.mouse.move(coord[0], coord[1]);
      const delta = (action.direction === 'up' || (action.scroll_direction === 'up')) ? -300 : 300;
      await page.mouse.wheel(0, delta * (action.scroll_amount || 1));
      await page.waitForTimeout(500);
      break;
    }
    case 'wait':
      await page.waitForTimeout(1500);
      break;
    case 'screenshot':
    case 'cursor_position':
      break;
    default:
      console.warn(`[computer-use] Unknown action: ${action.action}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { takeScreenshotWithComputerUse, loadPortalAuth, openBrowserSession, closeBrowserSession };
