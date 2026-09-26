// Opens a real, visible Chromium at the deployed app and waits for you to sign in.
// The profile is persistent (userDataDir), so the Supabase session is kept on disk and later
// scripts can reuse it without asking you to log in again.
//
//   node tmp-login.mjs
//
// Nothing is typed and no credentials are stored in this repo — the session lives in the
// browser profile under .browser-profile/, which is git-ignored.
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'https://everything-app-zeta.vercel.app';
const PROFILE = 'd:/Projects/Everything/.browser-profile';
const WAIT_MS = 5 * 60 * 1000; // five minutes to sign in

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 800 },
});
const page = context.pages()[0] || (await context.newPage());

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('Browser opened at ' + URL);
console.log('Please sign in in that window. Waiting up to 5 minutes...\n');

const deadline = Date.now() + WAIT_MS;
let signedIn = false;

while (Date.now() < deadline) {
  // The sign-in card is removed from the DOM once a session exists, which is the reliable signal.
  const authVisible = await page.locator('#authEmail').isVisible().catch(() => false);
  if (!authVisible) { signedIn = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}

if (!signedIn) {
  console.log('No sign-in detected within the window. Closing.');
  await context.close();
  process.exit(2);
}

// Confirm it really is the app and not just a blank state.
const build = await page.getAttribute('meta[name="everything-build"]', 'content').catch(() => null);
const headings = (await page.locator('h1:visible').allTextContents()).map((h) => h.trim()).filter(Boolean);
const statTiles = await page.locator('.stat-num').allTextContents();

console.log('SIGNED IN');
console.log('build      : ' + build);
console.log('headings   : ' + (headings.join(' | ') || '(none)'));
console.log('stat tiles : ' + (statTiles.join(', ') || '(none)'));
console.log('js errors  : ' + errors.length);
errors.slice(0, 5).forEach((e) => console.log('  ! ' + e.slice(0, 160)));

await page.screenshot({ path: 'shot-signedin.png' });
console.log('\nscreenshot : shot-signedin.png');

// Leave the browser open? No — closing keeps the persisted profile flushed to disk so the next
// script can reuse the session.
await page.waitForTimeout(1500);
await context.close();
console.log('Session saved to the browser profile. You can run checks without logging in again.');
