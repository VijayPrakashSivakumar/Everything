// Proves the Review view, the missing half of the GTD loop.
//
//   node Everything/tests/review-probe.mjs
//
// Review exists to catch drift, so what matters is that it says something *true*: that a stuck item
// is actually reported stuck, that a finished one is not counted twice, and that a clean week and an
// empty account both get an honest page rather than a wall of zeroes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl, bootApp } from './test-server.mjs';

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
  await bootApp(page, PORT);
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
   clean week — which is a good thing — broke a test whose actual subject is whether a clean week is
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

  await check('the stat tiles are real controls wired to their lists', async () => {
    await show([open({ id: 'a', title: 'Late thing', dueDate: day(-1) })]);
    const r = await page.evaluate(() => {
      const host = document.getElementById('reviewStats');
      const tiles = [...host.querySelectorAll('.stat-card')];
      return {
        grid: getComputedStyle(host).display,
        tiles: tiles.map((t) => ({
          onclick: t.getAttribute('onclick') || '',
          label: (t.querySelector('.stat-label') || {}).textContent || '',
        })),
        targets: ['reviewStuckCard', 'reviewDoneCard', 'reviewUndatedCard'].map(
          (id) => !!document.getElementById(id),
        ),
      };
    });
    assert.equal(r.grid, 'grid', `#reviewStats is not laid out as a stat-row (display: ${r.grid}) — the tiles would stack full-width`);
    assert.equal(r.tiles.length, 4, `expected 4 stat tiles, found ${r.tiles.length}`);
    r.tiles.forEach((t) => assert.ok(t.onclick, `the "${t.label}" tile does nothing when clicked`));
    assert.deepEqual(r.targets, [true, true, true],
      'a stat tile jumps to a card id that does not exist in the markup');
    // And invoking a jump must not throw: the handler is exercised, not just present.
    await page.evaluate(() => { reviewJumpTo('reviewStuckCard'); reviewJumpToInbox(); });
  });

  await check('a list past twelve rows can be opened in full, and closed again', async () => {
    // The old code capped at 12 and appended dead text ("and N more — open the view they belong
    // to") you could not click, and the other two lists dropped the tail in silence.
    const many = Array.from({ length: 15 }, (_, i) =>
      open({ id: 'm' + i, title: `Stuck ${i + 1}`, dueDate: day(-1) }));
    const rows = () => page.evaluate(() => document.querySelectorAll('#reviewStuck .task-row').length);
    const toggleBtn = () => page.evaluate(() => {
      const btn = [...document.querySelectorAll('#reviewStuck .link-btn')].pop();
      return btn ? btn.textContent.trim() : '';
    });

    await show(many);
    assert.equal(await rows(), 12, `the preview should cap at 12 rows, saw ${await rows()}`);
    assert.match(await toggleBtn(), /^Show all \(15\)$/, `expected a Show all control, got "${await toggleBtn()}"`);

    await page.evaluate(() => toggleReviewSection('stuck'));
    assert.equal(await rows(), 15, `expanding should reveal all 15 rows, saw ${await rows()}`);
    assert.match(await toggleBtn(), /^Show fewer$/, `the expanded control should collapse, got "${await toggleBtn()}"`);

    await page.evaluate(() => toggleReviewSection('stuck'));
    assert.equal(await rows(), 12, 'collapsing should return to the 12-row preview');
    await show([]); // leave the shared expansion state clean for the checks below
  });

  await check('a finished row opens its item, and its checkbox reopens it', async () => {
    const r = await show([
      open({ id: 'f1', title: 'Sorted the attic', done: true, completedAt: Date.now() - 3600000 }),
    ]);
    assert.match(r.done, /Sorted the attic/, `the finished row is missing: "${r.done}"`);
    const wire = await page.evaluate(() => {
      const row = document.querySelector('#reviewDone .task-row');
      return {
        meta: row ? (row.querySelector('.task-meta')?.getAttribute('onclick') || '') : '',
        check: row ? (row.querySelector('.checkbox')?.getAttribute('onclick') || '') : '',
      };
    });
    assert.match(wire.meta, /openPanel\(/, `the row does not open its item: "${wire.meta}"`);
    assert.match(wire.check, /toggleReviewDone\(/, `the checkbox cannot reopen the item: "${wire.check}"`);
  });

  await check('the empty sections use the full empty state, not a bare line', async () => {
    await show([]);
    const r = await page.evaluate(() => ({
      done: !!document.querySelector('#reviewDone .empty-state'),
      projects: !!document.querySelector('#reviewProjects .empty-state'),
    }));
    assert.equal(r.done, true, 'the Finished section falls back to a bare <p class="empty"> when empty');
    assert.equal(r.projects, true, 'the Quiet projects section falls back to a bare <p class="empty"> when empty');
  });

  await check('the nav badge carries the stuck count from state alone', async () => {
    const badgeFor = async (items) => {
      await show(items);
      return page.evaluate(() => {
        if (typeof renderNav === 'function') renderNav();
        const item = [...document.querySelectorAll('#navList .nav-item')].find(
          (n) => (n.querySelector('.nav-label') || {}).textContent?.trim() === 'Review',
        );
        const badge = item && item.querySelector('.nav-badge');
        return badge ? badge.textContent.trim() : '';
      });
    };
    assert.equal(
      await badgeFor([open({ id: 'a', title: 'Late thing', dueDate: day(-1) })]),
      '1',
      'one overdue item should badge Review with 1',
    );
    assert.equal(
      await badgeFor([open({ id: 'b', title: 'Fine', dueDate: day(2) })]),
      '',
      'a clean account must not carry a Review badge',
    );
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nREVIEW CHECKS FAILED' : `\nALL ${results.length} REVIEW CHECKS PASSED`);
