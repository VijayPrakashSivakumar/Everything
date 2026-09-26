// Projects view probe. Runs SIGNED OUT in a throwaway profile, so `db` and `sbUser` are null and
// everything stays in localStorage — it cannot reach the real account. Drives the real UI.
//
//   node projects-probe.mjs
import { chromium } from 'playwright';
import OS from 'os';
import fs from 'fs';

const URL = process.env.APP_URL || 'https://everything-app-zeta.vercel.app';

// A throwaway profile, so this cannot see the saved session. `db` and `sbUser` stay null and the app
// runs local-only, with the backend hard-blocked below as a second guarantee.
//
// The profile is wiped first: it keeps the service worker, and a cached shell would let this probe
// verify the *previous* deploy while reporting on the current one. That is the one way this file can
// lie, so it starts clean every run.
const PROFILE = OS.tmpdir() + '\\everything-probe';
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch (e) {
  console.log(`  ! could not clear the probe profile, results may come from a cached shell: ${e.message}`);
}
const context = await chromium.launchPersistentContext(PROFILE, {
  // Headful needs an interactive desktop session, and where one is missing a headful Chromium is
  // denied network access — which surfaces as ERR_NETWORK_ACCESS_DENIED and reads exactly like the
  // deployed app being unreachable. Set PROBE_HEADFUL=1 to watch a run happen.
  headless: process.env.PROBE_HEADFUL !== '1',
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
// State the build under test, so a run can never be read as being about some other deploy.
console.log(`  build under test: ${await page.evaluate(() => document.querySelector('meta[name="everything-build"]')?.content ?? 'unknown')}`);
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

// ---------- 7. merging duplicate people, and contact details that survive a sync ----------
// A person is identified by their name string, and names come from typing, imports and item tags, so
// one human easily ends up as two rows. Merging is the repair; rename can only fix one of them.
console.log('\nPEOPLE: MERGE AND CONTACT DETAILS');
await page.evaluate(() => {
  window.confirm = () => true;
  window.alert = () => {};
  state.people = [
    { id: 'p1', name: 'Ravi', notes: 'Prefers mornings', phone: '+91 90000 00000', created: 2 },
    { id: 'p2', name: 'Ravi Kumar', notes: 'Met at the climbing gym', email: 'ravi@work.example', created: 1 },
  ];
  state.items = [
    { id: 'i1', kind: 'task', title: 'Call the plumber', person: 'Ravi', created: Date.now() },
    { id: 'i2', kind: 'task', title: 'Book flights', person: 'Ravi Kumar', created: Date.now() },
  ];
  renderPeople();
  window.openPersonModal('p1', 'Ravi');
});
say('the dialog shows the contact details already on the record',
  await page.evaluate(() => document.getElementById('personPhone')?.value ?? null), '+91 90000 00000');
// Offering someone as their own merge target would make the button do nothing useful.
say('the merge list offers the other person and not themselves',
  JSON.stringify(await page.evaluate(() =>
    [...(document.getElementById('personMergeTarget')?.options ?? [])].map((o) => o.value))),
  JSON.stringify(['Ravi Kumar']));
say('the people list says who has contact details',
  (await page.locator('#peopleList').innerText()).includes('has contact details'), true);

// Saving must write the fields back onto the record rather than into the void.
say('saving the dialog keeps the contact details',
  JSON.stringify(await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('personEmail', 'ravi@personal.example');
    set('personBirthday', '1994-04-02');
    if (typeof window.savePersonNotes !== 'function') return 'savePersonNotes is not a function';
    return window.savePersonNotes().then(() => {
      const p = state.people.find((x) => x.name === 'Ravi');
      return p ? [p.phone, p.email, p.birthday, p.notes] : 'no record';
    });
  })),
  JSON.stringify(['+91 90000 00000', 'ravi@personal.example', '1994-04-02', 'Prefers mornings']));

// What the server sees. The people table has no phone column, so the details ride in metadata.
const personPayload = await page.evaluate(() =>
  window.buildStructuredRecordPayload('person', state.people.find((p) => p.name === 'Ravi')));
