/**
 * Tests src/feed-screenshots.js via the public API.
 */
const { chromium } = require('playwright');
const { loginToPortal } = require('./src/screenshotter');
const { makeFeedScreenshot } = require('./src/feed-screenshots');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://bxtest21.bitrix24.fr';
const DEBUG = path.join(__dirname, 'debug');
fs.mkdirSync(DEBUG, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    console.log('Logging in...');
    const context = await loginToPortal(browser, PORTAL_URL, null, 'fra7882@gmail.com', 'Roslombard312');
    console.log('✅ Login OK');

    for (let i = 1; i <= 5; i++) {
      console.log(`\nTaking screenshot ${i}/5...`);
      const buf = await makeFeedScreenshot(context, PORTAL_URL, i);
      const outPath = path.join(DEBUG, `module_shot_${i}.png`);
      fs.writeFileSync(outPath, buf);
      console.log(`  ✅ module_shot_${i}.png (${Math.round(buf.length / 1024)}KB)`);
    }

    await context.close();
    console.log('\n✅ All done. Check debug/module_shot_*.png');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
