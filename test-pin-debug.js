const { chromium } = require('playwright');
const { loginToPortal } = require('./src/screenshotter');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://testportal.bitrix24.com';
const DEBUG = path.join(__dirname, 'debug');
fs.mkdirSync(DEBUG, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await loginToPortal(browser, PORTAL_URL, null, 'fra7882@gmail.com', 'Roslombard312');

  const page = await context.newPage();
  await page.goto(`${PORTAL_URL}/stream/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(DEBUG, 'pin_debug_0_initial.png') });

  // Dump the pinned panel HTML
  const pinnedHtml = await page.evaluate(() => {
    const panel = document.querySelector('.feed-pinned-panel');
    if (!panel) return 'NO PANEL';
    return panel.outerHTML.substring(0, 3000);
  });
  console.log('PINNED PANEL HTML:', pinnedHtml);

  // Check all expand/collapse links
  const expandLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.feed-post-pinned-link'))
      .map(el => ({
        class: el.className,
        text: el.textContent.trim(),
        visible: el.offsetParent !== null,
        display: window.getComputedStyle(el).display,
        opacity: window.getComputedStyle(el).opacity,
        rect: (() => { const r = el.getBoundingClientRect(); return `${r.left},${r.top},${r.width}x${r.height}`; })(),
      }));
  });
  console.log('EXPAND/COLLAPSE LINKS:', JSON.stringify(expandLinks, null, 2));

  // Try hovering over pinned panel to make controls visible
  const pinnedPanel = page.locator('.feed-pinned-panel').first();
  if (await pinnedPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
    await pinnedPanel.hover();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(DEBUG, 'pin_debug_1_panel_hover.png') });

    const expandLinksAfterHover = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.feed-post-pinned-link'))
        .map(el => ({
          class: el.className,
          text: el.textContent.trim(),
          visible: el.offsetParent !== null,
          display: window.getComputedStyle(el).display,
        }));
    });
    console.log('LINKS AFTER PANEL HOVER:', JSON.stringify(expandLinksAfterHover, null, 2));
  }

  // Try hovering over individual pinned blocks
  const pinnedBlocks = page.locator('.feed-post-pinned-block');
  const blockCount = await pinnedBlocks.count();
  console.log(`\nPINNED BLOCKS COUNT: ${blockCount}`);

  for (let i = 0; i < blockCount; i++) {
    const block = pinnedBlocks.nth(i);
    await block.hover();
    await page.waitForTimeout(400);

    const expandInBlock = await page.evaluate((idx) => {
      const blocks = document.querySelectorAll('.feed-post-pinned-block');
      const block = blocks[idx];
      if (!block) return null;
      const link = block.querySelector('.feed-post-pinned-link-expand');
      if (!link) return 'NO EXPAND LINK';
      return {
        visible: link.offsetParent !== null,
        display: window.getComputedStyle(link).display,
        opacity: window.getComputedStyle(link).opacity,
        text: link.textContent.trim(),
      };
    }, i);
    console.log(`Block ${i} expand link:`, expandInBlock);
  }

  await page.screenshot({ path: path.join(DEBUG, 'pin_debug_2_after_hover.png') });

  // Try force-clicking the first expand link via JS
  const forceClick = await page.evaluate(() => {
    const link = document.querySelector('.feed-post-pinned-link-expand');
    if (!link) return 'NO LINK';
    link.click();
    return 'CLICKED';
  });
  console.log('Force click result:', forceClick);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEBUG, 'pin_debug_3_after_force_click.png') });

  await page.close();
  await context.close();
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
