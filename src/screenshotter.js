const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ─── Section map ──────────────────────────────────────────────────────────────
let sectionMap = {};
try {
  sectionMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'section-map.json'), 'utf8'));
  console.log(`[screenshotter] Section map loaded: ${Object.keys(sectionMap).length} sections`);
} catch (err) {
  console.warn('[screenshotter] section-map.json not found:', err.message);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a Playwright browser context with auth (cookies or passport login).
 * Returns the context — caller is responsible for closing it and the browser.
 */
async function loginToPortal(browser, portalUrl, sessionCookies, login, password) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  if (sessionCookies && sessionCookies.trim()) {
    const cookies = parseCookieString(sessionCookies, portalUrl);
    if (cookies.length === 0) throw new Error('Cannot parse cookies. Format: name=value; name2=value2');
    await context.addCookies(cookies);
    console.log(`[auth] Injected ${cookies.length} cookies`);
    await verifyPortalAccess(page, portalUrl);
  } else {
    console.log('[auth] No cookies — using passport login');
    await loginViaPassport(page, portalUrl, login, password);
  }

  await page.close();
  return context;
}

/**
 * Navigates to the right section/step and takes a screenshot.
 * Returns a Buffer (PNG) or throws on failure.
 */
async function takeScreenshot(context, portalUrl, sectionKey, step) {
  const sectionConfig = sectionMap[sectionKey];
  if (!sectionConfig) {
    console.warn(`[nav] Unknown section "${sectionKey}", using Feed fallback`);
  }
  const cfg = sectionConfig || { portalPath: '/stream/', waitSelector: '.feed-post-list', steps: { default: [] } };

  const page = await context.newPage();
  try {
    const url = `${portalUrl.replace(/\/$/, '')}${cfg.portalPath}`;
    console.log(`[nav] goto ${url} (${sectionKey}/${step})`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    await dismissPopups(page);

    // Wait for main section element
    if (cfg.waitSelector) {
      try {
        await page.waitForSelector(cfg.waitSelector, { timeout: 8000 });
      } catch {
        console.warn(`[nav] waitSelector "${cfg.waitSelector}" not found, continuing`);
      }
    }

    // Execute step actions
    const stepsMap = cfg.steps || {};
    const actions = stepsMap[step] || stepsMap['default'] || [];
    for (const action of actions) {
      try {
        await executeAction(page, action);
      } catch (err) {
        console.warn(`[nav] action "${action.action}" error: ${err.message}`);
      }
    }

    // Final settle before screenshot
    await page.waitForTimeout(1000);

    const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 } });
    return buffer;
  } finally {
    await page.close();
  }
}

// ─── Action executor ──────────────────────────────────────────────────────────

async function executeAction(page, action) {
  switch (action.action) {
    case 'wait':
      await page.waitForTimeout(Math.min(action.ms || 1000, 5000));
      break;

    case 'waitForSelector':
      try {
        await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 });
      } catch {
        console.warn(`[nav] waitForSelector "${action.selector}" not found`);
      }
      break;

    case 'clickBest': {
      let clicked = false;
      for (const sel of (action.candidates || [])) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 })) {
            await el.click({ timeout: 3000 });
            clicked = true;
            console.log(`[nav] clickBest hit: "${sel}"`);
            break;
          }
        } catch {}
      }
      if (!clicked) {
        console.warn(`[nav] clickBest: none found in [${(action.candidates || []).join(', ')}]`);
      }
      break;
    }

    case 'fill':
      try {
        await page.locator(action.selector).first().fill(action.value || '');
      } catch (e) {
        console.warn(`[nav] fill "${action.selector}": ${e.message}`);
      }
      break;

    case 'scroll':
      await page.evaluate((px) => window.scrollBy(0, px), action.pixels || 300);
      await page.waitForTimeout(300);
      break;

    default:
      console.warn(`[nav] Unknown action: ${action.action}`);
  }
}

// ─── Cookie parsing ───────────────────────────────────────────────────────────

