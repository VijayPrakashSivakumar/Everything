// Read-only diagnosis of loadProfile() against the live signed-in app.
//
// Four suspected bugs:
//   1. .single() returns 406 when the row does not exist yet (PostgREST PGRST116) — an expected
//      "no profile yet" state is logged as a console error on every load.
//   2. applyFormatPrefs(profile) is called twice in a row.
//   3. sb.auth.getUser() is a second network round trip; the session already has the email.
//   4. loadProfile() runs on every renderSettings(), so the errors repeat on every Settings visit.
//
// Nothing is created, edited or deleted.
//
//   node tmp-profile-check.mjs
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'https://everything-app-zeta.vercel.app';
const PROFILE = 'd:/Projects/Everything/.browser-profile';

const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1280, height: 800 } });
const page = context.pages()[0] || (await context.newPage());

const consoleErrors = [];
const netErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('response', (r) => {
  if (r.status() >= 400) netErrors.push({ status: r.status(), url: r.url().replace(URL, '') });
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
if (await page.locator('#authEmail').isVisible().catch(() => false)) {
  console.log('Session expired. Run tmp-login.mjs first.');
  await context.close();
  process.exit(2);
}
console.log('signed in | build ' + (await page.getAttribute('meta[name="everything-build"]', 'content')));

// --- Bug 1/2/3: the load itself -------------------------------------------------
const supabaseCalls = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('supabase.co') && (u.includes('/rest/v1/') || u.includes('/auth/v1/user'))) supabaseCalls.push(u.replace(/^https:\/\/[^/]+/, ''));
});

await page.locator('.sidebar-profile').click();
await page.waitForTimeout(3000);

console.log('\n--- supabase requests while opening Settings ---');
supabaseCalls.forEach((u) => console.log('  ' + u.slice(0, 150)));

const profileCalls = supabaseCalls.filter((u) => u.includes('profiles'));
const authUserCalls = supabaseCalls.filter((u) => u.includes('auth/v1/user'));
console.log(`\nprofiles requests : ${profileCalls.length}`);
console.log(`auth/v1/user calls: ${authUserCalls.length}  <- a second network round trip for data the session already has`);

// --- Bug 4: does revisiting Settings repeat the failures? ------------------------
const before = netErrors.length;
await page.locator('#navList >> text=Dashboard').first().click();
await page.waitForTimeout(600);
await page.locator('.sidebar-profile').click();
await page.waitForTimeout(2500);
const repeated = netErrors.slice(before);
console.log(`\nfailures on a SECOND Settings visit: ${repeated.length}`);
repeated.forEach((e) => console.log(`  ${e.status} ${e.url.slice(0, 120)}`));

console.log(`\ntotal console errors: ${consoleErrors.length}`);
console.log(`total 4xx/5xx:       ${netErrors.length}`);
const byStatus = {};
netErrors.forEach((e) => { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });
console.log('by status: ' + (Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'));

await page.screenshot({ path: 'shot-settings.png' });
await page.waitForTimeout(800);
await context.close();
console.log('\nscreenshot: shot-settings.png');
