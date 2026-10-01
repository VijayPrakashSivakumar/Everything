// Reminder-instant probe: the moment a decision to remind turns into a wall-clock time.
//
//   node Everything/tests/reminder-instant-probe.mjs
//
// Why this exists: reminders have a well-tested half and an untested one. Sixteen existing checks
// cover whether something *should* remind — that a bill keeps its date, that an expense never
// reminds, that a document is reminded by its expiry. None of them check *when* it fires, because
// the function that decides that was never pointed at a timezone.
//
// The line under test is one line in utils.js:
//
//     const time = new Date(item.dueDate).getTime();
//
// That is the same shape as the 5:30 bug: a Date constructor parsing a string whose format it has
// to guess. An instant with a time is read correctly. A date-ONLY string — "2026-10-05" — is defined
// by the specification as UTC midnight, which in Kolkata is 05:30 in the morning. Nothing throws.
// The reminder simply fires hours early, and only in the eastern half of the world, which is exactly
// the kind of bug that survives a green suite and gets reported as "reminders are unreliable".
//
// Every check therefore runs under a forced timezone, and two are used: Asia/Kolkata is east of
// UTC and America/Los_Angeles is west, so a conversion that is accidentally symmetric about UTC
// cannot pass both. At UTC+0 the correct answer and the wrong one are the same number, so a test
// run on a machine in London or on CI proves nothing at all.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4471;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

/* The local wall-clock reading of an instant, in whatever zone the page is running in. Formatting
   the epoch back through Date is the only way to see what a person would see on their own clock. */
const readClock = (page, epoch) => page.evaluate((ms) => {
  const d = new Date(ms);
  return {
    hour: d.getHours(),
    minute: d.getMinutes(),
    utcHour: d.getUTCHours(),
    utcMinute: d.getUTCMinutes(),
  };
}, epoch);

try {
  for (const zone of ['Asia/Kolkata', 'America/Los_Angeles']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: zone });
    page.setDefaultTimeout(8000);
    await page.goto(testUrl(PORT), { waitUntil: 'commit' });
    await page.waitForFunction(() => typeof window.itemReminderTime === 'function');
    await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });

    await check(`[${zone}] the page is really running in the forced zone`, async () => {
      const offset = await page.evaluate(() => new Date().getTimezoneOffset());
      const expected = zone === 'Asia/Kolkata' ? -330 : 420;
      assert.equal(offset, expected, `expected a ${expected} minute offset, got ${offset}`);
    });

    await check(`[${zone}] a task with a due instant reminds at that instant`, async () => {
      // 2026-10-05T09:00:00Z is a fixed instant: 14:30 in Kolkata, 02:00 in Los Angeles. Same stored
      // value, two different wall clocks — which is the entire point of storing UTC.
      const epoch = await page.evaluate(() =>
        itemReminderTime({ id: 'a', title: 't', dueDate: '2026-10-05T09:00:00.000Z' }));
      assert.equal(epoch, Date.parse('2026-10-05T09:00:00.000Z'),
        'the reminder instant must be the stored instant, not a re-read of local time');
      const clock = await readClock(page, epoch);
      assert.equal(clock.hour, zone === 'Asia/Kolkata' ? 14 : 2,
        `expected 14:30 in Kolkata and 02:00 in Los Angeles, got ${clock.hour}:${clock.minute}`);
      assert.equal(clock.minute, zone === 'Asia/Kolkata' ? 30 : 0, 'the minutes must be preserved');
    });

    await check(`[${zone}] a date-only due date does not become a 05:30 reminder`, async () => {
      /* The regression this whole file exists for. A date-only string is UTC midnight by spec, so
         in Kolkata it reads as 05:30 and a task meant for the day would fire before breakfast.
         Whatever the app decides here, the only unacceptable answer is 05:30. */
      const clock = await page.evaluate(() => {
        const ms = itemReminderTime({ id: 'b', title: 't', dueDate: '2026-10-05' });
        if (ms === null) return { nullish: true };
        const d = new Date(ms);
        return { nullish: false, hour: d.getHours(), minute: d.getMinutes() };
      });
      // Refusing to guess is a defensible answer; silently inventing 05:30 is not.
      if (clock.nullish) return;
      assert.ok(
        !(clock.hour === 5 && clock.minute === 30),
        `a date-only due date produced the 05:30 UTC-midnight bug in ${zone}`,
      );
    });
  await check(`[${zone}] a snooze wins over the due date`, async () => {
      const out = await page.evaluate(() => {
        const snoozed = Date.now() + 36e5;
        return { got: itemReminderTime({ id: 'c', dueDate: '2026-10-05T09:00:00.000Z', snoozedUntil: snoozed }), snoozed };
      });
      assert.equal(out.got, out.snoozed, 'a snoozed item must remind when the snooze ends');
    });

    await check(`[${zone}] finished, archived and unparseable items stay quiet`, async () => {
      const out = await page.evaluate(() => {
        const due = '2026-10-05T09:00:00.000Z';
        return {
          done: itemReminderTime({ id: 'd1', dueDate: due, done: true }),
          archived: itemReminderTime({ id: 'd2', dueDate: due, archivedAt: 1791190800000 }),
          empty: itemReminderTime({ id: 'd3', dueDate: '' }),
          nonsense: itemReminderTime({ id: 'd4', dueDate: 'not a date' }),
        };
      });
      assert.equal(out.done, null, 'a completed item must not remind');
      assert.equal(out.archived, null, 'an archived item must not remind');
      assert.equal(out.empty, null, 'an item with no date must not remind');
      assert.equal(out.nonsense, null, 'an unparseable date must not remind, and must not throw');
    });

    await check(`[${zone}] re-dating a task moves its reminder`, async () => {
      // The stale-schedule case. A reminder is derived from the due instant, so a moved date must
      // produce a different one; a value cached at creation would still fire at the old time.
      const out = await page.evaluate(() => {
        const first = itemReminderTime({ id: 'e', dueDate: '2026-10-05T09:00:00.000Z' });
        const moved = itemReminderTime({ id: 'e', dueDate: '2026-10-07T09:00:00.000Z' });
        return { first, moved };
      });
      assert.notEqual(out.moved, out.first, 'a re-dated task must get a different reminder time');
      assert.equal(out.moved, Date.parse('2026-10-07T09:00:00.000Z'),
        'the reminder must follow the new date exactly');
    });

    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode
  ? '\nREMINDER-INSTANT CHECKS FAILED'
  : `\nALL ${results.length} REMINDER-INSTANT CHECKS PASSED`);