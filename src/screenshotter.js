const { chromium } = require('playwright');

/**
 * For each analyzed screenshot item, executes the AI-generated action plan
 * on the Western portal and captures a screenshot.
 */
async function takePortalScreenshots(portalUrl, login, password, screenshotItems, onProgress) {
  const base = portalUrl.replace(/\/$/, '');
  const results = {};
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    // Login once
    await loginToPortal(page, base, login, password);

    // Execute action plan for each screenshot
    for (let i = 0; i < screenshotItems.length; i++) {
      const item = screenshotItems[i];
      if (!item.analysis) continue;

      const { steps = [], description = '' } = item.analysis;
      if (onProgress) onProgress(i, screenshotItems.length, description);

      try {
        await executeSteps(page, base, steps);

        const buf = await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: 1280, height: 800 },
        });

        const shotData = { data: buf.toString('base64'), mimeType: 'image/png' };
        results[item.src] = shotData;
        if (item.absoluteUrl) results[item.absoluteUrl] = shotData;

        console.log(`[screenshotter] ✅ Done: "${description}"`);
      } catch (err) {
        console.error(`[screenshotter] ❌ Failed "${description}": ${err.message}`);
        if (onProgress) onProgress(i, screenshotItems.length, `Ошибка: ${err.message}`);
      }
    }

    await context.close();
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

async function executeSteps(page, base, steps) {
  for (const step of steps) {
    try {
      await executeStep(page, base, step);
    } catch (err) {
      // Non-fatal: log and continue to next step
      console.warn(`[screenshotter] Step ${step.action} failed: ${err.message}`);
    }
  }
}

async function executeStep(page, base, step) {
  switch (step.action) {

    case 'goto': {
      const url = step.path.startsWith('http') ? step.path : `${base}${step.path}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      // Dismiss any welcome/tutorial popups
      await dismissPopups(page);
      break;
    }

    case 'click': {
      const clicked = await tryClick(page, step.selector, step.fallbackText);
      if (!clicked) console.warn(`[screenshotter] click: could not find "${step.selector}"`);
      await page.waitForTimeout(800);
      break;
    }

    case 'clickText': {
      try {
        await page.getByText(step.text, { exact: false }).first().click({ timeout: 5000 });
      } catch {
        // Try button role
        await page.getByRole('button', { name: step.text }).first().click({ timeout: 3000 });
      }
      await page.waitForTimeout(800);
      break;
    }

    case 'fill': {
      const selectors = [step.selector, ...(step.fallbacks || [])].filter(Boolean);
      let filled = false;
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          await el.waitFor({ timeout: 4000 });
          await el.click({ timeout: 3000 });
          await el.fill(step.value || '', { timeout: 3000 });
          filled = true;
          break;
        } catch (_) {}
      }
      if (!filled) console.warn(`[screenshotter] fill: could not find field "${step.selector}"`);
      break;
    }

    case 'fillByLabel': {
      try {
        await page.getByLabel(step.label, { exact: false }).first().fill(step.value || '', { timeout: 4000 });
      } catch {
        console.warn(`[screenshotter] fillByLabel: label "${step.label}" not found`);
      }
      break;
    }

    case 'select': {
      try {
        await page.locator(step.selector).first().selectOption(step.value, { timeout: 4000 });
      } catch {
        console.warn(`[screenshotter] select: "${step.selector}" not found`);
      }
      break;
    }

    case 'keyboard': {
      await page.keyboard.press(step.key || 'Escape');
      await page.waitForTimeout(300);
      break;
    }

    case 'wait': {
      await page.waitForTimeout(Math.min(step.ms || 1000, 5000));
      break;
    }

    case 'waitForSelector': {
      await page.waitForSelector(step.selector, { timeout: 8000 });
      break;
    }

    case 'scroll': {
      await page.evaluate((y) => window.scrollTo(0, y), step.y || 0);
      await page.waitForTimeout(400);
      break;
    }

    default:
      console.warn(`[screenshotter] Unknown action: ${step.action}`);
  }
}

async function tryClick(page, selector, fallbackText) {
  try {
    await page.locator(selector).first().click({ timeout: 4000 });
    return true;
  } catch (_) {}

  if (fallbackText) {
    try {
      await page.getByText(fallbackText, { exact: false }).first().click({ timeout: 3000 });
      return true;
    } catch (_) {}
  }
  return false;
}

async function dismissPopups(page) {
  const popupSelectors = [
    '.popup-window-close-icon',
    '.ui-popup-close',
    '[data-role="close"]',
    '.im-notify-container .im-notify-close',
  ];
  for (const sel of popupSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch (_) {}
  }
}

async function loginToPortal(page, base, login, password) {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(1000);

  // Check if already logged in
  const loginSelectors = ['input[name="USER_LOGIN"]', 'input[name="login"]', 'input[type="email"]'];
  let hasForm = false;
  for (const sel of loginSelectors) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 1000 })) { hasForm = true; break; }
    } catch (_) {}
  }

  if (!hasForm) {
    await page.goto(`${base}/login/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(500);
  }

  // Fill login
  for (const sel of loginSelectors) {
    try { await page.locator(sel).first().fill(login, { timeout: 3000 }); break; } catch (_) {}
  }

  // Fill password
  for (const sel of ['input[name="USER_PASSWORD"]', 'input[name="password"]', 'input[type="password"]']) {
    try { await page.locator(sel).first().fill(password, { timeout: 3000 }); break; } catch (_) {}
  }

  // Submit
  for (const sel of ['button[type="submit"]', 'input[type="submit"]', '.login-btn', '.bx-login-button']) {
    try { await page.locator(sel).first().click({ timeout: 3000 }); break; } catch (_) {}
  }

  await page.waitForTimeout(2500);

  const afterUrl = page.url();
  if (afterUrl.includes('/login') || afterUrl.includes('/auth')) {
    throw new Error('Ошибка авторизации. Проверьте логин и пароль.');
  }

  console.log(`[screenshotter] ✅ Logged in, current URL: ${afterUrl}`);
}

module.exports = { takePortalScreenshots };
