// Projects view probe. Runs SIGNED OUT in a throwaway profile, so `db` and `sbUser` are null and
// everything stays in localStorage — it cannot reach the real account. Drives the real UI.
//
//   node projects-probe.mjs
import { chromium } from 'playwright';
import OS from 'os';

const URL = process.env.APP_URL || 'https://everything-app-zeta.vercel.app';

// A throwaway profile, so this cannot see the saved session. `db` and `sbUser` stay null and the app
// runs local-only, with the backend hard-blocked below as a second guarantee.
const context = await chromium.launchPersistentContext(OS.tmpdir() + '\\everything-probe', {
  headless: false,
  viewport: { width: 1400, height: 900 },
});
const page = context.pages()[0] || (await context.newPage());
// Hard guarantee that this probe cannot touch the real account: no request leaves for the backend.
await page.route('**/*.supabase.co/**', (r) => r.abort());
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log(`  ! pageerror: ${e.message.slice(0, 160)}`); });
page.on('console', (m) => { if (m.type() === 'error') console.log(`  ! console: ${m.text().slice(0, 160)}`); });
page.on('requestfailed', (r) => {
  const t = r.failure()?.errorText || '';
  if (!/ERR_ABORTED/.test(t)) console.log(`  ! request failed: ${r.url().slice(0, 100)} ${t}`);
});
// Note: APP_URL can point at a local `npm run serve`, but loopback is unreachable from the bundled
// Chromium in some environments. Against the deployed app this is reliable.
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
// No session, so the app is local-only. Wait for the app to boot, then reveal the UI behind login.
const booted = await page
  .waitForFunction(() => typeof window.switchView === 'function', null, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
if (!booted) {
  console.log('\n  the app never finished booting; the page is not usable yet');
  console.log(`  url=${URL}`);
  await context.close();
  process.exit(2);
}
await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
await page.waitForTimeout(500);

const say = (name, got, want) =>
  console.log(`  ${got === want ? 'PASS' : 'FAIL'}  ${name}  got ${JSON.stringify(got)}${got === want ? '' : ` want ${JSON.stringify(want)}`}`);

const reset = () => page.evaluate(() => {
  state.projects = [];
  state.items = [];
  document.getElementById('newProjectInput').value = '';
  renderProjects();
});

const addProject = (name) => page.evaluate((n) => {
  document.getElementById('newProjectInput').value = n;
  return window.addProject().then(() => state.projects.map((p) => p.name));
}, name);

// ---------- 1. duplicate creation ----------
console.log('\nDUPLICATE CREATION');
await reset();
const afterFirst = await addProject('Home');
say('first "Home" is created', afterFirst.length, 1);
const afterCase = await addProject('home');
say('"home" is refused as a duplicate of "Home"', afterCase.length, 1);
const afterSpace = await addProject('  Home  ');
say('"  Home  " is refused as a duplicate', afterSpace.length, 1);

// ---------- 2. counts when duplicates do exist ----------
console.log('\nLINKED ITEM COUNTS');
await reset();
await page.evaluate(() => {
  state.projects = [{ id: 'p1', name: 'Home', created: Date.now() }];
  state.items = [
    { id: 'i1', title: 'Fix the roof', sub: '', done: false, project: 'home', created: Date.now() },
    { id: 'i2', title: 'Call plumber', sub: '', done: true, project: '  HOME ', created: Date.now() },
    { id: 'i3', title: 'Archived one', sub: '', done: false, project: 'Home', archivedAt: Date.now() },
    { id: 'i4', title: 'Other project', sub: '', done: false, project: 'Office', created: Date.now() },
  ];
  renderProjects();
});
const card = await page.locator('#projectsList .card').first();
const text = await card.innerText();
say('case/whitespace-different items count as linked', /50% complete \(1\/2\)/.test(text), true);
say('archived items are excluded', text.includes('Archived one'), false);
say('items from another project are excluded', text.includes('Other project'), false);

// ---------- 3. apostrophes in names ----------
console.log('\nAPOSTROPHES IN NAMES');
await reset();
await addProject("Mom's Project");
const onclick = await page.locator('#projectsList .btn.danger').first().getAttribute('onclick');
console.log(`  onclick="${onclick}"`);
const parses = await page.evaluate((src) => {
  try { new Function('return (' + src + ');'); return 'parses'; } catch (e) { return e.constructor.name + ': ' + e.message; }
}, onclick.replace(/^deleteProject/, 'deleteProject'));
say('the Delete handler is valid JavaScript', parses, 'parses');
const called = await page.evaluate((id) => {
  const orig = window.deleteProject;
  window.__hit = false;
  window.deleteProject = (a) => { window.__hit = a; };
  document.querySelector('#projectsList .btn.danger').click();
  window.deleteProject = orig;
  return window.__hit;
}, 'x');
say('clicking Delete reaches deleteProject()', typeof called === 'string' && called.length > 0, true);

console.log(`\npage errors: ${errors.length}`);
errors.forEach((e) => console.log(`  ! ${e.slice(0, 140)}`));
await context.close();
