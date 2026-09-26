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

// ---------- 4. rename and remove ----------
console.log('\nRENAME AND REMOVE');
await page.evaluate(() => { window.confirm = () => true; });
await reset();
await page.evaluate(() => {
  state.projects = [{ id: 'j1', name: 'Hom', created: Date.now() }];
  state.people = [{ id: 'p1', name: 'ravi', notes: '', created: Date.now() }];
  state.items = [
    { id: 'i1', kind: 'task', title: 'Fix the roof', person: 'Ravi', project: 'Hom', created: Date.now() },
    { id: 'i2', kind: 'task', title: 'Call plumber', person: 'RAVI', project: 'hom', created: Date.now() },
    { id: 'i3', kind: 'task', title: 'Unrelated', person: 'Priya', project: 'Office', created: Date.now() },
  ];
  renderProjects();
  renderPeople();
});
// A backup edited by hand can arrive with no kind at all. Today used to throw on that and stop
// rendering, so the rest of the view came up empty.
await page.evaluate(() => {
  state.items.push({ id: 'i4', title: 'No kind at all', created: Date.now() });
  renderToday();
});
say('Today survives an item with no kind', await page.locator('#recentList').count(), 1);
say('the kindless item is still listed', await page.evaluate(() =>
  document.getElementById('recentList').textContent.includes('No kind at all')), true);
await page.evaluate(() => { state.items.pop(); renderToday(); });
// A typo'd name used to strand its items with no way back. Renaming must carry them along.
await page.evaluate(() => window.renameProject('j1', 'Home Renovation'));
say('renaming a project retags its items',
  JSON.stringify(await page.evaluate(() => state.items.map((i) => i.project))),
  JSON.stringify(['Home Renovation', 'Home Renovation', 'Office']));
say('the project keeps the new name', await page.evaluate(() => state.projects[0].name), 'Home Renovation');

await page.evaluate(() => window.renamePerson('ravi', 'Ravi Kumar'));
say('renaming a person retags their items',
  JSON.stringify(await page.evaluate(() => state.items.map((i) => i.person))),
  JSON.stringify(['Ravi Kumar', 'Ravi Kumar', 'Priya']));

await page.evaluate(() => window.deletePerson('Ravi Kumar'));
say('removing a person deletes the record',
  JSON.stringify(await page.evaluate(() => state.people.map((p) => p.name))), '[]');
// renderPeople() infers people from the items that name them, so a surviving tag would re-add them.
say('removing a person untags their items so they do not reappear',
  JSON.stringify(await page.evaluate(() =>
    state.items.filter((i) => i.person && i.person.trim()).map((i) => i.id))), '["i3"]');
say('the people list no longer shows them',
  (await page.locator('#peopleList').innerText()).includes('Ravi Kumar'), false);

// ---------- 5. goals can be renamed, and their controls survive any id ----------
console.log('\nGOALS');
await page.evaluate(() => {
  window.confirm = () => true;
  window.alert = () => {};
  state.goals = [];
  return window.switchView('goals');
});
await page.evaluate(() => {
  document.getElementById('newGoalInput').value = 'Ship the beta';
  return window.addGoal();
});
say('a goal is added through the real input',
  await page.evaluate(() => state.goals[0].title), 'Ship the beta');

await page.evaluate(() => window.renameGoal(state.goals[0].id, 'Ship the beta properly'));
say('renaming a goal writes the new title',
  await page.evaluate(() => state.goals[0].title), 'Ship the beta properly');
say('the renamed goal is on screen',
  (await page.locator('#goalsList').innerText()).includes('Ship the beta properly'), true);
say('a blank rename is refused rather than blanking the goal',
  await page.evaluate(() => window.renameGoal(state.goals[0].id, '   ').then(() => state.goals[0].title)),
  'Ship the beta properly');

