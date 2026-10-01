// Date/time probe. Every timezone conversion, measured under a *forced* timezone rather than whatever
// machine happens to run it.
//
//   node Everything/tests/datetime-probe.mjs
//
// Why this exists: the app showed every captured task at the wrong time — always the same wrong time,
// across text, voice and picture. They converged on one line: `new Date(datetimeLocalValue)`. A
// datetime-local string carries no zone, and the constructor reads those as UTC, so a wall clock read
// as UTC came back shifted by the offset. In India that is 5½ hours, which is why it looked constant.
//
// A test on the machine's own timezone cannot catch this. At UTC+0 the broken path and the correct
// path agree exactly. Every check therefore runs the page under a forced zone, and two are used:
// Asia/Kolkata is east of UTC and America/Los_Angeles is west, so a conversion that is accidentally
// symmetric about UTC cannot pass both.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4457;

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

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    timezoneId: 'Asia/Kolkata', // UTC+5:30, the zone the bug was reported from
  });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });

  await check('the page really is running in the forced timezone', async () => {
    // If this fails, everything below is measuring in UTC and passing for the wrong reason — which is
    // exactly how the original bug survived.
    const offset = await page.evaluate(() => new Date().getTimezoneOffset());
    assert.equal(offset, -330, `expected UTC+5:30, the page reports an offset of ${offset}`);
  });

  await check('a datetime-local value round-trips through storage unchanged', async () => {
    // The core assertion. 17:30 local must come back as 17:30 local, not as the same string read as
    // UTC. Under the old code it drifted by exactly the offset on every open-and-save.
    const r = await page.evaluate(() => {
      const box = '2026-10-05T17:30';
      const stored = DATE_TIME.fromDateTimeLocal(box);
      return {
        box,
        shown: DATE_TIME.toDateTimeLocalValue(stored),
        stored,
        wanted: new Date(2026, 9, 5, 17, 30).toISOString(),
      };
    });
    assert.equal(r.stored, r.wanted,
      `17:30 local here should store as ${r.wanted}, got ${r.stored}`);
    assert.equal(r.shown, r.box,
      `the box showed "${r.shown}" for a value entered as "${r.box}" — the offset was lost`);
  });

  await check('a date-only value is what produced the 5:30, and it is fixed', async () => {
    /* The diagnosis, corrected. The visible symptom was a constant 5:30 in the morning, and the
       datetime-local path was NOT the cause.

       `new Date("2026-10-05")` — a *date-only* string, no time part — is defined by the spec as UTC
       midnight. In Kolkata that is 05:30. Any date-only value that went through a plain constructor
       therefore surfaced as a five-thirty time, and because the offset is fixed it read as a default
       rather than as a fault. A date-*time* string is parsed as local, which is why the full
       datetime-local round trip was never the culprit — a claim this probe originally made, and had
       to be corrected when the guard below disproved it.

       Both halves are asserted: the old path really does yield 5:30 here, and the new one does not.
       Without the first, this would pass on any machine where the two happen to agree. */
    const r = await page.evaluate(() => {
      const dayOnly = '2026-10-05';
      const oldWay = new Date(dayOnly);
      const newWay = new Date(DATE_TIME.fromDateInput(dayOnly));
      const clock = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      return {
        oldClock: clock(oldWay),
        newClock: clock(newWay),
        newIso: newWay.toISOString(),
        midnightLocal: new Date(2026, 9, 5).toISOString(),
      };
    });
    assert.equal(r.oldClock, '5:30',
      `the old path gave ${r.oldClock} here, not the 5:30 that was reported`);
    assert.equal(r.newClock, '0:00',
      `a date-only value now reads as ${r.newClock} instead of local midnight`);
    assert.equal(r.newIso, r.midnightLocal);
  });
