/**
 * Test script for all 5 Feed screenshots.
 * Run: node test-feed-shots.js
 * Saves results to debug/shot_1..5.png
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://bxtest21.bitrix24.fr';
const LOGIN = 'fra7882@gmail.com';
const PASSWORD = 'Roslombard312';
const DEBUG = path.join(__dirname, 'debug');

fs.mkdirSync(DEBUG, { recursive: true });

// ─── Login ────────────────────────────────────────────────────────────────────
async function loginToPortal(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  await page.goto('https://bitrix24.net/passport/view/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login', { state: 'visible', timeout: 20000 });
  await page.fill('#login', LOGIN);
  await page.click('button.b24net-text-btn--call-to-action');
  await page.waitForSelector('.b24net-password-enter-form__password input', { state: 'visible', timeout: 10000 });
  await page.fill('.b24net-password-enter-form__password input', PASSWORD);
  await page.click('.b24net-password-enter-form__continue-btn');
  await page.waitForTimeout(4000);
  console.log('[auth] URL after login:', page.url());
  await page.close();
  return context;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function gotoStream(page) {
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // Dismiss any popups
  for (const sel of ['.popup-window-close-icon', '.ui-popup-close', '[data-role="close"]']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForTimeout(200);
    }
  }
}

// Returns first visible real post (not hidden form)
function firstPost(page) {
  return page.locator('.feed-post-block:visible').first();
}

// ─── Screenshot 1: Pin icon visible on post hover ─────────────────────────────
async function shot1(context) {
  console.log('\n[shot1] Pin icon on hover...');
  const page = await context.newPage();
  try {
    await gotoStream(page);
    const post = firstPost(page);
    await post.waitFor({ state: 'visible', timeout: 8000 });
    await post.hover();
    await page.waitForTimeout(800);

    // Verify pin icon is visible
    const pinVisible = await page.locator('.feed-post-pin').first().isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  .feed-post-pin visible: ${pinVisible}`);

    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(DEBUG, 'shot_1.png'), buf);
    console.log('  ✅ shot_1.png saved');
    return buf;
  } finally {
    await page.close();
  }
}

// ─── Screenshot 2: Pinned banner expanded ─────────────────────────────────────
async function shot2(context) {
  console.log('\n[shot2] Pinned banner expanded...');
  const page = await context.newPage();
  try {
    await gotoStream(page);

    // Check if pinned panel already has posts
    const panelCount = await page.locator('.feed-post-collapsed-panel-count-posts').first().textContent({ timeout: 2000 }).catch(() => '0');
    console.log(`  Pinned posts count in panel: "${panelCount.trim()}"`);

    // If 0 pinned — pin the first post via its pin button
    if (panelCount.trim() === '0' || panelCount.trim() === '') {
      console.log('  Pinning first post...');
      const post = firstPost(page);
      await post.hover();
      await page.waitForTimeout(600);

      const pinBtn = post.locator('.feed-post-pin').first();
      const pinBtnVisible = await pinBtn.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`  .feed-post-pin visible: ${pinBtnVisible}`);

      if (pinBtnVisible) {
        await pinBtn.click();
        await page.waitForTimeout(2000);
        console.log('  Pin button clicked, URL:', page.url());
      } else {
        // Fallback: use More menu → Épingler
        console.log('  Trying More menu → Épingler...');
        await post.hover();
        await page.waitForTimeout(500);
        const moreBtn = page.locator('.feed-post-more-link').first();
        if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await moreBtn.click();
          await page.waitForTimeout(600);
          const epinglerItem = page.locator('.popup-window-inner-content').getByText('Épingler').first();
          if (await epinglerItem.isVisible({ timeout: 2000 }).catch(() => false)) {
            await epinglerItem.click();
            await page.waitForTimeout(2000);
            console.log('  Épingler clicked');
          } else {
            console.warn('  Épingler not found in menu');
            await page.screenshot({ path: path.join(DEBUG, 'shot_2_debug_menu.png') });
          }
        }
      }
    }

    // Reload stream to show updated state
    await gotoStream(page);

    // Expand panel if collapsed
    const expandLink = page.locator('.feed-post-pinned-link-expand').first();
    if (await expandLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expandLink.click();
      await page.waitForTimeout(800);
      console.log('  Expanded pinned panel');
    } else {
      console.log('  No expand link found (already expanded or no pins)');
    }

    await page.screenshot({ path: path.join(DEBUG, 'shot_2_debug.png') });

    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(DEBUG, 'shot_2.png'), buf);
    console.log('  ✅ shot_2.png saved');
    return buf;
  } finally {
    await page.close();
  }
}

// ─── Screenshot 3: Multiple pins collapsed ────────────────────────────────────
async function shot3(context) {
  console.log('\n[shot3] Multiple pinned collapsed...');
  const page = await context.newPage();
  try {
    await gotoStream(page);

    // Pin a second post
    const posts = page.locator('.feed-post-block:visible');
    const secondPost = posts.nth(1);
    if (await secondPost.isVisible({ timeout: 3000 }).catch(() => false)) {
      await secondPost.hover();
      await page.waitForTimeout(600);
      const pinBtn2 = secondPost.locator('.feed-post-pin').first();
      if (await pinBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
        await pinBtn2.click();
        await page.waitForTimeout(2000);
        console.log('  Second post pinned');
      } else {
        // More menu fallback
        const moreBtn2 = secondPost.locator('.feed-post-more-link').first();
        if (await moreBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
          await moreBtn2.click();
          await page.waitForTimeout(600);
          const epinglerItem = page.locator('.popup-window-inner-content').getByText('Épingler').first();
          if (await epinglerItem.isVisible({ timeout: 2000 }).catch(() => false)) {
            await epinglerItem.click();
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    await gotoStream(page);

    // Collapse the panel (click réduire or the collapsed panel header)
    const collapseLink = page.locator('.feed-post-pinned-link-collapse').first();
    if (await collapseLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await collapseLink.click();
      await page.waitForTimeout(600);
      console.log('  Collapsed pinned panel');
    } else {
      // Try clicking the panel header to collapse
      const panelHeader = page.locator('.feed-post-collapsed-panel').first();
      if (await panelHeader.isVisible({ timeout: 2000 }).catch(() => false)) {
        await panelHeader.click();
        await page.waitForTimeout(600);
        console.log('  Clicked panel header');
      }
    }

    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(DEBUG, 'shot_3.png'), buf);
    console.log('  ✅ shot_3.png saved');
    return buf;
  } finally {
    await page.close();
  }
}

// ─── Screenshot 4: More menu open with Favourite option ──────────────────────
async function shot4(context) {
  console.log('\n[shot4] More menu with Favourite...');
  const page = await context.newPage();
  try {
    await gotoStream(page);
    const post = firstPost(page);
    await post.waitFor({ state: 'visible', timeout: 8000 });
    await post.hover();
    await page.waitForTimeout(600);

    const moreBtn = post.locator('.feed-post-more-link').first();
    if (!await moreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Try global selector
      await page.locator('.feed-post-more-link').first().click();
    } else {
      await moreBtn.click();
    }
    await page.waitForTimeout(800);

    // Log what popup items are visible
    const popupItems = await page.evaluate(() => {
      const popup = document.querySelector('.popup-window-inner-content, .popup-window-content');
      if (!popup) return 'NO POPUP';
      return Array.from(popup.querySelectorAll('a, li, span'))
        .filter(el => el.offsetParent !== null && el.textContent.trim())
        .map(el => `${el.tagName}: "${el.textContent.trim().substring(0, 40)}"`)
        .join('\n');
    });
    console.log('  Popup items:', popupItems);

    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(DEBUG, 'shot_4.png'), buf);
    console.log('  ✅ shot_4.png saved');
    return buf;
  } finally {
    await page.close();
  }
}

// ─── Screenshot 5: Filter open with Favourites ───────────────────────────────
async function shot5(context) {
  console.log('\n[shot5] Filter with Favourites...');
  const page = await context.newPage();
  try {
    await gotoStream(page);

    // Try 1: click the filter search input to expand filter sidebar
    const filterInput = page.locator('.main-ui-filter-search-filter').first();
    if (await filterInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await filterInput.click();
      await page.waitForTimeout(800);
      console.log('  Clicked filter input');
    }

    // Check if sidebar is now expanded (has visible items)
    const favItem = page.locator('.main-ui-filter-sidebar-item').filter({ hasText: /Favoris|Favorites/i }).first();
    let favVisible = await favItem.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Favoris item visible after input click: ${favVisible}`);

    if (!favVisible) {
      // Try 2: click three-dots button near the feed title
      const dotsBtn = page.locator('.ui-btn.ui-btn-light-border.ui-btn-round').first();
      if (await dotsBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dotsBtn.click();
        await page.waitForTimeout(800);
        console.log('  Clicked dots button');
        favVisible = await favItem.isVisible({ timeout: 2000 }).catch(() => false);
        console.log(`  Favoris item visible after dots click: ${favVisible}`);
      }
    }

    if (!favVisible) {
      // Try 3: look for any preset filter tab
      const allFilterItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="filter-preset"], [class*="filter-item"], .main-ui-filter-sidebar-item'))
          .map(el => ({
            class: el.className.substring(0, 80),
            text: el.textContent.trim().substring(0, 40),
            visible: el.offsetParent !== null,
          }));
      });
      console.log('  All filter items:', JSON.stringify(allFilterItems, null, 2));
    }

    // Click Favoris if visible
    if (await favItem.isVisible({ timeout: 1000 }).catch(() => false)) {
      await favItem.click();
      await page.waitForTimeout(1000);
      console.log('  Clicked Favoris');
    } else {
      console.warn('  Favoris item not visible, taking screenshot as-is');
    }

    await page.screenshot({ path: path.join(DEBUG, 'shot_5_debug.png') });

    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(DEBUG, 'shot_5.png'), buf);
    console.log('  ✅ shot_5.png saved');
    return buf;
  } finally {
    await page.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    console.log('Logging in...');
    const context = await loginToPortal(browser);
    console.log('✅ Login OK');

    await shot1(context);
    await shot2(context);
    await shot3(context);
    await shot4(context);
    await shot5(context);

    await context.close();
    console.log('\n✅ All 5 screenshots done. Check debug/shot_1..5.png');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
