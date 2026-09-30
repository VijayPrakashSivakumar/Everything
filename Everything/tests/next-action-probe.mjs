// Proves the next-step suggestion appears when it should, applies when tapped, and — the point of
// the whole thing — stops asking once you have turned it down.
//
//   node Everything/tests/next-action-probe.mjs
//
// Every check drives the real engine against real seeded items, and reads the real DOM the panel
// renders. Nothing is stubbed, because a suggestion that renders but does not survive being turned
// down is the failure mode that matters.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4414;

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
  page.setDefaultTimeout(6000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => { window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }); });

  // Seed items and open one, then read the card back out of the DOM exactly as a person sees it.
  const open = (items, id) => page.evaluate(({ items, id }) => {
    state.items = items;
    state.people = [];
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
    openPanel(id);
    const host = document.getElementById('panelNextAction');
    return {
      visible: !host.hidden,
      why: document.getElementById('nextActionWhy').textContent,
      acts: [...document.querySelectorAll('#nextActionActs .btn')].map((b) => b.textContent.trim()),
      rule: currentNextAction ? currentNextAction.rule.id : null,
    };
  }, { items, id });

  const task = (over = {}) => ({ id: 't1', kind: 'task', title: 'Renew passport', done: false, created: 1, ...over });

  await check('an open task with no day on it is offered one', async () => {
    const r = await open([task()], 't1');
    assert.equal(r.visible, true, 'no suggestion was shown for an undated task');
    assert.equal(r.rule, 'set-date');
    assert.deepEqual(r.acts, ['Today', 'Tomorrow', 'Next week'], `unexpected actions: ${r.acts}`);
  });

  await check('a task that already has a day is left alone', async () => {
    const r = await open([task({ dueDate: '2026-10-01T09:00:00.000Z' })], 't1');
    assert.equal(r.visible, false, 'it nagged about a task that is already scheduled');
  });

  await check('a completed or archived task is never nagged', async () => {
    const done = await open([task({ done: true })], 't1');
    assert.equal(done.visible, false, 'it nagged about a finished task');
    const archived = await open([task({ archivedAt: Date.now() })], 't1');
    assert.equal(archived.visible, false, 'it nagged about an archived task');
  });

  await check('a recurring task is not asked for a day it already has a rhythm', async () => {
    const r = await open([task({ recurrence: 'weekly' })], 't1');
    assert.equal(r.visible, false, 'a weekly task does not also need a one-off date');
  });

  await check('a waiting item asks for a day to check back', async () => {
    const r = await open([task({ kind: 'waiting', person: 'Ravi' })], 't1');
    assert.equal(r.visible, true, 'a waiting item with no check-back day was not flagged');
    assert.match(r.why, /Ravi/, `the reason should name who is being waited on: "${r.why}"`);
  });

  await check('a person named but never linked is spotted, on whole words only', async () => {
    // Given a date, so the date rule does not — correctly — take the card first.
    const withPerson = await open([
      { id: 'other', kind: 'task', title: 'Old thing', person: 'Ravi', created: 2 },
      task({ id: 't1', title: 'Call Ravi about the quote', dueDate: '2026-10-01T09:00:00.000Z' }),
    ], 't1');
    assert.equal(withPerson.rule, 'link-person', 'Ravi is named in the text and known, but unlinked');
    assert.deepEqual(withPerson.acts, ['Link to Ravi']);

    // The trap: a short name appearing inside a longer one is not that person.
    const substring = await open([
      { id: 'other', kind: 'task', title: 'Old thing', person: 'Ann', created: 2 },
      task({ id: 't1', title: 'Review the Anna-Marie contract', dueDate: '2026-10-01T09:00:00.000Z' }),
    ], 't1');
    assert.notEqual(substring.rule, 'link-person', '"Ann" matched inside "Anna-Marie"');
  });

  await check('only one suggestion is ever shown, and the more useful one wins', async () => {
    // A stack of cards is just noise. When an undated task also names an unlinked person, the date
    // comes first — a task with no day is the more urgent gap.
    const r = await open([
      { id: 'other', kind: 'task', title: 'Old thing', person: 'Ravi', created: 2 },
      task({ id: 't1', title: 'Call Ravi about the quote' }),
    ], 't1');
    assert.equal(r.rule, 'set-date', 'the weaker suggestion displaced the more urgent one');
    const count = await page.evaluate(() => document.querySelectorAll('#nextActionActs .btn').length);
    assert.ok(count <= 3, `one card is showing ${count} buttons`);
  });

  await check('tapping an action applies it and the card moves on', async () => {
    const r = await page.evaluate(async () => {
      state.items = [{ id: 't1', kind: 'task', title: 'Renew passport', done: false, created: 1 }];
      state.people = [];
      window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
      openPanel('t1');
      await applyNextAction('date', 'day');
      await new Promise((res) => setTimeout(res, 250));
      return {
        dueDate: state.items[0].dueDate || '',
        visible: !document.getElementById('panelNextAction').hidden,
      };
    });
    assert.ok(r.dueDate, 'tapping "Tomorrow" did not set a date');
    assert.equal(r.visible, false, 'the card stayed up after it had been acted on');
  });

  await check('turning it down twice stops the asking, and once does not', async () => {
    const r = await page.evaluate(async () => {
      localStorage.removeItem('everything_next_action_learning_v1');
      state.items = [{ id: 't1', kind: 'task', title: 'Renew passport', done: false, created: 1 }];
      const seed = () => { openPanel('t1'); return !document.getElementById('panelNextAction').hidden; };
      const first = seed();
      dismissNextAction();
      const afterOne = seed();
      dismissNextAction();
      const afterTwo = seed();
      return { first, afterOne, afterTwo };
    });
    assert.equal(r.first, true, 'it should offer a date the first time');
    assert.equal(r.afterOne, true, 'one dismissal silenced it — that is far too eager');
    assert.equal(r.afterTwo, false, 'two dismissals and it is still asking');
  });

  await check('a turn-down is forgotten after the memory window', async () => {
    // Suppression must not be permanent, or one bad month silences a suggestion for good.
    const r = await page.evaluate(() => {
      localStorage.setItem('everything_next_action_learning_v1', JSON.stringify({
        'set-date': { skips: 2, lastAt: Date.now() - 60 * 86400000 },
      }));
      const before = nextActionIsSuppressed('set-date');
      localStorage.setItem('everything_next_action_learning_v1', JSON.stringify({
        'set-date': { skips: 2, lastAt: Date.now() - 2 * 86400000 },
      }));
      const after = nextActionIsSuppressed('set-date');
      localStorage.removeItem('everything_next_action_learning_v1');
      return { before, after };
    });
    assert.equal(r.before, false, 'a 60-day-old turn-down is still silencing the suggestion');
    assert.equal(r.after, true, 'a fresh turn-down is not being respected');
  });

  await check('taking a suggestion clears what it remembered', async () => {
    const r = await page.evaluate(() => {
      localStorage.setItem('everything_next_action_learning_v1', JSON.stringify({
        'set-date': { skips: 1, lastAt: Date.now() },
      }));
      noteNextActionAccepted('set-date');
      return nextActionIsSuppressed('set-date');
    });
    assert.equal(r, false, 'acting on a suggestion left the old turn-downs in place');
  });

  await check('the card is hidden until it has something to say', async () => {
    // An empty bordered box on every item would be worse than no feature at all.
    const empty = await page.evaluate(() => document.getElementById('panelNextAction').hidden);
    assert.equal(empty, true, 'the suggestion card is visible with nothing in it');
  });

  await check('the dismiss control is a labelled button, big enough to tap', async () => {
    // Measure it while it is actually on screen: a hidden card is display:none, so its children
    // measure 0x0 and the test would pass or fail on nothing.
    await open([task()], 't1');
    const r = await page.evaluate(() => {
      const btn = document.querySelector('.next-action-skip');
      const box = btn.getBoundingClientRect();
      return {
        tag: btn.tagName,
        label: btn.getAttribute('aria-label') || '',
        w: box.width,
        h: box.height,
      };
    });
    assert.equal(r.tag, 'BUTTON', 'the dismiss control is not a real button');
    assert.match(r.label, /stop showing it/i, `"stop suggesting this" is the promise; the label says "${r.label}"`);
    assert.ok(r.w >= 28 && r.h >= 28, `the dismiss target is only ${r.w}x${r.h}`);

    // On a phone it must clear 44px, or it is a miss rather than a tap.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const phone = await page.evaluate(() => {
      const box = document.querySelector('.next-action-skip').getBoundingClientRect();
      return { w: box.width, h: box.height };
    });
    assert.ok(phone.w >= 44 && phone.h >= 44, `the touch target is only ${phone.w}x${phone.h} at 390px`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nNEXT-ACTION CHECKS FAILED' : `\nALL ${results.length} NEXT-ACTION CHECKS PASSED`);
