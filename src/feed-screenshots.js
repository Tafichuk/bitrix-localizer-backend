/**
 * Feed screenshot sequences for the Bitrix24 "Activity Stream" article.
 *
 * Each function navigates the portal, sets up the required UI state, and
 * returns a PNG Buffer.  Functions are designed to be called in index order
 * (1 → 5) within a single browser context but on freshly opened pages.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Take one of the 5 Feed screenshots.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} portalUrl   e.g. "https://bxtest21.bitrix24.fr"
 * @param {number} index       1-based screenshot number (1..5)
 * @returns {Promise<Buffer>}  PNG buffer
 */
async function makeFeedScreenshot(context, portalUrl, index) {
  const base = portalUrl.replace(/\/$/, '');
  const page = await context.newPage();
  try {
    switch (index) {
      case 1: return await _shot1_pinIcon(page, base);
      case 2: return await _shot2_pinnedExpanded(page, base);
      case 3: return await _shot3_pinnedCollapsed(page, base);
      case 4: return await _shot4_moreMenu(page, base);
      case 5: return await _shot5_filterFavourites(page, base);
      default: return await _defaultShot(page, base);
    }
  } finally {
    await page.close();
  }
}

module.exports = { makeFeedScreenshot };

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _gotoStream(page, base) {
  await page.goto(`${base}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // Dismiss popups
  for (const sel of ['.popup-window-close-icon', '.ui-popup-close', '[data-role="close"]']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}

// Returns the first visible, real post (not the hidden form block)
function _firstPost(page) {
  return page.locator('.feed-post-block:visible').first();
}

/**
 * Ensures the pinned panel has at least `needed` posts.
 * Pins posts from the main feed as needed.
 */
async function _ensurePinCount(page, needed) {
  // Read actual pin count from the panel counter
  const countText = await page.locator('.feed-post-collapsed-panel-count-posts').first().textContent({ timeout: 2000 }).catch(() => '0');
  const currentCount = parseInt(countText.trim(), 10) || 0;
  console.log(`  [ensurePinCount] current=${currentCount}, needed=${needed}`);

  if (currentCount >= needed) return;

  const toPin = needed - currentCount;
  const posts = page.locator('.feed-post-block:visible');
  const total = await posts.count();

  let pinned = 0;
  for (let i = 0; i < total && pinned < toPin; i++) {
    const post = posts.nth(i);

    // Skip if this post is already in pinned state (has Détacher in its menu)
    const alreadyPinned = await post.locator('.feed-post-pinned-link-collapse, .feed-post-pinned-link-expand').count().catch(() => 0);
    if (alreadyPinned > 0) continue;

    await post.hover();
    await page.waitForTimeout(400);

    // Try direct pin button first
    const pinBtn = post.locator('.feed-post-pin').first();
    if (await pinBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await pinBtn.click();
      await page.waitForTimeout(1500);
      pinned++;
      continue;
    }

    // Fallback: More menu → Épingler
    const moreBtn = post.locator('.feed-post-more-link').first();
    if (await moreBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(500);
      // Look for "Épingler" in the popup (not "Détacher")
      const epinglerItem = page.locator('.popup-window-inner-content a, .popup-window-inner-content span')
        .filter({ hasText: /^Épingler$/ }).first();
      if (await epinglerItem.isVisible({ timeout: 1500 }).catch(() => false)) {
        await epinglerItem.click();
        await page.waitForTimeout(1500);
        pinned++;
      } else {
        // Close popup and try next post
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }
  }
}

// ─── Shot 1: Pin icon visible on hover ───────────────────────────────────────

async function _shot1_pinIcon(page, base) {
  await _gotoStream(page, base);
  const post = _firstPost(page);
  await post.waitFor({ state: 'visible', timeout: 8000 });
  await post.hover();
  await page.waitForTimeout(800);
  return page.screenshot({ type: 'png' });
}

// ─── Shot 2: Pinned banner expanded ──────────────────────────────────────────

async function _shot2_pinnedExpanded(page, base) {
  await _gotoStream(page, base);
  await _ensurePinCount(page, 1);
  await _gotoStream(page, base);

  // Expand if collapsed
  const expandLink = page.locator('.feed-post-pinned-link-expand').first();
  if (await expandLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await expandLink.click();
    await page.waitForTimeout(800);
  }

  return page.screenshot({ type: 'png' });
}

// ─── Shot 3: Multiple pins collapsed ─────────────────────────────────────────

async function _shot3_pinnedCollapsed(page, base) {
  await _gotoStream(page, base);
  await _ensurePinCount(page, 2);
  await _gotoStream(page, base);

  // Collapse if expanded
  const collapseLink = page.locator('.feed-post-pinned-link-collapse').first();
  if (await collapseLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await collapseLink.click();
    await page.waitForTimeout(600);
  } else {
    // Try clicking the panel header itself
    const panelHeader = page.locator('.feed-post-collapsed-panel').first();
    if (await panelHeader.isVisible({ timeout: 1000 }).catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(600);
    }
  }

  return page.screenshot({ type: 'png' });
}

// ─── Shot 4: More menu open with "Favourite" ─────────────────────────────────

async function _shot4_moreMenu(page, base) {
  await _gotoStream(page, base);
  const post = _firstPost(page);
  await post.waitFor({ state: 'visible', timeout: 8000 });
  await post.hover();
  await page.waitForTimeout(600);

  const moreBtn = post.locator('.feed-post-more-link').first();
  await moreBtn.waitFor({ state: 'visible', timeout: 4000 });
  await moreBtn.click();
  await page.waitForTimeout(800);

  return page.screenshot({ type: 'png' });
}

// ─── Shot 5: Filter open with "Favourites" selected ──────────────────────────

async function _shot5_filterFavourites(page, base) {
  await _gotoStream(page, base);

  // Click the filter search input to expand the filter sidebar
  const filterInput = page.locator('.main-ui-filter-search-filter').first();
  if (await filterInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await filterInput.click();
    await page.waitForTimeout(600);
  }

  // Click "Favoris" / "Favourites" in the filter sidebar
  const favItem = page.locator('.main-ui-filter-sidebar-item').filter({ hasText: /Favoris|Favorites|Favourites/i }).first();
  if (await favItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await favItem.click();
    await page.waitForTimeout(1000);
  } else {
    // Fallback: add ?type=BOOKMARK to URL
    await page.goto(`${base}/stream/?type=BOOKMARK`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  return page.screenshot({ type: 'png' });
}

// ─── Default fallback ─────────────────────────────────────────────────────────

async function _defaultShot(page, base) {
  await _gotoStream(page, base);
  return page.screenshot({ type: 'png' });
}
