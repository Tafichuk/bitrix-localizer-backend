const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ITERATIONS = 10;
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

/**
 * Loads portal auth cookies from PORTAL_AUTH_JSON env var (base64-encoded auth.json).
 * Returns array of Playwright cookie objects, or empty array if not configured.
 */
function loadPortalAuth() {
  const b64 = process.env.PORTAL_AUTH_JSON;
  if (!b64) {
    console.warn('[computer-use] PORTAL_AUTH_JSON not set — proceeding without cookies');
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
 * Uses Claude Computer Use to navigate a Bitrix24 portal and reproduce
 * the interface state shown in the original Russian screenshot.
 *
 * @param {string} portalUrl             - Western Bitrix24 portal URL
 * @param {Array}  cookies               - Array of Playwright cookie objects
 * @param {string} targetDescription     - Text description of the target state
 * @param {string} originalScreenshotB64 - Base64 JPEG of the original Russian screenshot
 * @returns {Promise<Buffer>}            - PNG buffer of the reproduced screenshot
 */
async function takeScreenshotWithComputerUse(portalUrl, cookies, targetDescription, originalScreenshotB64) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT } });

  if (Array.isArray(cookies) && cookies.length > 0) {
    // Preserve original cookie domains — do NOT override them
    const sanitized = cookies.map(c => {
      const cookie = { ...c };
      // Playwright requires domain without leading dot for exact match
      if (cookie.domain && cookie.domain.startsWith('.')) {
        cookie.domain = cookie.domain.slice(1);
      }
      // Remove url field if present (not valid in addCookies)
      delete cookie.url;
      return cookie;
    });
    await context.addCookies(sanitized);
  }

  const page = await context.newPage();

  try {
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const initScreenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
    const initBase64 = initScreenshot.toString('base64');

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: originalScreenshotB64 },
          },
          {
            type: 'text',
            text: `This is the TARGET screenshot from a Russian Bitrix24 helpdesk article.
Your goal: reproduce this exact interface state on the Western Bitrix24 portal.

Portal URL: ${portalUrl}
Target description: ${targetDescription}

The current browser state is shown below. Navigate and interact to match the target screenshot.
When the interface matches the target, call the take_final_screenshot tool.`,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: initBase64 },
          },
          {
            type: 'text',
            text: 'Current browser state shown above. Proceed to reproduce the target.',
          },
        ],
      },
    ];

    let finalScreenshot = null;
    let iterations = 0;

    while (!finalScreenshot && iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`[computer-use] Iteration ${iterations}/${MAX_ITERATIONS}`);

      const response = await anthropic.beta.messages.create({
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
            description: 'Call this when the browser state matches the target screenshot',
            input_schema: {
              type: 'object',
              properties: {
                reason: { type: 'string', description: 'Why this matches the target' },
              },
              required: ['reason'],
            },
          },
        ],
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      let lastToolUseId = null;

      for (const block of response.content) {
        if (block.type === 'text') {
          console.log(`[computer-use] Claude: ${block.text.slice(0, 120)}`);
        }

        if (block.type === 'tool_use') {
          lastToolUseId = block.id;

          if (block.name === 'take_final_screenshot') {
            console.log(`[computer-use] ✅ Done: ${block.input.reason}`);
            finalScreenshot = await page.screenshot({ type: 'png' });
            messages.push({
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: block.id, content: 'Screenshot taken.' }],
            });

          } else if (block.name === 'computer') {
            const action = block.input;
            console.log(`[computer-use] Action: ${action.action}`, action.coordinate || action.text || '');

            switch (action.action) {
              case 'screenshot':
                break;

              case 'left_click':
                await page.mouse.click(action.coordinate[0], action.coordinate[1]);
                await page.waitForTimeout(800);
                break;

              case 'right_click':
                await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
                await page.waitForTimeout(500);
                break;

              case 'double_click':
                await page.mouse.dblclick(action.coordinate[0], action.coordinate[1]);
                await page.waitForTimeout(800);
                break;

              case 'triple_click':
                await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 3 });
                await page.waitForTimeout(500);
                break;

              case 'mouse_move':
                await page.mouse.move(action.coordinate[0], action.coordinate[1]);
                await page.waitForTimeout(300);
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
                await page.waitForTimeout(300);
                break;

              case 'wait':
                await page.waitForTimeout(2000);
                break;

              case 'cursor_position':
                break;

              default:
                console.warn(`[computer-use] Unknown action: ${action.action}`);
            }

            // Send updated screenshot as tool result (unless we already have final)
            if (!finalScreenshot) {
              const updatedShot = await page.screenshot({ type: 'jpeg', quality: 70 });
              messages.push({
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: lastToolUseId,
                  content: [{
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/jpeg', data: updatedShot.toString('base64') },
                  }],
                }],
              });
            }
          }
        }
      }

      if (response.stop_reason === 'end_turn' && !finalScreenshot) {
        console.log('[computer-use] end_turn — using current state');
        finalScreenshot = await page.screenshot({ type: 'png' });
      }
    }

    if (!finalScreenshot) {
      console.warn('[computer-use] Max iterations reached, using current state');
      finalScreenshot = await page.screenshot({ type: 'png' });
    }

    return finalScreenshot;

  } finally {
    await browser.close();
  }
}

module.exports = { takeScreenshotWithComputerUse, loadPortalAuth };