say('the sync payload carries the details in metadata',
  JSON.stringify([personPayload.metadata.phone, personPayload.metadata.email, personPayload.metadata.birthday]),
  JSON.stringify(['+91 90000 00000', 'ravi@personal.example', '1994-04-02']));
// The row that comes back has them inside metadata, so they have to be lifted out again on read.
say('a row read back from the server still has the phone number',
  await page.evaluate((metadata) => window.normaliseStructuredRecord('person',
    { id: 'row-1', client_id: 'p1', name: 'Ravi', notes: '', metadata }).phone, personPayload.metadata),
  '+91 90000 00000');

// The merge itself, driven through the real button.
await page.evaluate(() => {
  window.openPersonModal('p1', 'Ravi');
  const sel = document.getElementById('personMergeTarget');
  if (sel) sel.value = 'Ravi Kumar';
  if (typeof window.startMergePerson !== 'function') return 'startMergePerson is not a function';
  return window.startMergePerson();
});
say('the duplicate record is gone',
  JSON.stringify(await page.evaluate(() => state.people.map((p) => p.name))),
  JSON.stringify(['Ravi Kumar']));
say('every item now names the survivor',
  JSON.stringify(await page.evaluate(() => state.items.map((i) => i.person))),
  JSON.stringify(['Ravi Kumar', 'Ravi Kumar']));
// Read the survivor, not the first row, or this would pass merely because the duplicate still exists.
say('the notes from both records are kept',
  await page.evaluate(() => {
    const survivor = state.people.find((p) => p.name === 'Ravi Kumar');
    return survivor ? survivor.notes : 'no survivor';
  }),
  'Met at the climbing gym\n\nPrefers mornings');
say('the list shows one person instead of two',
  await page.locator('#peopleList .task-row').count(), 1);