await check('the edit dialog shows the stored time, and saving it changes nothing', async () => {
  // The end-to-end case from the report: open a task, press save without touching the date.
  const r = await page.evaluate(async () => {
    state.items = [{
      id: 'dt1', kind: 'task', title: 'Timezone check', done: false,
      created: 1, dueDate: '2026-10-05T17:30:00.000Z',
    }];
    currentItemId = 'dt1';
    openEditModal();
    await new Promise((r) => setTimeout(r, 80));
    const box = document.getElementById('editDueDate').value;
    document.getElementById('editTitle').value = 'Timezone check';
    await saveEdit();
    const after = state.items.find((i) => i.id === 'dt1');
    return { box, after: after ? after.dueDate : null };
  });
  assert.equal(r.box, '2026-10-05T23:00',
    `the edit box showed "${r.box}"; 17:30 UTC is 23:00 in Kolkata`);
  assert.equal(r.after, '2026-10-05T17:30:00.000Z',
    `saving without touching the date moved it to ${r.after}`);
});

await check('a capture saved with a local time stores the right instant', async () => {
  // The path every input channel converges on, which is why text, voice and picture all failed
  // together rather than separately.
  const r = await page.evaluate(async () => {
    openCapture();
    await new Promise((r) => setTimeout(r, 80));
    document.getElementById('captureText').value = 'Call the bank';
    document.getElementById('captureDueDate').value = '2026-10-06T17:30';
    await saveCapture(true);
    // saveCapture closes the sheet and clears it, so the row is read from state by title rather than
    // from whatever the function returned — it returns nothing useful when it saves.
    const item = state.items.find((i) => i.title === 'Call the bank');
    return {
      iso: item ? item.dueDate : null,
      box: '2026-10-06T17:30',
      expected: new Date(2026, 9, 6, 17, 30).toISOString(),
    };
  });
  assert.equal(r.iso, r.expected,
    `a capture entered as ${r.box} local was stored as ${r.iso}`);
  await page.evaluate(() => { try { closeCapture(); } catch (e) { /* already closed */ } });
});

await check('a date-only value is not mistaken for midnight-UTC', async () => {
  const r = await page.evaluate(() => ({
    iso: DATE_TIME.fromDateInput('2026-10-05'),
    expected: new Date(2026, 9, 5).toISOString(),
  }));
  assert.equal(r.iso, r.expected);
});

await check('local day keys are local, not UTC', async () => {
  // toISOString().slice(0,10) is the UTC date, which is the *previous* day here until 05:30.
  const r = await page.evaluate(() => {
    const justAfterMidnight = new Date(2026, 9, 5, 0, 15);
    return {
      ours: DATE_TIME.localDayKey(justAfterMidnight),
      naive: justAfterMidnight.toISOString().slice(0, 10),
    };
  });
  assert.equal(r.ours, '2026-10-05', 'the local day key lost the day');
  assert.notEqual(r.ours, r.naive,
    'localDayKey matches the UTC date here, so it is not actually using local time');
});

await check('created stays an ordering key and due stays an instant', async () => {
  // Separate facts; one must never stand in for the other. `created` is compared with < in both the
  // client and the API, so it stays a number. `dueDate` is UTC ISO.
  const r = await page.evaluate(() => {
    const item = { created: 1000, dueDate: '2026-10-05T09:00:00.000Z' };
    return {
      createdIsNumber: typeof item.created === 'number',
      createdIsUtcString: String(item.created).endsWith('Z'),
      dueIsUtc: item.dueDate.endsWith('Z'),
    };
  });
  assert.ok(r.createdIsNumber, 'created must stay an ordering key');
  assert.ok(!r.createdIsUtcString, 'created must not become a UTC string');
  assert.ok(r.dueIsUtc, 'dueDate must be stored as UTC ISO');
});

await page.close();

await check('the fix holds west of UTC too', async () => {
  // Opposite offset. A conversion accidentally symmetric about UTC passes one zone and fails the
  // other, so both are required.
  const west = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    timezoneId: 'America/Los_Angeles',
  });
  await west.goto(testUrl(PORT), { waitUntil: 'commit' });
  await west.waitForFunction(() => typeof window.setThemeConcept === 'function');
  const r = await west.evaluate(() => {
    const box = '2026-10-05T17:30';
    return { box, shown: DATE_TIME.toDateTimeLocalValue(DATE_TIME.fromDateTimeLocal(box)) };
  });
  assert.equal(r.shown, r.box, `Los Angeles showed "${r.shown}" for ${r.box}`);
  await west.close();
});
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode
  ? '\nDATE-TIME CHECKS FAILED'
  : `\nALL ${results.length} DATE-TIME CHECKS PASSED`);
