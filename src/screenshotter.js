const { chromium } = require('playwright');

/**
 * Logs into the Western Bitrix24 portal once and takes screenshots
 * for all analyzed pages. Returns a map: { [originalSrc]: { data, mimeType } }
 */
async function takePortalScreenshots(portalUrl, login, password, screenshotItems, onProgress) {
  const base = portalUrl.replace(/\/$/, '');
  let browser;
  const results = {};

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
    page.setDefaultTimeout(25000);

    // Login
    await loginToPortal(page, base, login, password);

    // Take screenshots
    for (let i = 0; i < screenshotItems.length; i++) {
      const item = screenshotItems[i];
      if (!item.analysis) continue;

      if (onProgress) onProgress(i, screenshotItems.length, item.analysis.description);

      try {
        const targetUrl = `${base}${item.analysis.path}`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for content to render
        await page.waitForTimeout(2500);

        // Dismiss any modals/popups
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        } catch (_) {}

        const screenshotBuffer = await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: 1280, height: 800 },
        });

        results[item.src] = {
          data: screenshotBuffer.toString('base64'),
          mimeType: 'image/png',
        };
      } catch (err) {
        console.error(`[screenshotter] Failed for ${item.analysis.path}:`, err.message);
      }
    }

    await context.close();
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

async function loginToPortal(page, base, login, password) {
  // Try direct login page
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const currentUrl = page.url();
  // Check if already logged in (no login form visible)
  const hasLoginForm = await page.locator('input[name="USER_LOGIN"], input[name="login"], input[type="email"]').count();

  if (hasLoginForm === 0) {
    // Try /login/ path
    await page.goto(`${base}/login/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
  }

  // Fill login form
  const loginSelectors = ['input[name="USER_LOGIN"]', 'input[name="login"]', 'input[type="email"]'];
  const passwordSelectors = ['input[name="USER_PASSWORD"]', 'input[name="password"]', 'input[type="password"]'];
  const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', '.login-btn', '.bx-login-button'];

  let loginFilled = false;
  for (const sel of loginSelectors) {
    try {
      await page.fill(sel, login, { timeout: 3000 });
      loginFilled = true;
      break;
    } catch (_) {}
  }

  if (!loginFilled) throw new Error('Не удалось найти поле логина на портале');

  for (const sel of passwordSelectors) {
    try {
      await page.fill(sel, password, { timeout: 3000 });
      break;
    } catch (_) {}
  }

  for (const sel of submitSelectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      break;
    } catch (_) {}
  }

  // Wait for redirect after login
  await page.waitForTimeout(3000);

  const afterUrl = page.url();
  if (afterUrl.includes('/login') || afterUrl.includes('/auth')) {
    throw new Error('Ошибка авторизации на портале. Проверьте логин и пароль.');
  }
}

module.exports = { takePortalScreenshots };
