const { chromium } = require('playwright');

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

    await loginToPortal(page, base, login, password);

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

// ─── Login ────────────────────────────────────────────────────────────────────

async function loginToPortal(page, base, login, password) {
  console.log(`[login] Opening ${base}/`);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait up to 8s for either login form or logged-in indicator
  const state = await waitForLoginOrDashboard(page, 8000);

  if (state === 'dashboard') {
    console.log('[login] Already logged in');
    return;
  }

  if (state === 'not_found') {
    // Try /login/ path directly
    console.log('[login] Form not found at /, trying /login/');
    await page.goto(`${base}/login/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const state2 = await waitForLoginOrDashboard(page, 8000);
    if (state2 === 'dashboard') return;
    if (state2 === 'not_found') throw new Error(`Форма входа не найдена. Текущий URL: ${page.url()}`);
  }

  // Fill credentials
  await fillField(page, ['input[name="USER_LOGIN"]', 'input[name="login"]', 'input[type="email"]'], login);
  await fillField(page, ['input[name="USER_PASSWORD"]', 'input[name="password"]', 'input[type="password"]'], password);

  // Submit
  const submitted = await trySubmit(page);
  if (!submitted) throw new Error('Не удалось отправить форму входа');

  // Wait for redirect / dashboard
  await page.waitForTimeout(3000);

  const finalState = await waitForLoginOrDashboard(page, 6000);
  if (finalState !== 'dashboard') {
    // Check for error message on the page
    const errText = await getVisibleError(page);
    const currentUrl = page.url();
    throw new Error(errText || `Авторизация не удалась. URL после входа: ${currentUrl}`);
  }

  console.log(`[login] ✅ Logged in. URL: ${page.url()}`);
}

async function waitForLoginOrDashboard(page, timeoutMs) {
  const loginSelectors = [
    'input[name="USER_LOGIN"]',
    'input[name="login"]',
    'input[type="email"][autocomplete]',
  ];
  const dashboardSelectors = [
    '#bx-panel',
    '.bx-layout-user-block',
    '.feed-add-post-form',
    '[class*="global-menu"]',
    '.crm-btn-add',
    '.tasks-task-create-btn',
    '.im-sidebar',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of dashboardSelectors) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 300 })) return 'dashboard';
      } catch (_) {}
    }
    for (const sel of loginSelectors) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 300 })) return 'login_form';
      } catch (_) {}
    }
    await page.waitForTimeout(500);
  }
  return 'not_found';
}

async function fillField(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 2000 });
        await el.fill(value, { timeout: 2000 });
        return true;
      }
    } catch (_) {}
  }
  console.warn(`[login] Could not fill field with selectors: ${selectors.join(', ')}`);
  return false;
}

async function trySubmit(page) {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    '.login-btn',
    '.bx-login-button',
    'button.ui-btn',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 3000 });
        return true;
      }
    } catch (_) {}
  }
  // Fallback: press Enter
  try {
    await page.keyboard.press('Enter');
    return true;
  } catch (_) {}
  return false;
}

async function getVisibleError(page) {
  const errSelectors = [
    '.login-form-error',
    '.bx-login-error',
    '[class*="error"]',
    '.alert-danger',
  ];
  for (const sel of errSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        const text = await el.innerText();
        if (text.trim()) return `Ошибка на портале: ${text.trim()}`;
      }
    } catch (_) {}
  }
  return null;
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
