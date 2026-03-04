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
  // Шаг 1: авторизуемся через единый паспорт bitrix24.net
  await loginViaPassport(page, login, password);

  // Шаг 2: переходим на портал — сессия подхватится автоматически
  console.log(`[login] Navigating to portal: ${base}/`);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  console.log(`[login] Portal URL after navigation: ${currentUrl}`);

  // Если снова показывает форму логина — пробуем заполнить её напрямую
  const state = await waitForLoginOrDashboard(page, 10000);
  if (state === 'dashboard') {
    console.log(`[login] ✅ Portal loaded. URL: ${page.url()}`);
    return;
  }
  if (state === 'login_form') {
    console.log('[login] Portal shows login form, filling directly...');
    await fillAndSubmitForm(page, login, password);
    await page.waitForTimeout(3000);
    const finalState = await waitForLoginOrDashboard(page, 10000);
    if (finalState !== 'dashboard') {
      const errText = await getVisibleError(page);
      throw new Error(errText || `Авторизация на портале не удалась. URL: ${page.url()}`);
    }
    console.log(`[login] ✅ Logged in via portal form. URL: ${page.url()}`);
    return;
  }

  throw new Error(`Портал не загрузился после авторизации. URL: ${page.url()}`);
}

// Авторизация через https://bitrix24.net/passport/view/
async function loginViaPassport(page, login, password) {
  const passportUrl = 'https://bitrix24.net/passport/view/';
  console.log(`[login] Opening Bitrix24 passport: ${passportUrl}`);
  await page.goto(passportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log(`[login] Passport page URL: ${page.url()}`);

  // Проверяем — возможно уже залогинен
  const alreadyLoggedIn = await isLoggedInToPassport(page);
  if (alreadyLoggedIn) {
    console.log('[login] Already logged in to passport');
    return;
  }

  // Заполняем логин
  const loginFilled = await fillField(
    page,
    ['input[name="USER_LOGIN"]', 'input[name="login"]', 'input[type="email"]', '#login', '#user-login', 'input[autocomplete="username"]'],
    login
  );
  if (!loginFilled) throw new Error(`Не найдено поле логина на странице паспорта: ${page.url()}`);

  // Проверяем — видно ли поле пароля (двухшаговый флоу)
  const passwordVisible = await isPasswordFieldVisible(page);
  if (!passwordVisible) {
    console.log('[login] Password field not visible, clicking Next...');
    await trySubmit(page);
    await page.waitForTimeout(2500);
  }

  // Заполняем пароль
  const passwordFilled = await fillField(
    page,
    ['input[name="USER_PASSWORD"]', 'input[name="password"]', 'input[type="password"]', '#password', 'input[autocomplete="current-password"]'],
    password
  );
  if (!passwordFilled) throw new Error(`Не найдено поле пароля на странице паспорта: ${page.url()}`);

  // Сабмит
  await trySubmit(page);
  console.log('[login] Passport form submitted, waiting...');
  await page.waitForTimeout(3000);

  // Проверяем успех
  const loggedIn = await isLoggedInToPassport(page);
  if (!loggedIn) {
    const errText = await getVisibleError(page);
    throw new Error(errText || `Авторизация через паспорт не удалась. URL: ${page.url()}`);
  }
  console.log(`[login] ✅ Passport login OK. URL: ${page.url()}`);
}

// Проверяем что мы авторизованы на bitrix24.net (не на форме логина)
async function isLoggedInToPassport(page) {
  const url = page.url();
  // Если URL не содержит login/auth — скорее всего залогинены
  if (!url.includes('/login') && !url.includes('/auth') && !url.includes('passport/view') && url.includes('bitrix24.net')) {
    return true;
  }
  // Ищем признаки дашборда паспорта
  for (const sel of ['.passport-user', '.user-name', '[class*="user-block"]', '.b24-user-menu', '#bx-panel']) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 500 })) return true;
    } catch (_) {}
  }
  // Если форма логина всё ещё видна — не залогинены
  for (const sel of ['input[name="USER_LOGIN"]', 'input[name="login"]', 'input[type="email"]']) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 300 })) return false;
    } catch (_) {}
  }
  // Если URL изменился с passport/view — считаем успехом
  if (!url.includes('passport/view')) return true;
  return false;
}

async function isPasswordFieldVisible(page) {
  for (const sel of ['input[name="USER_PASSWORD"]', 'input[type="password"]', '#password', 'input[autocomplete="current-password"]']) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 800 })) return true;
    } catch (_) {}
  }
  return false;
}

async function fillAndSubmitForm(page, login, password) {
  await fillField(page, ['input[name="USER_LOGIN"]', 'input[name="login"]', 'input[type="email"]'], login);
  await fillField(page, ['input[name="USER_PASSWORD"]', 'input[name="password"]', 'input[type="password"]'], password);
  const submitted = await trySubmit(page);
  if (!submitted) throw new Error('Не удалось отправить форму входа');
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
