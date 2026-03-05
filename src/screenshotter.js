const { chromium } = require('playwright');

async function takePortalScreenshots(portalUrl, auth, screenshotItems, onProgress) {
  const base = portalUrl.replace(/\/$/, '');
  const { sessionCookies, login, password } = auth || {};
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

    if (sessionCookies?.trim()) {
      // ── Вариант 1: cookie-based авторизация ──────────────────────────────
      const cookies = parseCookieString(sessionCookies, base);
      if (cookies.length === 0) throw new Error('Не удалось распарсить cookies. Формат: name=value; name2=value2');
      await context.addCookies(cookies);
      console.log(`[screenshotter] Injected ${cookies.length} cookies. Verifying portal access...`);
      await verifyPortalAccess(page, base);
    } else {
      // ── Вариант 2: логин через bitrix24.net/passport/view/ ───────────────
      console.log('[screenshotter] No cookies provided — using passport login');
      await loginViaPassport(page, base, login, password);
    }

    for (let i = 0; i < screenshotItems.length; i++) {
      const item = screenshotItems[i];
      if (!item.analysis) continue;

      const { steps = [], description = '' } = item.analysis;
      if (onProgress) onProgress(i, screenshotItems.length, description);

      const start = Date.now();
      try {
        // Hard cap 60s per screenshot
        await Promise.race([
          executeSteps(page, base, steps),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout 60s')), 60000)),
        ]);
        const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 } });
        const shotData = { data: buf.toString('base64'), mimeType: 'image/png' };
        results[item.src] = shotData;
        if (item.absoluteUrl) results[item.absoluteUrl] = shotData;
        console.log(`[screenshotter] ✅ "${description}" (${Date.now() - start}ms)`);
      } catch (err) {
        console.error(`[screenshotter] ❌ "${description}" (${Date.now() - start}ms): ${err.message}`);
        // Fallback: store original Russian screenshot so HTML still has an image
        if (item.originalData) {
          const fallback = { data: item.originalData, mimeType: item.originalMime || 'image/png', isFallback: true };
          results[item.src] = fallback;
          if (item.absoluteUrl) results[item.absoluteUrl] = fallback;
          console.log(`[screenshotter] ↩️  Using original RU screenshot as fallback for "${description}"`);
        }
        if (onProgress) onProgress(i, screenshotItems.length, `⚠️ ${err.message}`);
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
      console.log(`[step] goto ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2000);
      await dismissPopups(page);
      break;
    }

    case 'waitNetworkIdle': {
      await Promise.race([
        page.waitForLoadState('networkidle'),
        page.waitForTimeout(8000),
      ]);
      break;
    }

    case 'expandMenu': {
      // Expand a left-menu section (e.g. CRM) if it is collapsed
      const menuItem = step.menuItem || '';
      console.log(`[step] expandMenu "${menuItem}"`);
      const selectors = [
        `[data-menu-item="${menuItem.toLowerCase()}"]`,
        `a[href*="/${menuItem.toLowerCase()}/"]`,
        `.left-menu-item:has-text("${menuItem}")`,
        `.menu-item-link:has-text("${menuItem}")`,
      ];
      let expanded = false;
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.click({ timeout: 2000 });
            await page.waitForTimeout(500);
            expanded = true;
            break;
          }
        } catch (_) {}
      }
      if (!expanded) console.warn(`[step] expandMenu: "${menuItem}" not found`);
      break;
    }

    case 'switchView': {
      const viewType = (step.viewType || 'list').toLowerCase();
      console.log(`[step] switchView "${viewType}"`);
      const viewSelectors = {
        list: [
          '[data-id="list"]', '.crm-toolbar-list-btn', 'button[title*="List" i]',
          '[data-view="list"]', '.ui-grid-header-btn[data-value="list"]',
        ],
        kanban: [
          '[data-id="kanban"]', '.crm-toolbar-kanban-btn', 'button[title*="Kanban" i]',
          '[data-view="kanban"]', '.ui-grid-header-btn[data-value="kanban"]',
        ],
        calendar: [
          '[data-id="calendar"]', 'button[title*="Calendar" i]',
          '[data-view="calendar"]',
        ],
        gantt: [
          '[data-id="gantt"]', 'button[title*="Gantt" i]',
        ],
      };
      const sels = viewSelectors[viewType] || [];
      let switched = false;
      for (const sel of sels) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.click({ timeout: 2000 });
            await page.waitForTimeout(1000);
            switched = true;
            break;
          }
        } catch (_) {}
      }
      if (!switched) console.warn(`[step] switchView: "${viewType}" button not found`);
      break;
    }

    case 'openCreateForm': {
      console.log('[step] openCreateForm');
      const createSelectors = [
        '.crm-btn-add', '[data-action="add"]', 'button.ui-btn-success',
        '.tasks-task-create-btn', '[data-action="create-task"]',
        'button:has-text("Create")', 'a:has-text("Create")',
        '[data-role="create-btn"]',
      ];
      let opened = false;
      for (const sel of createSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click({ timeout: 3000 });
            await page.waitForTimeout(1500);
            opened = true;
            break;
          }
        } catch (_) {}
      }
      if (!opened) console.warn('[step] openCreateForm: create button not found');
      break;
    }

    case 'clickWidget': {
      const widgetSels = [
        ...(step.widgetSelectors || []),
        // Common Bitrix24 tariff/limits widget selectors
        '.b24-tariff-info', '.tariff-block', "[class*='tariff']",
        '.b24net-tariff', '.feed-desktop__plan',
        '.b24-limits-widget', "[class*='limits']", '.feed-desktop-limits',
        '.b24-demo-panel', "[class*='demo']", '.feed-desktop__demo',
      ];
      let clicked = false;
      for (const sel of widgetSels) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.click({ timeout: 2000 });
            await page.waitForTimeout(2000);
            clicked = true;
            console.log(`[step] clickWidget: found "${sel}"`);
            break;
          }
        } catch (_) {}
      }
      if (!clicked) console.warn('[step] clickWidget: no widget found, proceeding anyway');
      break;
    }

    case 'click': {
      await tryClickWithRetry(page, step.selector, step.fallbackText);
      await page.waitForTimeout(800);
      break;
    }
    case 'clickText': {
      let clicked = false;
      try {
        await page.getByText(step.text, { exact: false }).first().click({ timeout: 5000 });
        clicked = true;
      } catch {}
      if (!clicked) {
        try { await page.getByRole('button', { name: step.text }).first().click({ timeout: 3000 }); } catch {}
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
      // Short timeout — element may not appear if popup/panel wasn't triggered
      try {
        await page.waitForSelector(step.selector, { timeout: 3000 });
      } catch {
        console.warn(`[step] waitForSelector: "${step.selector}" not found within 3s, continuing`);
      }
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

async function tryClickWithRetry(page, selector, fallbackText, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click({ timeout: 4000 });
        return true;
      }
    } catch (_) {}
    if (i < retries) await page.waitForTimeout(1000);
  }
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

// ─── Passport login (fallback when no cookies) ────────────────────────────────

// Two-step login on https://bitrix24.net/passport/view/ (Vue SPA):
//   Step 1: #login (email) → button.b24net-text-btn--call-to-action (Continue)
//   Step 2: .b24net-password-enter-form__password input → .b24net-password-enter-form__continue-btn
async function loginViaPassport(page, base, login, password) {
  if (!login || !password) throw new Error('Логин и пароль обязательны когда cookies не указаны');

  const passportUrl = 'https://bitrix24.net/passport/view/';
  console.log(`[login] Opening passport: ${passportUrl}`);
  await page.goto(passportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log(`[login] Passport loaded. URL: ${page.url()}`);

  // Step 1: email
  const loginInput = page.locator('#login');
  await loginInput.waitFor({ state: 'visible', timeout: 10000 });
  console.log(`[login] Filling email: ${login}`);
  await loginInput.click();
  await loginInput.fill(login);
  await page.waitForTimeout(300);

  console.log('[login] Clicking Continue...');
  await page.locator('button.b24net-text-btn--call-to-action').first().click();

  // Step 2: wait for password field
  const passwordWrapper = page.locator('.b24net-password-enter-form__password');
  try {
    await passwordWrapper.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    const emailErr = await page.locator('.b24net-text-input__error').first().isVisible({ timeout: 500 }).catch(() => false)
      ? (await page.locator('.b24net-text-input__error').first().innerText().catch(() => '')).trim()
      : null;
    throw new Error(emailErr ? `Email ошибка: ${emailErr}` : `Поле пароля не появилось. URL: ${page.url()}`);
  }

  console.log('[login] Filling password...');
  const passwordInput = page.locator('.b24net-password-enter-form__password input').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
  await passwordInput.click();
  await passwordInput.fill(password);
  await page.waitForTimeout(300);

  console.log('[login] Clicking Login button...');
  await page.locator('.b24net-password-enter-form__continue-btn').first().click();
  await page.waitForTimeout(4000);
  console.log(`[login] After submit URL: ${page.url()}`);

  // Check password error
  const passErrVisible = await page.locator('.b24net-password-enter-form .b24net-text-input__error').first().isVisible({ timeout: 500 }).catch(() => false);
  if (passErrVisible) {
    const errText = (await page.locator('.b24net-password-enter-form .b24net-text-input__error').first().innerText().catch(() => '')).trim();
    throw new Error(`Неверный пароль: ${errText || 'проверьте логин и пароль'}`);
  }

  // Navigate to portal after successful passport login
  console.log(`[login] ✅ Passport login OK. Navigating to portal: ${base}/`);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  if (url.includes('/login') || url.includes('/auth') || url.includes('bitrix24.net')) {
    throw new Error(`Портал не принял сессию. URL: ${url}`);
  }
  console.log(`[login] ✅ Portal access OK. URL: ${url}`);
}

module.exports = { takePortalScreenshots };
