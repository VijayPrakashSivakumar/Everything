// Proves the Review view, the missing half of the GTD loop.
//
//   node Everything/tests/review-probe.mjs
//
// Review exists to catch drift, so what matters is that it says something *true*: that a stuck item
// is actually reported stuck, that a finished one is not counted twice, and that a clean week and an
// empty account both get an honest page rather than a wall of zeroes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4417;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => { window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }); });

  const show = (items) => page.evaluate((items) => {
    state.items = items;
    state.people = [];
    renderReview();
    switchView('review');
    const text = (id) => document.getElementById(id).innerText;
    return {
      stuck: text('reviewStuck'),
      done: text('reviewDone'),
      projects: text('reviewProjects'),
      undated: text('reviewUndated'),
      visible: document.getElementById('view-review').classList.contains('active'),
      navHasReview: [...document.querySelectorAll('.nav-label')].some((n) => n.textContent.trim() === 'Review'),
    };
  }, items);

  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString();
  const old = Date.now() - 30 * 86400000;
  const open = (over = {}) => ({ id: 'a', kind: 'task', title: 'Renew passport', done: false, created: Date.now(), ...over });

  await check('the view exists in the nav and opens', async () => {
    const r = await show([open()]);
    assert.equal(r.visible, true, 'the Review view did not open');
    assert.equal(r.navHasReview, true, 'there is no Review entry in the nav');
  });

  await check('an overdue task is reported as needing a decision', async () => {
    const r = await show([open({ id: 'a', title: 'Call the bank', dueDate: day(-3) })]);
    assert.match(r.stuck, /Call the bank/, `the overdue item is missing: "${r.stuck}"`);
    assert.match(r.stuck, /Overdue by 3 days/, `the reason is not stated: "${r.stuck}"`);
  });

  await check('a waiting item with no check-back day is reported too', async () => {
    // The case nothing else surfaces: not overdue, not due today, not in the way.
    const r = await show([open({ id: 'w', kind: 'waiting', title: 'Reply from Ravi', created: old })]);
    assert.match(r.stuck, /Reply from Ravi/, `the stale waiting item is missing: "${r.stuck}"`);
    assert.match(r.stuck, /no check-back/, `the reason is unclear: "${r.stuck}"`);
  });

  await check('a healthy week says so rather than inventing problems', async () => {
    // A review that always finds something is a review people stop opening.
    const r = await show([
      open({ id: 'a', title: 'On track', dueDate: day(2) }),
      open({ id: 'b', title: 'Also fine', recurrence: 'weekly' }),
    ]);
    /* Matched loosely on purpose. These two used to pin the exact phrase, so improving the wording of a
   clean week Ã¢â‚¬â€ which is a good thing Ã¢â‚¬â€ broke a test whose actual subject is whether a clean week is
   *reassured*, not which three words were chosen. `nothing.?s stuck` survives "Nothing is stuck" and
   "Nothing's stuck" alike, so the copy can keep improving without the safety check moving with it. */
    assert.match(r.stuck, /nothing.?s stuck/i, `a clean week still produced findings: "${r.stuck}"`);
    assert.match(r.undated, /day or a rhythm/i, `undated list should be empty: "${r.undated}"`);
  });

  await check('an empty account gets an honest page', async () => {
    const r = await show([]);
    assert.match(r.stuck, /nothing.?s stuck/i, 'an empty account is not told it is fine');
    assert.match(r.done, /nothing finished/i, 'an empty account is not told it finished nothing');
    assert.match(r.projects, /moved recently/i, 'an empty account is not reassured about projects');
  });

  await check('finished work is counted once, and only this week', async () => {
    const r = await show([
      open({ id: 'a', title: 'Finished this week', done: true, completedAt: Date.now() - 86400000 }),
      open({ id: 'b', title: 'Finished long ago', done: true, completedAt: old }),
    ]);
    assert.match(r.done, /Finished this week/, `the recent completion is missing: "${r.done}"`);
    assert.doesNotMatch(r.done, /Finished long ago/, 'a completion from a month ago is counted as this week');
  });

  await check('open work with no day is counted as having no next step', async () => {
    const r = await show([open({ id: 'a', title: 'Undated thing' })]);
    assert.match(r.undated, /Undated thing/, `the undated task is missing: "${r.undated}"`);
    assert.match(r.undated, /No day on it/, `the reason is unclear: "${r.undated}"`);
  });

  await check('a recurring task is not treated as undated', async () => {
    // A weekly task has a rhythm already; asking it for a day too is nagging, not helping.
    const r = await show([open({ id: 'a', title: 'Weekly review', recurrence: 'weekly' })]);
    assert.match(r.undated, /has a day or a rhythm/, `a recurring task was called undated: "${r.undated}"`);
  });

  await check('a quiet project is named, and a moving one is not', async () => {
    const r = await show([
      open({ id: 'a', title: 'Old thing', project: 'Atlas', created: old }),
      open({ id: 'b', title: 'Recent thing', project: 'Garden', created: Date.now() - 86400000 }),
    ]);
    assert.match(r.projects, /Atlas/, `the quiet project is missing: "${r.projects}"`);
    assert.doesNotMatch(r.projects, /Garden/, 'a project that moved yesterday was called quiet');
  });

  await check('a title with a quote cannot break the row', async () => {
    // Every title is interpolated into an onclick handler and into HTML, so this is the check that
    // the jsStr and escapeHtml pairing actually holds.
    const r = await show([open({ id: "it's", title: `Ravi's "urgent" call`, dueDate: day(-1) })]);
    assert.match(r.stuck, /Ravi/, `the row was dropped: "${r.stuck}"`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nREVIEW CHECKS FAILED' : `\nALL ${results.length} REVIEW CHECKS PASSED`);
