const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ITERATIONS = 5;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;
const API_TIMEOUT_MS = 60_000;    // max 60s per Claude call
const FN_TIMEOUT_MS  = 4 * 60_000; // max 4min per screenshot

/**
 * Loads portal auth cookies from PORTAL_AUTH_JSON env var (base64-encoded auth.json).
 */
function loadPortalAuth() {
  const b64 = process.env.PORTAL_AUTH_JSON;
  if (!b64) {
    console.warn('[computer-use] PORTAL_AUTH_JSON not set');
    return [];
  }
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const cookies = json.cookies || [];
    console.log(`[computer-use] Loaded ${cookies.length} cookies from PORTAL_AUTH_JSON`);
    return cookies;
  } catch (e) {
    console.error('[computer-use] Failed to parse PORTAL_AUTH_JSON:', e.message);
    return [];
  }
}

/**
 * Creates a shared browser session for the portal (call once per job).
 * Returns { browser, context, page } — caller must call closeBrowserSession() when done.
 */
async function openBrowserSession(portalUrl, cookies) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT } });

  if (Array.isArray(cookies) && cookies.length > 0) {
    const sanitized = cookies.map(c => {
      const cookie = { ...c };
      if (cookie.domain && cookie.domain.startsWith('.')) cookie.domain = cookie.domain.slice(1);
      delete cookie.url;
      return cookie;
    });
    await context.addCookies(sanitized);
  }

  const page = await context.newPage();
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('[computer-use] Browser session opened, URL:', page.url());
  return { browser, context, page };
}

async function closeBrowserSession({ browser }) {
  await browser.close().catch(() => {});
}

/**
 * Calls the Anthropic Computer Use API with a hard timeout.
 */
async function callClaudeWithTimeout(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await anthropic.beta.messages.create({ ...params, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uses Claude Computer Use to navigate the portal to match the target screenshot.
 * Reuses an existing page rather than launching a new browser each time.
 * Has an overall timeout of FN_TIMEOUT_MS.
 */
async function takeScreenshotWithComputerUse(page, portalUrl, targetDescription, originalScreenshotB64) {
  const deadline = Date.now() + FN_TIMEOUT_MS;

  // Always navigate to portal root before each screenshot to get a clean starting state
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const initScreenshot = await page.screenshot({ type: 'jpeg', quality: 65 });
  const initBase64 = initScreenshot.toString('base64');

  const hasOriginal = !!originalScreenshotB64;

  const messages = [
    {
      role: 'user',
      content: [
        ...(hasOriginal ? [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: originalScreenshotB64 },
        }] : []),
        {
          type: 'text',
          text: `${hasOriginal ? 'TARGET screenshot shown above.\n' : ''}Goal: reproduce this Bitrix24 interface state on the western portal.
Description: ${targetDescription}
Portal: ${portalUrl}

Current browser state shown below. Navigate efficiently — call take_final_screenshot as soon as the state matches.
If you reach the target in the first look, call take_final_screenshot immediately.`,
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
    if (Date.now() > deadline) {
      console.warn('[computer-use] Overall timeout reached, using current state');
      break;
    }

    iterations++;
    console.log(`[computer-use] Iteration ${iterations}/${MAX_ITERATIONS}`);

    let response;
    try {
      response = await callClaudeWithTimeout({
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
    } catch (err) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        console.warn('[computer-use] API call timed out, using current state');
      } else {
        console.error('[computer-use] API error:', err.message);
      }
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    // Collect all tool results for this turn into one user message
    const toolResults = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        console.log(`[computer-use] Claude: ${block.text.slice(0, 100)}`);
      }

      if (block.type === 'tool_use') {
        if (block.name === 'take_final_screenshot') {
          console.log(`[computer-use] ✅ ${block.input.reason?.slice(0, 80)}`);
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

    // Push all tool results as a single user message (required by API)
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    if (response.stop_reason === 'end_turn' && !finalScreenshot) {
      console.log('[computer-use] end_turn — using current state');
      finalScreenshot = await page.screenshot({ type: 'png' });
    }

    // Trim accumulated intermediate screenshots from messages to prevent context bloat.
    // Keep only: first user message (with original + init), last assistant, last user tool_result.
    if (messages.length > 6) {
      messages.splice(1, messages.length - 5);
    }
  }

  if (!finalScreenshot) {
    console.warn('[computer-use] Max iterations reached, using current state');
    finalScreenshot = await page.screenshot({ type: 'png' });
  }

  return finalScreenshot;
}

async function executeAction(page, action) {
  console.log(`[computer-use] ${action.action}`, action.coordinate || action.text || '');
  switch (action.action) {
    case 'screenshot':
      break;
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
      await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      await page.waitForTimeout(200);
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
    case 'cursor_position':
      break;
    default:
      console.warn(`[computer-use] Unknown action: ${action.action}`);
  }
}

module.exports = { takeScreenshotWithComputerUse, loadPortalAuth, openBrowserSession, closeBrowserSession };
