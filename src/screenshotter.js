const { chromium } = require('playwright');

async function takePortalScreenshots(portalUrl, sessionCookies, screenshotItems, onProgress) {
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

    // Inject session cookies before creating page
    const cookies = parseCookieString(sessionCookies, base);
    if (cookies.length === 0) throw new Error('Не удалось распарсить cookies. Проверьте формат: name=value; name2=value2');
    await context.addCookies(cookies);
    console.log(`[screenshotter] Injected ${cookies.length} cookies for ${base}`);

    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    // Verify portal access
    await verifyPortalAccess(page, base);

    for (let i = 0; i < screenshotItems.length; i++) {
      const item = screenshotItems[i];
      if (!item.analysis) continue;

      const { steps = [], description = '' } = item.analysis;
      if (onProgress) onProgress(i, screenshotItems.length, description);

      try {
        await executeSteps(page, base, steps);
        const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 } });
        const shotData = { data: buf.toString('base64'), mimeType: 'image/png' };
        results[item.src] = shotData;
        if (item.absoluteUrl) results[item.absoluteUrl] = shotData;
        console.log(`[screenshotter] ✅ "${description}"`);
      } catch (err) {
        console.error(`[screenshotter] ❌ "${description}": ${err.message}`);
        if (onProgress) onProgress(i, screenshotItems.length, `Ошибка: ${err.message}`);
      }
    }

    await context.close();
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

// ─── Cookie parsing ────────────────────────────────────────────────────────────

/**
 * Parses "name=value; name2=value2" cookie string into Playwright cookie objects.
 * Uses portal URL so cookies are set for the correct domain.
 */
function parseCookieString(cookieStr, portalBase) {
  const cookies = [];
  if (!cookieStr || !cookieStr.trim()) return cookies;

  const url = `${portalBase}/`;

  const parts = cookieStr.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({ name, value, url });
  }

  return cookies;
}

// ─── Portal access verification ───────────────────────────────────────────────

async function verifyPortalAccess(page, base) {
  console.log(`[screenshotter] Navigating to portal: ${base}/`);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  console.log(`[screenshotter] Portal URL after navigation: ${currentUrl}`);

  // Check for login redirect
  if (currentUrl.includes('bitrix24.net') || currentUrl.includes('/login') || currentUrl.includes('/auth')) {
    throw new Error(`Cookies не действительны или истекли. Портал показывает страницу логина: ${currentUrl}. Обновите cookies.`);
  }

  // Check for portal dashboard elements
  const dashboardFound = await isDashboard(page);
  if (!dashboardFound) {
    // Give it more time
    await page.waitForTimeout(3000);
    const dashboardFound2 = await isDashboard(page);
    if (!dashboardFound2) {
      const finalUrl = page.url();
      if (finalUrl.includes('/login') || finalUrl.includes('/auth') || finalUrl.includes('bitrix24.net')) {
        throw new Error(`Авторизация через cookies не удалась. URL: ${finalUrl}. Обновите cookies.`);
      }
      // Not clearly a dashboard but not a login page either — proceed
      console.log(`[screenshotter] ⚠️ Portal loaded but dashboard not confirmed. URL: ${finalUrl}`);
    } else {
      console.log(`[screenshotter] ✅ Portal dashboard confirmed. URL: ${page.url()}`);
    }
  } else {
    console.log(`[screenshotter] ✅ Portal access OK. URL: ${page.url()}`);
  }
}

async function isDashboard(page) {
  const selectors = [
    '#bx-panel', '.bx-layout-user-block', '.feed-add-post-form',
    '[class*="global-menu"]', '.crm-btn-add', '.tasks-task-create-btn',
    '.im-sidebar', '.bx-portal-menu', '[class*="bx-header"]',
  ];
  for (const sel of selectors) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 300 })) return true;
    } catch (_) {}
  }
  return false;
}

// ─── Step executor ────────────────────────────────────────────────────────────

async function executeSteps(page, base, steps) {
  for (const step of steps) {
    try {
      await executeStep(page, base, step);
    } catch (err) {
      console.warn(`[screenshotter] Step "${step.action}" failed: ${err.message}`);
    }
  }
}

async function executeStep(page, base, step) {
  switch (step.action) {
    case 'goto': {
      const url = step.path.startsWith('http') ? step.path : `${base}${step.path}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      await dismissPopups(page);
      break;
    }
    case 'click': {
      await tryClick(page, step.selector, step.fallbackText);
      await page.waitForTimeout(800);
      break;
    }
    case 'clickText': {
      try {
        await page.getByText(step.text, { exact: false }).first().click({ timeout: 5000 });
      } catch {
        await page.getByRole('button', { name: step.text }).first().click({ timeout: 3000 });
      }
      await page.waitForTimeout(800);
      break;
    }
    case 'fill': {
      const sels = [step.selector, ...(step.fallbacks || [])].filter(Boolean);
      for (const sel of sels) {
        try {
          const el = page.locator(sel).first();
          await el.waitFor({ timeout: 4000 });
          await el.click({ timeout: 2000 });
          await el.fill(step.value || '', { timeout: 3000 });
          break;
        } catch (_) {}
      }
      break;
    }
    case 'fillByLabel': {
      try {
        await page.getByLabel(step.label, { exact: false }).first().fill(step.value || '', { timeout: 4000 });
      } catch { console.warn(`[step] fillByLabel "${step.label}" not found`); }
      break;
    }
    case 'select': {
      try {
        await page.locator(step.selector).first().selectOption(step.value, { timeout: 4000 });
      } catch { console.warn(`[step] select "${step.selector}" not found`); }
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
      console.warn(`[step] Unknown action: ${step.action}`);
  }
}

async function tryClick(page, selector, fallbackText) {
  try { await page.locator(selector).first().click({ timeout: 4000 }); return true; } catch (_) {}
  if (fallbackText) {
    try { await page.getByText(fallbackText, { exact: false }).first().click({ timeout: 3000 }); return true; } catch (_) {}
  }
  return false;
}

async function dismissPopups(page) {
  for (const sel of ['.popup-window-close-icon', '.ui-popup-close', '[data-role="close"]']) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 400 })) {
        await page.locator(sel).first().click({ timeout: 1000 });
        await page.waitForTimeout(200);
      }
    } catch (_) {}
  }
}

module.exports = { takePortalScreenshots };