// ---------- 8. goals carry a target date, and report the work linked to them ----------
console.log('\nGOAL DEPTH');
await page.evaluate(() => {
  window.confirm = () => true;
  window.__alerts = [];
  window.alert = (m) => window.__alerts.push(String(m));
  state.items = [];
  state.goals = [];
  switchView('goals');
});
const due = await page.evaluate(() => {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
// Created through the real card, target date and all.
await page.evaluate((target) => {
  document.getElementById('newGoalInput').value = 'Ship the beta';
  document.getElementById('newGoalDate').value = target;
  return window.addGoal();
}, due);
await page.evaluate(() => {
  document.getElementById('newGoalInput').value = 'Learn to sail';
  return window.addGoal();
});
say('a goal takes the target date from the card', await page.evaluate(() => state.goals[0].targetDate), due);
say('the date field is cleared, so the next goal does not inherit it',
  await page.evaluate(() => document.getElementById('newGoalDate').value), '');
say('the goal says how long is left',
  (await page.locator('#goalsList').innerText()).includes('Due in 10 days'), true);

await page.evaluate(() => {
  state.items = [
    { id: 'g-i1', kind: 'task', title: 'Write the spec', goal: 'ship the beta', done: true, created: Date.now() },
    { id: 'g-i2', kind: 'task', title: 'Ship it', goal: 'Ship the beta', done: false, created: Date.now() },
    { id: 'g-i3', kind: 'task', title: 'Unlinked work', goal: 'Walk the dog', created: Date.now() },
  ];
  renderGoals();
});
const goalText = await page.locator('#goalsList').innerText();
say('progress is read off the items linked to the goal', goalText.includes('50% complete (1/2)'), true);
say('the linked items are listed under the goal',
  [goalText.includes('Write the spec'), goalText.includes('Ship it')].join(), 'true,true');
say("an item on another goal is not counted here", goalText.includes('Unlinked work'), false);
say('a goal with nothing linked says so instead of showing an empty bar',
  goalText.includes('No items linked yet'), true);

// The goal is chosen on the item, and read back on the item's own panel.
say('the item panel says which goal an item is on', await page.evaluate(() => {
  openPanel('g-i2');
  return document.getElementById('panelGoal').textContent;
}), 'Ship the beta');
await page.evaluate(() => window.openEditModal());
say('the item dialog offers the goals that exist', JSON.stringify(await page.evaluate(() =>
  [...document.getElementById('editGoal').options].map((o) => o.value))),
  JSON.stringify(['', 'Learn to sail', 'Ship the beta']));
await page.evaluate(() => {
  document.getElementById('editGoal').value = 'Learn to sail';
  return window.saveEdit();
});
say('choosing a goal in the dialog writes it onto the item', await page.evaluate(() =>
  (state.items.find((i) => i.id === 'g-i2') || {}).goal), 'Learn to sail');

// Two goals with one title would each claim the same items and report the same progress twice.
await page.evaluate(() => {
  document.getElementById('newGoalInput').value = 'SHIP the beta';
  return window.addGoal();
});
say('the same title cannot become a second goal', JSON.stringify(await page.evaluate(() =>
  state.goals.map((g) => g.title))), JSON.stringify(['Learn to sail', 'Ship the beta']));

const betaId = await page.evaluate(() => state.goals.find((g) => g.title === 'Ship the beta').id);
await page.evaluate((id) => window.renameGoal(id, 'Ship the beta properly'), betaId);
say('renaming a goal carries the items linked to it', JSON.stringify(await page.evaluate(() =>
  state.items.map((i) => i.goal))), JSON.stringify(['Ship the beta properly', 'Learn to sail', 'Walk the dog']));

await page.evaluate((id) => window.setGoalDate(id, '31/12/2026'), betaId);
say('a target date that is not YYYY-MM-DD is refused', await page.evaluate((id) =>
  state.goals.find((g) => g.id === id).targetDate, betaId), due);
await page.evaluate((id) => window.setGoalDate(id, '2026-02-31'), betaId);
say('a day that does not exist is refused rather than rolled into March', await page.evaluate((id) =>
  state.goals.find((g) => g.id === id).targetDate, betaId), due);
await page.evaluate((id) => window.setGoalDate(id, ''), betaId);
say('a blank date clears it', await page.evaluate((id) =>
  state.goals.find((g) => g.id === id).targetDate, betaId), '');
say('an unreadable date is explained rather than swallowed', (await page.evaluate(() => window.__alerts.length)) >= 2, true);
await page.evaluate((id, target) => window.setGoalDate(id, target), betaId, due);
say('setting a date puts it back on screen',
  (await page.locator('#goalsList').innerText()).includes('Due in 10 days'), true);

// The goals table has no target-date column, so it rides in the metadata jsonb column.
const goalPayload = await page.evaluate((id) =>
  window.buildStructuredRecordPayload('goal', state.goals.find((g) => g.id === id)), betaId);
say('the sync payload carries the target date in metadata', goalPayload.metadata.targetDate, due);
say('a goal read back from the server still has its target date', await page.evaluate((md) =>
  window.normaliseStructuredRecord('goal',
    { id: 'row-1', client_id: 'g1', title: 'Ship the beta properly', status: 'active', metadata: md }).targetDate,
  goalPayload.metadata), due);

// The Date button builds a handler from stored text, which is where a quote would break it.
await page.evaluate((id) => window.setGoalDate(id, '2026-12-31'), betaId);
const dateOnclick = await page.locator('#goalsList .btn').filter({ hasText: 'Date' }).first().getAttribute('onclick');
console.log(`  onclick="${dateOnclick}"`);
say('a stored date still produces a handler the parser accepts', await page.evaluate((src) => {
  try { new Function(`return (${src});`); return 'parses'; } catch (e) { return `${e.constructor.name}: ${e.message}`; }
}, dateOnclick), 'parses');
say('the Date button hands the setter the id and the stored date', JSON.stringify(await page.evaluate(() => {
  const orig = window.startSetGoalDate;
  window.__args = null;
  window.startSetGoalDate = (a, b) => { window.__args = [a, b]; };
  [...document.querySelectorAll('#goalsList .btn')].find((b) => b.textContent.trim() === 'Date').click();
  window.startSetGoalDate = orig;
  return window.__args;
})), JSON.stringify([betaId, '2026-12-31']));

console.log(`\npage errors: ${errors.length}`);
errors.forEach((e) => console.log(`  ! ${e.slice(0, 140)}`));
await context.close();
