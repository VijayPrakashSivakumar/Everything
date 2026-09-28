// Proves the morning digest, and above all that it knows when to SHUT UP.
//
//   node Everything/tests/morning-digest-probe.mjs
//
// A daily notification is the easiest thing in this app to get wrong. Get it wrong once and it is
// muted for good, which is worse than having none. So most of these checks are about silence:
// off by default, quiet before the hour, quiet when there is nothing to say, and never twice in a
// day. Only then does it check that it says the right thing when it does speak.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4415;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => { window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }); });

  // Seed items and read the digest straight out of the real builder.
  const digestFor = (items) => page.evaluate((items) => {
    state.items = items;
    localStorage.removeItem('everything_morning_digest_v1');
    return buildMorningDigest();
  }, items);

  const day = (offset) => {
    const d = new Date(Date.now() + offset * 86400000);
    return d.toISOString();
  };
  const open = (over = {}) => ({ id: 'a', kind: 'task', title: 'Renew passport', done: false, created: Date.now(), ...over });
  const old = Date.now() - 30 * 86400000;

  await check('it is off until you switch it on', async () => {
    const r = await page.evaluate(() => {
      localStorage.removeItem('everything_morning_digest_v1');
      const settings = readMorningDigestSettings();
      return { enabled: settings.enabled, hour: settings.hour };
    });
    assert.equal(r.enabled, false, 'the digest is on for someone who never asked for it');
    assert.equal(r.hour, 8, 'the default arrival hour should be 08:00');
  });

  await check('a quiet day produces no digest at all', async () => {
    // The single most important check. If this ever returns an object, a silent app starts
    // interrupting people for nothing.
    const r = await digestFor([open({ dueDate: day(30) })]);
    assert.equal(r, null, 'it found something to say about a task due next month');
  });

  await check('done and archived items are never counted', async () => {
    const r = await digestFor([
      open({ id: 'a', done: true, dueDate: day(-5) }),
      open({ id: 'b', archivedAt: Date.now(), dueDate: day(-5) }),
    ]);
    assert.equal(r, null, 'finished or archived work was reported as needing attention');
  });

  await check('overdue and due-today are counted and named', async () => {
    const r = await digestFor([
      open({ id: 'a', title: 'Call the bank', dueDate: day(-3) }),
      open({ id: 'b', title: 'Send the invoice', dueDate: day(0) }),
    ]);
    assert.equal(r.counts.overdue, 1, 'the overdue task was missed');
    assert.equal(r.counts.dueToday, 1, 'the task due today was missed');
    assert.match(r.title, /1 overdue/, `the count is not in the title: "${r.title}"`);
    assert.match(r.body, /Call the bank/, `the overdue item is not named: "${r.body}"`);
  });

  await check('overdue is ranked ahead of merely due today', async () => {
    // The worst thing is the reason to read the rest, so it must lead.
    const r = await digestFor([
      open({ id: 'a', title: 'Due today thing', dueDate: day(0) }),
      open({ id: 'b', title: 'Late thing', dueDate: day(-2) }),
    ]);
    assert.match(r.body, /^Late thing/, `the urgent item was not named first: "${r.body}"`);
  });

  await check('it says little: three names and a count, never the whole list', async () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      open({ id: `t${i}`, title: `Late thing ${i}`, dueDate: day(-1) }));
    const r = await digestFor(items);
    assert.match(r.title, /9 overdue/, `the count is wrong: "${r.title}"`);
    assert.match(r.body, /and 6 more/, `the remainder is not accounted for: "${r.body}"`);
    const named = (r.body.match(/Late thing/g) || []).length;
    assert.equal(named, 3, `it named ${named} items instead of at most three`);
  });

  await check('something waiting too long is worth mentioning', async () => {
    // The case a pull-based view never surfaces: not overdue, not due today, not in the way.
    const r = await digestFor([open({ id: 'w', kind: 'waiting', title: 'Reply from Ravi', created: old })]);
    assert.equal(r.counts.staleWaiting, 1, 'a fortnight-old waiting item was ignored');
    assert.match(r.title, /waiting too long/, `the wording is unclear: "${r.title}"`);
  });

  await check('a recent waiting item is left alone', async () => {
    const r = await digestFor([open({ id: 'w', kind: 'waiting', title: 'Reply from Ravi' })]);
    assert.equal(r, null, 'it mentioned something captured this morning');
  });

  await check('it stays silent before the hour you chose', async () => {
    // 02:00, with the digest set for 08:00. This is the check that stops it waking anyone at night.
    const r = await page.evaluate(async () => {
      state.items = [{ id: 'a', kind: 'task', title: 'Late thing', done: false, created: 1, dueDate: new Date(Date.now() - 86400000).toISOString() }];
      localStorage.setItem('everything_morning_digest_v1', JSON.stringify({ enabled: true, hour: 8, lastSentOn: '' }));
      const realNow = Date.now;
      const twoAm = new Date(); twoAm.setHours(2, 0, 0, 0);
      Date.now = () => twoAm.getTime();
      let sent = null;
      try { sent = await deliverMorningDigest('test'); } finally { Date.now = realNow; }
      return sent;
    });
    assert.equal(r.sent, false, 'it sent a digest at 2am');
  });

  await check('it never sends twice in one day', async () => {
    const r = await page.evaluate(async () => {
      state.items = [{ id: 'a', kind: 'task', title: 'Late thing', done: false, created: 1, dueDate: new Date(Date.now() - 86400000).toISOString() }];
      let sent = null;
      // Grant permission through a stub, so the only question left is "once a day".
      const realShow = window.showLocalNotification;
      window.showLocalNotification = async () => true;
      Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
      localStorage.setItem('everything_morning_digest_v1', JSON.stringify({ enabled: true, hour: 0, lastSentOn: '' }));
      try {
        const first = await deliverMorningDigest('test');
        const second = await deliverMorningDigest('test');
        sent = { first, second };
      } finally { window.showLocalNotification = realShow; }
      return sent;
    });
    assert.equal(r.first.sent, true, 'the first digest of the day did not go out');
    assert.equal(r.second.sent, false, 'it sent a second digest on the same day');
    assert.match(r.second.why, /already sent/, `the second send was stopped for the wrong reason: "${r.second.why}"`);
  });

  await check('a switched-off digest sends nothing, even with work waiting', async () => {
    const r = await page.evaluate(async () => {
      state.items = [{ id: 'a', kind: 'task', title: 'Late thing', done: false, created: 1, dueDate: new Date(Date.now() - 86400000).toISOString() }];
      localStorage.setItem('everything_morning_digest_v1', JSON.stringify({ enabled: false, hour: 0, lastSentOn: '' }));
      const realShow = window.showLocalNotification;
      window.showLocalNotification = async () => true;
      Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
      let result = null;
      try { result = await deliverMorningDigest('test'); } finally { window.showLocalNotification = realShow; }
      return result;
    });
    assert.equal(r.sent, false, 'a switched-off digest sent a notification');
    assert.match(r.why, /not switched on/, `stopped for the wrong reason: "${r.why}"`);
  });

  await check('a day with nothing to do is not marked as delivered', async () => {
    // Nothing was sent, so nothing may be recorded as sent — otherwise tomorrow's real digest
    // would be suppressed by a day that never had one.
    const r = await page.evaluate(async () => {
      state.items = [{ id: 'a', kind: 'task', title: 'Someday', done: false, created: Date.now(), dueDate: new Date(Date.now() + 86400000 * 30).toISOString() }];
      localStorage.setItem('everything_morning_digest_v1', JSON.stringify({ enabled: true, hour: 0, lastSentOn: '' }));
      Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
      await deliverMorningDigest('test');
      return readMorningDigestSettings().lastSentOn;
    });
    assert.equal(r, '', 'a day with nothing to report was recorded as a day the digest went out');
  });

  await check('the settings panel offers the choice and previews it honestly', async () => {
    const r = await page.evaluate(() => {
      // Earlier checks left the digest switched on, so this one starts from a clean slate — it is
      // checking what a first-time visitor sees, which is the state that matters.
      localStorage.removeItem('everything_morning_digest_v1');
      showSettingsTab('notifications');
      const select = document.getElementById('digestHourSelect');
      return {
        hours: select ? select.options.length : 0,
        label: document.getElementById('digestToggleLabel')?.textContent || '',
        status: document.getElementById('digestStatusLine')?.textContent || '',
      };
    });
    assert.equal(r.hours, 24, 'the arrival hour is not fully selectable');
    assert.equal(r.label, 'Off', 'the toggle does not show the digest is off');
    // Before anyone has opted in, the panel must say what turning it on would do — not just "On".
    assert.match(r.status, /nothing is sent/i, `the off state is not explained: "${r.status}"`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nMORNING DIGEST CHECKS FAILED' : `\nALL ${results.length} MORNING DIGEST CHECKS PASSED`);
