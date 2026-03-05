const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ITERATIONS = 5;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;
const CLAUDE_TIMEOUT = 90_000;
const ITER_PAUSE_MS  = 3000; // пауза между итерациями Computer Use

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Сжимает изображение до 640px/quality40 перед отправкой в Claude */
async function compressForVision(buffer) {
  return sharp(buffer)
    .resize({ width: 640, withoutEnlargement: true })
    .jpeg({ quality: 40 })
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

async function takeScreenshotWithComputerUse(context, portalUrl, targetDescription, originalScreenshotB64) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  try {
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Сжимаем начальный скрин перед отправкой
    const initRaw = await page.screenshot({ type: 'jpeg', quality: 65 });
    const initCompressed = await compressForVision(initRaw);
    const initBase64 = initCompressed.toString('base64');

    // Сжимаем оригинальный русский скрин
    let origBase64 = null;
    if (originalScreenshotB64) {
      const origBuf = Buffer.from(originalScreenshotB64, 'base64');
      origBase64 = (await compressForVision(origBuf)).toString('base64');
    }

    const hasOriginal = !!origBase64;

    const messages = [
      {
        role: 'user',
        content: [
          ...(hasOriginal ? [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: origBase64 },
          }] : []),
          {
            type: 'text',
            text: `${hasOriginal ? 'TARGET screenshot shown above.\n' : ''}Goal: reproduce this Bitrix24 interface state on the western portal.
Description: ${targetDescription}
Portal: ${portalUrl}

Current browser state shown below. Navigate efficiently — call take_final_screenshot as soon as the state matches.
If the state already matches, call take_final_screenshot immediately.`,
          },
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
          betas: ['computer-use-2025-01-24'],
          tools: [
            {
              type: 'computer_20250124',
              name: 'computer',
              display_width_px: DISPLAY_WIDTH,
              display_height_px: DISPLAY_HEIGHT,
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
        if (block.type === 'text') console.log(`[computer-use] Claude: ${block.text.slice(0, 100)}`);
        if (block.type === 'tool_use') {
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

      // Оставляем первое сообщение + последние 5 (не раздуваем контекст)
      if (messages.length > 6) messages.splice(1, messages.length - 6);

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
  console.log(`[computer-use] ${action.action}`, action.coordinate || action.text || '');
  switch (action.action) {
    case 'left_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1]);
      await page.waitForTimeout(1000);
      break;
    case 'right_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
      await page.waitForTimeout(1000);
      break;
    case 'double_click':
      await page.mouse.dblclick(action.coordinate[0], action.coordinate[1]);
      await page.waitForTimeout(1000);
      break;
    case 'triple_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 3 });
      await page.waitForTimeout(500);
      break;
    case 'mouse_move':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.coordinate[0], y: action.coordinate[1], modifiers: 0 });
      await page.waitForTimeout(1000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.coordinate[0] + 1, y: action.coordinate[1] + 1, modifiers: 0 });
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
    case 'scroll':
      await page.mouse.wheel(0, action.direction === 'down' ? 300 : -300);
      await page.waitForTimeout(500);
      break;
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
