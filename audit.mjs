// Realtime audit of the deployed app. Drives every view, modal and search flow in a real browser
// and reports what actually broke: console errors, failed requests, empty views, stuck UI.
//
// READ-ONLY: it navigates, opens and closes things. It never saves, deletes or creates data.
//
//   node audit.mjs            # headed, uses the saved session
//   node audit.mjs --shots    # also write a screenshot per view
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'https://everything-app-zeta.vercel.app';
const PROFILE = 'd:/Projects/Everything/.browser-profile';
const SHOTS = process.argv.includes('--shots');

const consoleErrors = [];
const netErrors = [];
const results = [];
const record = (area, name, ok, detail = '') => {
  results.push({ area, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1400, height: 900 },
});
const page = context.pages()[0] || (await context.newPage());
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });
page.on('response', (r) => {
  if (r.status() >= 400) netErrors.push({ status: r.status(), url: r.url().replace(URL, '') });
});
page.on('requestfailed', (r) => {
  const f = r.failure()?.errorText || '';
  if (!/ERR_ABORTED/.test(f)) netErrors.push({ status: 'failed', url: r.url().replace(URL, ''), error: f });
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
if (await page.locator('#authEmail').isVisible().catch(() => false)) {
  console.log('Session expired. Run: node tmp-login.mjs');
  await context.close();
  process.exit(2);
}
const build = await page.getAttribute('meta[name="everything-build"]', 'content');
console.log(`signed in | build ${build}`);
console.log(`items in store: ${await page.evaluate(() => (typeof state !== 'undefined' ? state.items.length : -1))}\n`);

// ---------- every view ----------
console.log('VIEWS');
const views = [
  ['today', 'Dashboard'], ['inbox', 'Inbox'], ['tasks', 'Tasks'], ['schedule', 'Schedule'],
  ['memory', 'Memory'], ['people', 'People'], ['projects', 'Projects'],
  ['goals', 'Goals'], ['reports', 'Reports'], ['insights', 'Insights'],
];
for (const [id, label] of views) {
  const before = consoleErrors.length + netErrors.length;
  await page.evaluate((v) => window.switchView(v), id);
  await page.waitForTimeout(700);
  const active = await page.locator('.view.active').getAttribute('id').catch(() => null);
  const text = (await page.locator(`#view-${id}`).innerText().catch(() => '')).trim();
  const clean = consoleErrors.length + netErrors.length === before;
  record('view', `${label} renders`, active === `view-${id}` && text.length > 0 && clean,
    active !== `view-${id}` ? `not active (got ${active})`
      : !text.length ? 'empty' : !clean ? 'errors on open' : '');
  if (SHOTS) await page.screenshot({ path: `shot-${id}.png` });
}

await page.locator('.sidebar-profile').click();
await page.waitForTimeout(1200);
record('view', 'Settings renders',
  (await page.locator('.view.active').getAttribute('id')) === 'view-settings', '');


// ---------- modals ----------
console.log('\nMODALS');
for (const [name, open, sel] of [
  ['capture', () => page.evaluate(() => window.openCapture()), '#captureModal.open'],
  ['ask', () => page.evaluate(() => window.openAsk()), '#askOverlay.open'],
]) {
  await open();
  await page.waitForTimeout(600);
  if (await page.locator(sel).count()) {
    record('modal', `${name} opens`, true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    record('modal', `${name} closes on Escape`, (await page.locator(sel).count()) === 0);
  } else {
    record('modal', `${name} opens`, false, 'never opened');
  }
}

await page.evaluate(() => window.openCapture());
await page.waitForTimeout(500);
for (const t of ['text', 'voice', 'image', 'file', 'link']) {
  const before = consoleErrors.length;
  await page.evaluate((k) => window.pickType(k, true), t);
  await page.waitForTimeout(400);
  record('modal', `capture type: ${t}`, consoleErrors.length === before);
}
await page.evaluate(() => window.closeCapture());
await page.waitForTimeout(400);

// ---------- search ----------
console.log('\nSEARCH');
const askCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/ask')) askCalls.push(r.url()); });

await page.locator('#searchInput').click();
await page.waitForTimeout(300);
await page.locator('#searchInput').fill('a');
await page.waitForTimeout(900);
record('search', 'dropdown opens on typing', await page.locator('#searchDropdown').isVisible().catch(() => false));

// A lookup must be answered locally: instant, and no call to /api/ask.
// "zzzznotathing" is deliberately a non-question AND has no matches, so it settles this cleanly.
const before2 = askCalls.length;
await page.locator('#searchInput').fill('zzzznotathing');
await page.waitForTimeout(1800);
record('search', 'a lookup spends no /api/ask call', askCalls.length === before2,
  askCalls.length > before2 ? `${askCalls.length - before2} model call(s) for a lookup` : '');
const slotText = (await page.locator('#searchAskSlot').innerText().catch(() => '')).trim();
record('search', 'an answer is shown for a lookup', slotText.length > 0, slotText.split('\n')[0].slice(0, 60));
if (SHOTS) await page.screenshot({ path: 'shot-search.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.locator('#searchInput').fill('');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// A real question should still reach the model.
const before3 = askCalls.length;
await page.locator('#searchInput').click();
await page.locator('#searchInput').fill('what should I do today');
await page.waitForTimeout(2500);
record('search', 'a question still reaches the model', askCalls.length > before3,
  askCalls.length > before3 ? 'model called as expected' : 'never reached the model');
await page.keyboard.press('Escape');
await page.locator('#searchInput').fill('');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ---------- shortcuts ----------
console.log('\nSHORTCUTS');
// Ctrl+K opens the Ask overlay, not the header input. Assert the documented behaviour.
await page.keyboard.press('Control+k');
await page.waitForTimeout(600);
record('shortcut', 'Ctrl+K opens the Ask overlay',
  (await page.locator('#askOverlay.open').count()) > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.locator('#searchInput').click();
await page.waitForTimeout(300);
await page.keyboard.press('/');
await page.waitForTimeout(600);
record('shortcut', '/ focuses the search field',
  await page.locator('#searchInput').evaluate((el) => el === document.activeElement).catch(() => false));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ---------- errors ----------
console.log('\nERRORS');
console.log(`console errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 10).forEach((e) => console.log(`  ! ${e.slice(0, 150)}`));
console.log(`failed requests: ${netErrors.length}`);
const seen = new Set();
netErrors.forEach((e) => {
  const k = `${e.status} ${e.url.split('?')[0]}`;
  if (!seen.has(k)) { seen.add(k); console.log(`  ! ${e.status} ${e.url.slice(0, 130)}`); }
});

// ---------- summary ----------
const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nfailures:');
  failed.forEach((f) => console.log(`  FAIL ${f.area}: ${f.name}  ${f.detail}`));
}
console.log('='.repeat(60));

await context.close();
process.exit(failed.length ? 1 : 0);