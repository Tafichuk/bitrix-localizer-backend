/**
 * Playwright-based Computer Use screenshot module.
 * Uses CDP for reliable hover events in headless mode.
 */
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadPortalCookies() {
  const b64 = process.env.PORTAL_AUTH_JSON;
  if (!b64) return [];
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return (json.cookies || []).map(c => {
      const cookie = { ...c };
      if (cookie.domain?.startsWith('.')) cookie.domain = cookie.domain.slice(1);
      delete cookie.url;
      return cookie;
    });
  } catch (e) {
    console.warn('[pw] Failed to parse PORTAL_AUTH_JSON:', e.message);
    return [];
  }
}

const DISPLAY_WIDTH  = 1280;
const DISPLAY_HEIGHT = 800;
const MAX_ITERATIONS = 10;
const CLAUDE_TIMEOUT = 60_000;

// ── CDP hover ─────────────────────────────────────────────────────────────────

async function hoverWithCDP(page, x, y) {
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 0 });
  await page.waitForTimeout(500);
  // Повторяем со смещением +1 чтобы тригернуть CSS :hover
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y: y + 1, modifiers: 0 });
  await page.waitForTimeout(300);
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function executeAction(page, action) {
  console.log(`[pw] ${action.action}`, action.coordinate || action.text || '');

  switch (action.action) {
    case 'left_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1]);
      await page.waitForTimeout(700);
      break;
    case 'right_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
      await page.waitForTimeout(500);
      break;
    case 'double_click':
      await page.mouse.dblclick(action.coordinate[0], action.coordinate[1]);
      await page.waitForTimeout(700);
      break;
    case 'triple_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 3 });
      await page.waitForTimeout(500);
      break;
    case 'mouse_move':
      await hoverWithCDP(page, action.coordinate[0], action.coordinate[1]);
      break;
    case 'type':
      await page.keyboard.type(action.text);
      await page.waitForTimeout(200);
      break;
    case 'key':
      await page.keyboard.press(action.text || action.key);
      await page.waitForTimeout(200);
      break;
    case 'scroll':
      await page.mouse.wheel(0, action.direction === 'down' ? 300 : -300);
      await page.waitForTimeout(200);
      break;
    case 'wait':
      await page.waitForTimeout(1500);
      break;
    case 'screenshot':
    case 'cursor_position':
      break;
    default:
      console.warn(`[pw] Unknown action: ${action.action}`);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

async function takeScreenshotWithComputerUse(portalUrl, targetDescription, originalScreenshotBase64) {
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

  try {
    const cookies = loadPortalCookies();
    const context = await browser.newContext({
      viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
    });

    if (cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`[pw] Loaded ${cookies.length} cookies from PORTAL_AUTH_JSON`);
    }

    const page = await context.newPage();

    // Navigate to target portal page
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const initShot = await page.screenshot({ type: 'jpeg', quality: 65 });
    const initBase64 = initShot.toString('base64');
    console.log('[pw] On portal, starting Computer Use');

    const messages = [
      {
        role: 'user',
        content: [
          ...(originalScreenshotBase64 ? [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: originalScreenshotBase64 },
          }] : []),
          {
            type: 'text',
            text: `${originalScreenshotBase64 ? 'TARGET screenshot shown above.\n' : ''}Goal: reproduce this Bitrix24 interface state on the western portal.
Description: ${targetDescription}
Portal: ${portalUrl}

Current browser state shown below. Navigate efficiently — call take_final_screenshot as soon as the state matches.
If the state already matches, call take_final_screenshot immediately.`,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: initBase64 },
          },
        ],
      },
    ];

    let finalScreenshot = null;
    let iterations = 0;

    while (!finalScreenshot && iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`[pw] Iteration ${iterations}/${MAX_ITERATIONS}`);

      let response;
      try {
        const apiCall = anthropic.beta.messages.create({
          model: 'claude-sonnet-4-5-20250929',
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
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Claude API timeout')), CLAUDE_TIMEOUT)
        );
        response = await Promise.race([apiCall, timeout]);
      } catch (err) {
        console.warn('[pw] API error:', err.message?.slice(0, 200));
        break;
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          console.log(`[pw] Claude: ${block.text.slice(0, 120)}`);
        }
        if (block.type === 'tool_use') {
          if (block.name === 'take_final_screenshot') {
            console.log(`[pw] ✅ ${block.input.reason?.slice(0, 100)}`);
            finalScreenshot = await page.screenshot({ type: 'png' });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' });
          } else if (block.name === 'computer') {
            await executeAction(page, block.input);
            const shot = await page.screenshot({ type: 'jpeg', quality: 65 });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.toString('base64') } }],
            });
          }
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      if (response.stop_reason === 'end_turn' && !finalScreenshot) {
        console.log('[pw] end_turn — using current state');
        finalScreenshot = await page.screenshot({ type: 'png' });
      }

      // Keep context lean: first message + last 4
      if (messages.length > 7) {
        messages.splice(1, messages.length - 5);
      }
    }

    if (!finalScreenshot) {
      console.warn('[pw] Max iterations, using current state');
      finalScreenshot = await page.screenshot({ type: 'png' });
    }

    return finalScreenshot;

  } finally {
    await browser.close();
  }
}

module.exports = { takeScreenshotWithComputerUse };
