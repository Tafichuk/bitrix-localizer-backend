const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://bxtest21.bitrix24.fr';
const LOGIN = 'fra7882@gmail.com';
const PASSWORD = 'Roslombard312';

async function research() {
  const debugDir = path.join(__dirname, 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // ─── Step 0: Try direct portal login page ────────────────────────────────
  console.log('\n=== STEP 0: Try portal login page directly ===');
  await page.goto('https://bxtest21.bitrix24.fr/auth/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(debugDir, '0_portal_auth.png') });
  console.log('Portal auth URL:', page.url());

  const portalInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, className: el.className.substring(0, 80),
    }))
  );
  console.log('INPUTS ON PORTAL AUTH PAGE:', JSON.stringify(portalInputs, null, 2));

  // ─── Step 0b: Passport with extra wait ───────────────────────────────────
  console.log('\n=== STEP 0b: Passport page ===');
  await page.goto('https://bitrix24.net/passport/view/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for React to hydrate
  try {
    await page.waitForSelector('#login, input[type="email"], input[name="login"]', { state: 'visible', timeout: 20000 });
    console.log('✅ Login input found!');
  } catch (e) {
    console.log('❌ Login input NOT found after 20s. URL:', page.url());
    const html2 = await page.content();
    console.log('HTML length:', html2.length);
    console.log('Has <input:', html2.includes('<input'));
    console.log('Has #root:', html2.includes('id="root"'));
    console.log('Has react:', html2.toLowerCase().includes('react'));
    // Check JS errors
    page.on('console', msg => console.log('PAGE CONSOLE:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(debugDir, '0b_passport_failed.png') });
    throw new Error('Passport form not loading - see debug screenshots');
  }
  await page.screenshot({ path: path.join(debugDir, '0_passport.png') });

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, className: el.className.substring(0, 80),
    }))
  );
  console.log('INPUTS ON PASSPORT PAGE:', JSON.stringify(inputs, null, 2));

  // ─── Step 1: Fill login (email step) ──────────────────────────────────────
  console.log('\n=== STEP 1: Fill email ===');
  const loginInput = page.locator('#login, input[name="login"], input[type="email"]').first();
  await loginInput.waitFor({ state: 'visible', timeout: 10000 });
  await loginInput.fill(LOGIN);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(debugDir, '1_email_filled.png') });

  // Click continue
  const continueBtn = page.locator('button.b24net-text-btn--call-to-action, button[type="submit"]').first();
  await continueBtn.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(debugDir, '2_after_email.png') });

  // ─── Step 2: Fill password ────────────────────────────────────────────────
  console.log('\n=== STEP 2: Fill password ===');
  const passwordInput = page.locator('.b24net-password-enter-form__password input, input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 8000 });
  await passwordInput.fill(PASSWORD);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(debugDir, '3_password_filled.png') });

  const loginBtn = page.locator('.b24net-password-enter-form__continue-btn, button[type="submit"]').first();
  await loginBtn.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(debugDir, '4_after_login.png') });
  console.log('URL after login:', page.url());

  // ─── Step 3: Navigate to portal stream ───────────────────────────────────
  console.log('\n=== STEP 3: Portal stream ===');
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(debugDir, '5_stream.png') });
  console.log('Stream URL:', page.url());

  // ─── Step 4: Inspect stream structure ─────────────────────────────────────
  console.log('\n=== STEP 4: Stream structure ===');
  const streamInfo = await page.evaluate(() => {
    const result = {};

    // ── Posts ──
    const postSelectors = [
      '[class*="feed-post"]', '[class*="log-entry"]', '[class*="livefeed"]',
      '.feed-item', '[data-post-id]', '[data-entity-type]',
    ];
    for (const sel of postSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        result[`posts_${sel}`] = {
          count: els.length,
          firstClass: els[0].className.substring(0, 100),
          firstId: els[0].id || '(no id)',
        };
      }
    }

    // ── Pin-related elements ──
    const pinEls = Array.from(document.querySelectorAll('[class*="pin"]'))
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 80),
        id: el.id || '',
        text: el.textContent.trim().substring(0, 30),
        title: el.title || el.getAttribute('aria-label') || '',
      }));
    result.pinElements = pinEls;

    // ── Filter buttons ──
    const filterEls = Array.from(document.querySelectorAll('[class*="filter"], [data-action*="filter"]'))
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 80),
        text: el.textContent.trim().substring(0, 40),
        dataAction: el.getAttribute('data-action') || '',
      }));
    result.filterElements = filterEls;

    // ── More/dots buttons ──
    const moreEls = Array.from(document.querySelectorAll('[class*="more"], [class*="dots"], [class*="menu"]'))
      .filter(el => {
        const cls = el.className.toLowerCase();
        return cls.includes('more') || cls.includes('dots') || cls.includes('dropdown');
      })
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 80),
        text: el.textContent.trim().substring(0, 30),
        title: el.title || '',
      }));
    result.moreElements = moreEls;

    // ── Toolbar area ──
    const toolbarEls = Array.from(document.querySelectorAll('[class*="toolbar"], [class*="feed-add"], [class*="feed-filter"]'))
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 80),
        id: el.id || '',
      }));
    result.toolbarElements = toolbarEls;

    return result;
  });
  console.log('STREAM STRUCTURE:', JSON.stringify(streamInfo, null, 2));

  // ─── Step 5: Hover over first post ───────────────────────────────────────
  console.log('\n=== STEP 5: Hover first post ===');
  const postSelToTry = [
    '.feed-post-block', '.log-entry', '.feed-item',
    '[data-post-id]', '[class*="feed-post-item"]',
  ];
  let hoverDone = false;
  for (const sel of postSelToTry) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`Hovering: ${sel}`);
      await el.hover();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(debugDir, '6_post_hover.png') });
      hoverDone = true;
      break;
    }
  }
  if (!hoverDone) console.warn('Could not hover any post selector');

  const hoverButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(
      'button:not([style*="display: none"]), [class*="pin"], [class*="star"], [class*="fav"], [class*="bookmark"], [class*="more-btn"], [class*="context-menu"]'
    ))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
      })
      .slice(0, 20)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 100),
        id: el.id || '',
        title: el.title || el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '',
        text: el.textContent.trim().substring(0, 30),
        dataAction: el.getAttribute('data-action') || el.getAttribute('data-role') || '',
      }));
  });
  console.log('VISIBLE BUTTONS AFTER HOVER:', JSON.stringify(hoverButtons, null, 2));

  // ─── Step 6: Try clicking "more/dots" on first post ──────────────────────
  console.log('\n=== STEP 6: Try clicking more/dots ===');
  const moreSelectors = [
    '.feed-post-more-link', '.log-entry-more-link', '[class*="more-link"]',
    '[class*="context-menu-btn"]', '[data-action="showMenu"]', '[data-role="more"]',
    'button[title*="More"]', 'button[title*="Plus"]', 'button[title*="Ещё"]',
    '.feed-event-menu-btn', '[class*="dropdown-btn"]',
  ];
  for (const sel of moreSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      console.log(`More button found: ${sel}`);
      await el.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(debugDir, '7_more_menu.png') });

      // Inspect menu items
      const menuItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(
          '.popup-window-content li, .menu-popup li, [class*="popup"] li, [class*="dropdown"] li, [role="menuitem"]'
        ))
          .filter(el => el.offsetParent !== null)
          .slice(0, 20)
          .map(el => ({
            tag: el.tagName,
            class: el.className.substring(0, 80),
            text: el.textContent.trim().substring(0, 50),
            dataAction: el.getAttribute('data-action') || el.getAttribute('data-value') || '',
          }));
      });
      console.log('MENU ITEMS:', JSON.stringify(menuItems, null, 2));
      break;
    }
  }

  // ─── Step 7: Try filter button ───────────────────────────────────────────
  console.log('\n=== STEP 7: Try filter ===');
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const filterSelectors = [
    '.feed-filter-btn', '[data-action="filter"]', '[class*="feed-filter"]',
    'button:has-text("Filter")', 'button:has-text("Filtre")', 'a:has-text("Filter")',
    '[class*="toolbar"] button', '.feed-add-activity-btn',
  ];
  for (const sel of filterSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      console.log(`Filter button found: ${sel}`);
      await el.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(debugDir, '8_filter_open.png') });

      // Inspect filter items
      const filterItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(
          '.popup-window-content li, [class*="filter"] li, [class*="popup"] li, [role="option"]'
        ))
          .filter(el => el.offsetParent !== null)
          .slice(0, 20)
          .map(el => ({
            class: el.className.substring(0, 80),
            text: el.textContent.trim().substring(0, 50),
            dataFilter: el.getAttribute('data-filter') || el.getAttribute('data-value') || '',
          }));
      });
      console.log('FILTER ITEMS:', JSON.stringify(filterItems, null, 2));
      break;
    }
  }

  // ─── Step 8: Dump ALL visible interactive elements on stream ─────────────
  console.log('\n=== STEP 8: All interactive elements ===');
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const allInteractive = await page.evaluate(() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('button, a[href], [role="button"], [data-action]'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (rect.top < 0 || rect.top > 1000) return false;
        return true;
      })
      .slice(0, 40)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 80),
        id: el.id || '',
        text: el.textContent.trim().substring(0, 40),
        href: el.href ? el.href.substring(0, 60) : '',
        dataAction: el.getAttribute('data-action') || '',
        title: el.title || el.getAttribute('aria-label') || '',
      }));
  });
  console.log('ALL INTERACTIVE (top of page):', JSON.stringify(allInteractive, null, 2));

  // Final screenshot
  await page.screenshot({ path: path.join(debugDir, '9_final.png') });
  console.log('\n=== DONE. Screenshots in ./debug/ ===');

  // Keep browser open for manual inspection
  console.log('Browser stays open for 30s for manual inspection...');
  await page.waitForTimeout(30000);
  await browser.close();
}

research().catch(err => {
  console.error('RESEARCH ERROR:', err);
  process.exit(1);
});