function parseCookieString(cookieStr, portalBase) {
  const url = `${portalBase.replace(/\/$/, '')}/`;
  return cookieStr
    .split(';')
    .map(p => p.trim())
    .filter(p => p.includes('='))
    .map(p => {
      const eq = p.indexOf('=');
      return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), url };
    })
    .filter(c => c.name);
}

// ─── Portal access verification ───────────────────────────────────────────────

async function verifyPortalAccess(page, base) {
  const url = `${base.replace(/\/$/, '')}/`;
  console.log(`[auth] Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const current = page.url();
  if (current.includes('bitrix24.net') || current.includes('/login') || current.includes('/auth')) {
    throw new Error(`Cookies expired or invalid. Portal redirected to: ${current}`);
  }

  const dashboardFound = await isDashboard(page);
  if (!dashboardFound) {
    await page.waitForTimeout(2000);
    if (!await isDashboard(page)) {
      const finalUrl = page.url();
      if (finalUrl.includes('/login') || finalUrl.includes('/auth')) {
        throw new Error(`Auth via cookies failed. URL: ${finalUrl}. Please renew cookies.`);
      }
      console.warn(`[auth] ⚠️ Dashboard not confirmed. URL: ${finalUrl}`);
    }
  }
  console.log(`[auth] ✅ Portal OK. URL: ${page.url()}`);
}

async function isDashboard(page) {
  const sels = ['#bx-panel', '.bx-layout-user-block', '.feed-add-post-form', '[class*="global-menu"]', '.crm-btn-add'];
  for (const sel of sels) {
    try { if (await page.locator(sel).first().isVisible({ timeout: 300 })) return true; } catch {}
  }
  return false;
}

// ─── Passport login ───────────────────────────────────────────────────────────

async function loginViaPassport(page, base, login, password) {
  if (!login || !password) throw new Error('Login and password required when cookies are not provided');

  const passportUrl = 'https://bitrix24.net/passport/view/';
  console.log(`[auth] Opening passport: ${passportUrl}`);
  await page.goto(passportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Step 1: email
  const loginInput = page.locator('#login');
  await loginInput.waitFor({ state: 'visible', timeout: 10000 });
  await loginInput.fill(login);
  await page.waitForTimeout(300);

  await page.locator('button.b24net-text-btn--call-to-action').first().click();

  // Step 2: password
  const passwordWrapper = page.locator('.b24net-password-enter-form__password');
  try {
    await passwordWrapper.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    const errText = await page.locator('.b24net-text-input__error').first().innerText().catch(() => '');
    throw new Error(errText ? `Email error: ${errText}` : `Password field not shown. URL: ${page.url()}`);
  }

  const passwordInput = page.locator('.b24net-password-enter-form__password input').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
  await passwordInput.fill(password);
  await page.waitForTimeout(300);

  await page.locator('.b24net-password-enter-form__continue-btn').first().click();
  await page.waitForTimeout(4000);

  const passErrVisible = await page.locator('.b24net-password-enter-form .b24net-text-input__error').first().isVisible({ timeout: 500 }).catch(() => false);
  if (passErrVisible) {
    const errText = await page.locator('.b24net-password-enter-form .b24net-text-input__error').first().innerText().catch(() => '');
    throw new Error(`Incorrect password: ${errText || 'please check credentials'}`);
  }

  console.log(`[auth] ✅ Passport login OK. Navigating to portal: ${base}`);
  await page.goto(`${base.replace(/\/$/, '')}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  if (url.includes('/login') || url.includes('/auth') || url.includes('bitrix24.net')) {
    throw new Error(`Portal rejected session. URL: ${url}`);
  }
  console.log(`[auth] ✅ Portal access OK. URL: ${url}`);
}

// ─── Popup dismissal ──────────────────────────────────────────────────────────

async function dismissPopups(page) {
  for (const sel of ['.popup-window-close-icon', '.ui-popup-close', '[data-role="close"]']) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 400 })) {
        await page.locator(sel).first().click({ timeout: 1000 });
        await page.waitForTimeout(200);
      }
    } catch {}
  }
}

module.exports = { loginToPortal, takeScreenshot };