// A hand-edited backup can carry any id. A quote in one used to render a handler the parser
// rejects, which left that goal with a dead tick and a dead Delete.
await page.evaluate(() => {
  state.goals = [{ id: "o'brien", title: 'From a backup', done: false, created: Date.now() }];
  renderGoals();
});
const goalOnclick = await page.locator('#goalsList .checkbox').first().getAttribute('onclick');
console.log(`  onclick="${goalOnclick}"`);
say('a quoted goal id still produces a valid handler', await page.evaluate((src) => {
  try { new Function('return (' + src + ');'); return 'parses'; } catch (e) { return e.constructor.name + ': ' + e.message; }
}, goalOnclick), 'parses');
say('clicking the tick reaches toggleGoal() with the real id', await page.evaluate(() => {
  const orig = window.toggleGoal;
  window.__goalId = null;
  window.toggleGoal = (a) => { window.__goalId = a; };
  document.querySelector('#goalsList .checkbox').click();
  window.toggleGoal = orig;
  return window.__goalId;
}), "o'brien");
const goalRenameOnclick = await page.locator('#goalsList .btn:not(.danger)').first().getAttribute('onclick');
console.log(`  onclick="${goalRenameOnclick}"`);
say('the Rename button carries both the id and the current title', JSON.stringify(await page.evaluate(() => {
  const orig = window.startRenameGoal;
  window.__args = null;
  window.startRenameGoal = (a, b) => { window.__args = [a, b]; };
  document.querySelector('#goalsList .btn:not(.danger)').click();
  window.startRenameGoal = orig;
  return window.__args;
})), JSON.stringify(["o'brien", 'From a backup']));

// ---------- 6. handlers built from user data, and a kindless related item ----------
console.log('\nRELATED CHIPS AND HANDLER SAFETY');
await page.evaluate(() => {
  window.confirm = () => true;
  window.alert = () => {};
  state.people = [];
  state.projects = [];
  state.items = [
    { id: 'c1', kind: 'task', title: 'Call the plumber', person: "O'Brien", project: "Mom's Home", created: Date.now() },
    { id: 'c2', title: 'No kind at all', person: "O'Brien", project: "Mom's Home", created: Date.now() },
  ];
});
say('opening an item whose related list holds a kindless item does not throw',
  await page.evaluate(() => {
    try { window.openPanel('c1'); return 'opened'; }
    catch (e) { return e.constructor.name + ': ' + e.message; }
  }), 'opened');
say('the kindless related item is still listed in the panel',
  await page.evaluate(() => document.getElementById('panelRelated').textContent.includes('No kind at all')), true);
const chipOnclicks = await page.evaluate(() =>
  [...document.querySelectorAll('#panelRelated [onclick]')].map((el) => el.getAttribute('onclick')));
console.log(`  chips: ${JSON.stringify(chipOnclicks)}`);
// Compile the handler the way a browser does — as a function body — so a stray quote fails here.
say('every related chip compiles as a handler', await page.evaluate((srcs) => {
  for (const src of srcs) {
    try { new Function('closePanel', 'openPersonModal', 'openPanel', 'switchView', src); }
    catch (e) { return `${e.constructor.name} for ${src}`; }
  }
  return `all parse (${srcs.length})`;
}, chipOnclicks), `all parse (${chipOnclicks.length})`);
say('the apostrophe person chip is present at all',
  chipOnclicks.some((s) => s.includes('openPersonModal')), true);

// The same quoted-interpolation mistake in the other rendered lists: a hand-edited backup can carry
// any item id, and a quote in one used to leave that row with a dead click target.
await page.evaluate(() => {
  state.items = [{ id: "id'with'quotes", kind: 'memory', title: 'From a backup', created: Date.now() }];
  renderMemory();
});
const memoryOnclick = await page.locator('#memoryGrouped [onclick]').first().getAttribute('onclick');
console.log(`  memory row: ${JSON.stringify(memoryOnclick)}`);
say('a quoted item id still produces a working memory row', await page.evaluate((src) => {
  try { new Function('openPanel', src); return 'parses'; } catch (e) { return `${e.constructor.name} for ${src}`; }
}, memoryOnclick), 'parses');

console.log(`\npage errors: ${errors.length}`);
errors.forEach((e) => console.log(`  ! ${e.slice(0, 140)}`));
await context.close();
