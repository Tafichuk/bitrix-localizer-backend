const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const PORTAL = 'https://tafichuk.bitrix24.fr';
  const EMAIL  = 'fra7882@gmail.com';
  const PASS   = 'Roslombard312';

  console.log('1. Navigating to portal...');
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('   URL:', page.url());
  console.log('   Title:', await page.title());

  // Step 1: enter email
  const emailInput = await page.$('input[type="email"], input[name="LOGIN"], input[id="login"]');
  if (emailInput) {
    console.log('2. Entering email...');
    await emailInput.fill(EMAIL);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    console.log('   URL after email:', page.url());
  } else {
    console.log('   No email input found!');
    await page.screenshot({ path: '/tmp/login_step1.png' });
    console.log('   Screenshot: /tmp/login_step1.png');
  }

  // Step 2: enter password (may appear after email step)
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    console.log('3. Entering password...');
    await passInput.fill(PASS);
    await page.keyboard.press('Enter');
    console.log('   Waiting for redirect...');
    await page.waitForTimeout(8000);
    console.log('   URL after login:', page.url());
    console.log('   Title:', await page.title());
  } else {
    console.log('   No password input found!');
    await page.screenshot({ path: '/tmp/login_step2.png' });
    console.log('   Screenshot: /tmp/login_step2.png');
  }

  const cookies = await ctx.cookies();
  const auth = { portal_url: PORTAL, cookies };
  const authPath = path.join(__dirname, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
  console.log('4. Saved', cookies.length, 'cookies to auth.json');

  // Check if we're actually logged in
  const loggedIn = page.url().includes(PORTAL.replace('https://', ''));
  console.log('   Logged in:', loggedIn, '|', page.url().slice(0, 60));

  await browser.close();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
