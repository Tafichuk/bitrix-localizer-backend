const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://bxtest21.bitrix24.fr';
const LOGIN = 'fra7882@gmail.com';
const PASSWORD = 'Roslombard312';

async function doLogin(page) {
  await page.goto('https://bitrix24.net/passport/view/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login', { state: 'visible', timeout: 20000 });
  await page.fill('#login', LOGIN);
  await page.click('button.b24net-text-btn--call-to-action');
  await page.waitForSelector('.b24net-password-enter-form__password input', { state: 'visible', timeout: 10000 });
  await page.fill('.b24net-password-enter-form__password input', PASSWORD);
  await page.click('.b24net-password-enter-form__continue-btn');
  await page.waitForTimeout(4000);
  console.log('[login] URL after login:', page.url());
}

async function research2() {
  const debugDir = path.join(__dirname, 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await doLogin(page);

  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // ─── 1. Find REAL post selector ──────────────────────────────────────────
  console.log('\n=== 1. Real post selectors ===');
  const postInfo = await page.evaluate(() => {
    const byLogEntry = document.querySelectorAll('div[id^="log-entry-"]');
    const byFeedPost = Array.from(document.querySelectorAll('.feed-post-block'))
      .filter(el => el.id && el.id.startsWith('log-entry-'));

    const firstReal = byLogEntry[0];
    return {
      'div[id^="log-entry-"]_count': byLogEntry.length,
      'firstReal_id': firstReal ? firstReal.id : null,
      'firstReal_class': firstReal ? firstReal.className : null,
      // Check for specific post-action elements in first real post
      'firstReal_html_snippet': firstReal ? firstReal.innerHTML.substring(0, 500) : null,
    };
  });
  console.log('REAL POST INFO:', JSON.stringify(postInfo, null, 2));

  // ─── 2. Hover on real post, find pin button ───────────────────────────────
  console.log('\n=== 2. Hover on real post ===');
  const firstRealPost = page.locator('div[id^="log-entry-"]').first();
  await firstRealPost.hover();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(debugDir, 'r2_01_hover_real_post.png') });

  const postButtons = await page.evaluate(() => {
    // Find elements in the first real post that are visible after hover
    const post = document.querySelector('div[id^="log-entry-"]');
    if (!post) return [];
    return Array.from(post.querySelectorAll('*'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.width < 60 && rect.height < 60;
      })
      .slice(0, 30)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 100),
        id: el.id || '',
        title: el.title || el.getAttribute('aria-label') || '',
        text: el.textContent.trim().substring(0, 20),
        dataId: el.getAttribute('data-id') || '',
        style: el.getAttribute('style') || '',
      }));
  });
  console.log('BUTTONS IN FIRST POST AFTER HOVER:', JSON.stringify(postButtons, null, 2));

  // ─── 3. Find pin icon specifically ───────────────────────────────────────
  console.log('\n=== 3. Pin icon search ===');
  const pinSearch = await page.evaluate(() => {
    const pinCandidates = Array.from(document.querySelectorAll([
      '.feed-post-block-pin-icon',
      '[class*="pin-icon"]',
      '[class*="post-pin"]',
      '[title*="pin"]', '[title*="Pin"]', '[title*="épingler"]', '[title*="Épingler"]',
      '[data-action*="pin"]',
      '.livefeed-event-footer-btn-pin',
      '.feed-event-pin',
      '[class*="livefeed"][class*="pin"]',
    ].join(', '))).map(el => ({
      tag: el.tagName,
      class: el.className.substring(0, 100),
      title: el.title || el.getAttribute('aria-label') || '',
      text: el.textContent.trim().substring(0, 30),
      visible: el.offsetParent !== null,
    }));
    return pinCandidates;
  });
  console.log('PIN CANDIDATES:', JSON.stringify(pinSearch, null, 2));

  // ─── 4. Top-right of first post - small icons ────────────────────────────
  console.log('\n=== 4. Top-right icons of first post ===');
  const topRightIcons = await page.evaluate(() => {
    const post = document.querySelector('div[id^="log-entry-"]');
    if (!post) return null;
    const rect = post.getBoundingClientRect();

    // Find elements in top-right quadrant of the post
    const postChildren = Array.from(post.querySelectorAll('*'));
    return postChildren
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // In top 80px of post, right side (> center x)
        if (r.top < rect.top) return false;
        if (r.top > rect.top + 80) return false;
        if (r.left < rect.left + rect.width / 2) return false;
        return true;
      })
      .slice(0, 20)
      .map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 100),
        id: el.id,
        title: el.title || el.getAttribute('aria-label') || '',
        text: el.textContent.trim().substring(0, 20),
        rect: {
          top: Math.round(el.getBoundingClientRect().top),
          left: Math.round(el.getBoundingClientRect().left),
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        },
      }));
  });
  console.log('TOP-RIGHT ICONS OF FIRST POST:', JSON.stringify(topRightIcons, null, 2));

  // ─── 5. Click More button on first post ──────────────────────────────────
  console.log('\n=== 5. More button click ===');
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const firstPost2 = page.locator('div[id^="log-entry-"]').first();
  await firstPost2.hover();
  await page.waitForTimeout(800);

  // Find and click more button WITHIN the post
  const moreInPost = await page.evaluate(() => {
    const post = document.querySelector('div[id^="log-entry-"]');
    if (!post) return null;
    const more = post.querySelector('.feed-post-more-link, [class*="more-link"], [data-action="showMenu"]');
    if (more) {
      return { found: true, class: more.className, text: more.textContent.trim().substring(0, 20) };
    }
    return { found: false };
  });
  console.log('More button in first post:', moreInPost);

  // Click it
  try {
    const moreBtn = firstPost2.locator('.feed-post-more-link').first();
    if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(debugDir, 'r2_02_more_menu.png') });

      const menuItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(
          '.popup-window-content li, .menu-popup-items li, [class*="popup"][class*="item"], [class*="menu"][class*="item"]'
        ))
          .filter(el => el.offsetParent !== null)
          .map(el => ({
            class: el.className.substring(0, 80),
            text: el.textContent.trim().substring(0, 60),
            dataAction: el.getAttribute('data-action') || el.getAttribute('data-value') || '',
            id: el.id || '',
          }));
      });
      console.log('MENU ITEMS (full):', JSON.stringify(menuItems, null, 2));
    }
  } catch (e) {
    console.log('More button click failed:', e.message);
  }

  // ─── 6. Pinned panel structure ───────────────────────────────────────────
  console.log('\n=== 6. Pinned panel structure ===');
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const pinnedInfo = await page.evaluate(() => {
    const panel = document.querySelector('.feed-pinned-panel');
    return {
      exists: !!panel,
      html: panel ? panel.outerHTML.substring(0, 1000) : null,
      class: panel ? panel.className : null,
      style: panel ? panel.getAttribute('style') : null,
      parentClass: panel ? panel.parentElement.className.substring(0, 80) : null,
    };
  });
  console.log('PINNED PANEL:', JSON.stringify(pinnedInfo, null, 2));

  await page.screenshot({ path: path.join(debugDir, 'r2_03_stream_pinned.png') });

  // ─── 7. Test pinning via More menu ───────────────────────────────────────
  console.log('\n=== 7. Test pin action ===');
  const firstPost3 = page.locator('div[id^="log-entry-"]').first();
  await firstPost3.hover();
  await page.waitForTimeout(500);

  const moreBtnInPost = firstPost3.locator('.feed-post-more-link').first();
  if (await moreBtnInPost.isVisible({ timeout: 2000 }).catch(() => false)) {
    await moreBtnInPost.click();
    await page.waitForTimeout(600);

    // Click "Épingler" (Pin)
    const pinMenuItem = page.locator('.popup-window-content li, .menu-popup-items li').filter({ hasText: /Épingler|Pin/i }).first();
    if (await pinMenuItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Clicking Épingler...');
      await pinMenuItem.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(debugDir, 'r2_04_after_pin.png') });

      const pinnedAfter = await page.evaluate(() => {
        const panel = document.querySelector('.feed-pinned-panel');
        const posts = document.querySelectorAll('.feed-post-block-pin, [class*="pinned"]');
        return {
          panelText: panel ? panel.textContent.trim().substring(0, 100) : 'no panel',
          pinnedCount: posts.length,
          pinnedClasses: Array.from(posts).slice(0, 3).map(el => el.className.substring(0, 60)),
        };
      });
      console.log('AFTER PIN:', JSON.stringify(pinnedAfter, null, 2));
    } else {
      console.log('Pin menu item not found');
      await page.screenshot({ path: path.join(debugDir, 'r2_04_no_pin_item.png') });
    }
  }

  // ─── 8. Filter / Favourites ───────────────────────────────────────────────
  console.log('\n=== 8. Filter investigation ===');
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Look at the three-dots button near "Fil d'actualités" heading
  const filterAreaInfo = await page.evaluate(() => {
    // Find the "Fil d'actualités" heading area
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,.feed-desktop__title,[class*="page-title"],[class*="section-title"]'))
      .filter(el => el.textContent.includes("actualités") || el.textContent.includes("Fil d"));

    const filterArea = document.querySelector('.ui-toolbar-filter-box, .main-ui-filter-wrapper, .feed-list-filter');
    const allBtnsNearFilter = filterArea ?
      Array.from(filterArea.querySelectorAll('button, [role="button"], a, span[data-action]'))
        .map(el => ({ tag: el.tagName, class: el.className.substring(0, 80), text: el.textContent.trim().substring(0, 40), title: el.title || '' }))
      : [];

    // Three-dots button (⋯) next to feed title
    const dots3 = Array.from(document.querySelectorAll('[class*="dots"], [class*="more-btn"], [class*="menu-btn"]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.top < 300 && r.width > 0;
      })
      .map(el => ({ tag: el.tagName, class: el.className.substring(0, 80), text: el.textContent.trim().substring(0, 20) }));

    return {
      headings: headings.slice(0, 3).map(el => ({ tag: el.tagName, class: el.className.substring(0, 60), text: el.textContent.trim().substring(0, 30) })),
      filterAreaBtns: allBtnsNearFilter.slice(0, 10),
      dots3: dots3.slice(0, 5),
    };
  });
  console.log('FILTER AREA INFO:', JSON.stringify(filterAreaInfo, null, 2));

  // Try clicking the "⋯" button near filter/title
  const dotsBtn = page.locator('.feed-desktop__more-btn, [class*="feed"][class*="more-btn"], [data-action="showDropdown"]').first();
  if (await dotsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('Found dots button, clicking...');
    await dotsBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(debugDir, 'r2_05_dots_menu.png') });
  } else {
    // Try the "..." button visible in screenshot near filter
    console.log('Trying filter area buttons...');
    const btn683 = page.locator('.feed-list-top-block button, .feed-list-top-panel button, [id*="feed-filter"] button').first();
    if (await btn683.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn683.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(debugDir, 'r2_05_filter_btn.png') });
    } else {
      // Last resort - click by coordinate near the dots icon visible in screenshot
      await page.screenshot({ path: path.join(debugDir, 'r2_05_no_filter_btn.png') });
      console.log('Could not find filter button');
    }
  }

  // ─── 9. Look for "Favoris" filter specifically ────────────────────────────
  console.log('\n=== 9. Favourites filter via URL ===');
  await page.goto(`${PORTAL_URL}/stream/?type=BOOKMARK`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(debugDir, 'r2_06_favorites_url.png') });
  console.log('Favorites URL result:', page.url());

  // Also try the standard filter
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Find the preset filter items
  const presetFilters = await page.evaluate(() => {
    // Look for preset filter buttons (timeline filters)
    const allText = Array.from(document.querySelectorAll('*'))
      .filter(el => {
        const txt = el.textContent.trim();
        return (txt === 'Favoris' || txt === 'Mes favoris' || txt === 'Favourites') &&
               el.children.length <= 2;
      })
      .slice(0, 5)
      .map(el => ({ tag: el.tagName, class: el.className.substring(0, 80), text: el.textContent.trim() }));
    return allText;
  });
  console.log('PRESET FILTER "Favoris" items:', JSON.stringify(presetFilters, null, 2));

  console.log('\n=== DONE ===');
  await browser.close();
}

research2().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
