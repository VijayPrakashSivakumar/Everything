// Proves the Documents feature: the expiry maths, the reminder it drives, the capture path that
// produces one, and the row that would tell someone their warranty lapsed.
//
//   node Everything/tests/documents-probe.mjs
//
// Most of this is date arithmetic, and date arithmetic is exactly where a feature looks finished
// and is quietly wrong. The checks below pin the four failures that would be invisible in use:
// a date parsed as UTC (every expiry a day early in most of the world), a document filed as a task
// and nagging on the day it was captured, an old receipt that nags forever, and an unreadable
// expiry that sorts as "no expiry" and so never prompts anyone to look.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4420;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => {
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
  });

  // A date `offset` days from today, as YYYY-MM-DD Ã¢â‚¬â€ the form the app actually stores.
  const inDays = (offset) => page.evaluate((n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, offset);

  /* `doc()` builds a document row, and every check that uses it runs inside the page, so the helper
     is defined there. A version out here would be a Node closure that page.evaluate cannot see Ã¢â‚¬â€
     which is exactly the "doc is not defined" the first run of this probe produced. */
  await page.evaluate(() => {
    window.doc = (over = {}) => ({
      id: 'd1', kind: 'document', title: 'Sony TV', done: false, created: 1, ...over,
    });
  });

  const run = (fn, arg) => page.evaluate(fn, arg);
  // ---------- Date parsing ----------
  await check('an expiry is read as the local day, not the UTC one', async () => {
    // new Date('2027-03-04') is UTC midnight, which in any negative offset means 3 March local.
    // The chip would then say the document expired a day before it actually did.
    const r = await run(() => {
      const d = parseIsoDate('2027-03-04');
      return d ? [d.getFullYear(), d.getMonth() + 1, d.getDate()] : null;
    });
    assert.deepEqual(r, [2027, 3, 4], `the date resolved to ${JSON.stringify(r)}`);
  });

  await check('a date that does not exist is refused rather than rolled forward', async () => {
    // Date would quietly make 2027-02-30 the 2nd of March, which reads as a real expiry on the
    // wrong day Ã¢â‚¬â€ and a document can lose a whole month of warning that way.
    const r = await run(() => [parseIsoDate('2027-02-30'), parseIsoDate('2027-13-01'), parseIsoDate('')]);
    assert.deepEqual(r, [null, null, null], `expected all three refused, got ${JSON.stringify(r)}`);
  });

  await check('days-until is midnight to midnight, so it does not drift through the day', async () => {
    const r = await run(() => {
      const d = new Date();
      d.setDate(d.getDate() + 10);
      const pad = (x) => String(x).padStart(2, '0');
      const ten = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const now = new Date();
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      return { ten: daysUntil(ten), today: daysUntil(today) };
    });
    assert.equal(r.ten, 10, `a date ten days out read as ${r.ten}`);
    assert.equal(r.today, 0, `today read as ${r.today}`);
  });

  // ---------- Bucketing ----------
  await check('a document sorts by how soon it bites', async () => {
    const r = await run((iso) => [
      documentBucket(doc({ expiresOn: iso.past })),
      documentBucket(doc({ expiresOn: iso.today })),
      documentBucket(doc({ expiresOn: iso.week })),
      documentBucket(doc({ expiresOn: iso.month })),
      documentBucket(doc({ expiresOn: iso.later })),
      documentBucket(doc({})),
    ], {
      past: await inDays(-3), today: await inDays(0), week: await inDays(5),
      month: await inDays(20), later: await inDays(200),
    });
    assert.deepEqual(r, ['expired', 'week', 'week', 'month', 'later', 'none'],
      `buckets came back as ${JSON.stringify(r)}`);
  });

  await check('a receipt with no expiry is a real state, not missing data', async () => {
    const r = await run(() => [documentBucket(doc({})), documentLabel(doc({}))]);
    assert.equal(r[0], 'none', 'a receipt should be in the no-expiry bucket');
    assert.match(r[1], /no expiry/i, `the label should say so, got "${r[1]}"`);
  });

  await check('an unreadable expiry is treated as no expiry, not as a real date', async () => {
    const r = await run(() => documentBucket(doc({ expiresOn: 'soon' })));
    assert.equal(r, 'none', 'a broken date must not be sorted as if it were real');
  });
  // ---------- The reminder ----------
  await check('the reminder fires before the expiry, not on it', async () => {
    // 45 days out, so the lead time is genuinely in the future and the clamp below does not move
    // it Ã¢â‚¬â€ a shorter expiry would be inside the window, and then "now" would be the right answer.
    const r = await run((iso) => {
      const fire = documentReminderTime(doc({ expiresOn: iso }));
      const expiry = parseIsoDate(iso).getTime();
      return { fire, lead: Math.round((expiry - fire) / 86400000) };
    }, await inDays(45));
    assert.ok(r.fire, 'a document expiring in 45 days must have a reminder time');
    assert.equal(r.lead, 30, `the reminder should lead by 30 days, it led by ${r.lead}`);
  });

  await check('an expiry inside the lead time is not scheduled in the past', async () => {
    // days - 30 is negative here. Scheduling into the past would fire on every single load, and
    // "this expires in five days" deserves to be said once, on purpose.
    const r = await run((iso) => {
      const fire = documentReminderTime(doc({ expiresOn: iso }));
      return { fire, now: Date.now() };
    }, await inDays(5));
    assert.ok(r.fire, 'an expiring document must still be reminded');
    assert.ok(r.fire >= r.now - 60000, 'the reminder time is in the past, so it would fire at once');
  });

  await check('an already-expired document is reminded inside a grace window', async () => {
    const r = await run((iso) => documentReminderTime(doc({ expiresOn: iso })), await inDays(-2));
    assert.ok(r, 'a document that lapsed two days ago still needs renewing');
  });

  await check('a long-expired document stops reminding', async () => {
    // Otherwise every receipt ever filed nags on every load, forever.
    const r = await run((iso) => documentReminderTime(doc({ expiresOn: iso })), await inDays(-400));
    assert.equal(r, null, 'a document that expired over a year ago must be silent');
  });

  await check('a non-document is not reminded by an expires_on field', async () => {
    const r = await run((iso) => itemReminderTime(
      { id: 't1', kind: 'task', title: 'Task', done: false, created: 1, expiresOn: iso },
    ), await inDays(3));
    assert.equal(r, null, 'a task with a stray field must not be reminded by it');
  });

  await check('a document is reminded by its expiry even with no due date at all', async () => {
    // The whole feature. A document never gets a dueDate, so if this path needed one, documents
    // would appear in a list and never once say anything.
    const r = await run((iso) => itemReminderTime(doc({ expiresOn: iso, dueDate: '' })), await inDays(10));
    assert.ok(r, 'a document with no due date must still be reminded');
  });
  // ---------- The capture path ----------
  await check('a photographed warranty is offered the document option', async () => {
    // The builder reads captureChannel and imageOcrText as globals, so they have to be set to what a
    // real read would have left behind Ã¢â‚¬â€ otherwise this passes for the wrong reason (no question at
    // all) or fails for the wrong one (a question it would never have asked).
    const r = await run((text) => {
      captureChannel = 'image';
      imageOcrText = text;
      const built = buildCaptureQuestions(text, { dueDate: new Date().toISOString() });
      return built.flatMap((q) => q.options.map((o) => o.value));
    }, 'WARRANTY CERTIFICATE\nModel X200L\nValid till 04 March 2027');
    assert.ok(r.includes('document'), `the fourth option is missing from ${JSON.stringify(r)}`);
  });

  await check('an appointment card is not offered the document option', async () => {
    // The reverse failure: offering "keep as document" for a clinic slip adds a wrong answer to
    // every photographed appointment, and the wrong one is what gets tapped in a hurry.
    const r = await run((text) => {
      captureChannel = 'image';
      imageOcrText = text;
      const built = buildCaptureQuestions(text, { dueDate: new Date().toISOString() });
      return built.flatMap((q) => q.options.map((o) => o.value));
    }, 'APOLLO CLINIC\nDr Ramesh\n05 October 2026 4:00 PM\nRoom 12');
    assert.ok(!r.includes('document'), `an appointment card was offered documents: ${JSON.stringify(r)}`);
  });

  await check('a document saved from a picture keeps the expiry that was read', async () => {
    const r = await run(async () => {
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      pickType('image', true);
      imageOcrText = 'WARRANTY\nModel X200L\nValid till 04 March 2027';
      document.getElementById('captureText').value = imageOcrText;
      document.getElementById('captureDueDate').value = '2027-03-04T00:00';
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 1100));
      const button = [...document.querySelectorAll('.capture-question-actions .btn')]
        .find((b) => b.textContent.trim() === 'Keep as document');
      if (!button) return { error: 'no document option was offered' };
      button.click();
      return {
        visible: getComputedStyle(document.getElementById('captureDocFields')).display !== 'none',
        expiry: document.getElementById('captureDocExpires').value,
        kind: captureType,
      };
    });
    assert.ok(!r.error, r.error);
    assert.equal(r.kind, 'document', `the capture became a ${r.kind}`);
    assert.equal(r.expiry, '2027-03-04', `the expiry was not carried across: "${r.expiry}"`);
    assert.ok(r.visible, 'the document fields did not appear');
  });

  await check('a saved document is not filed as a task due that day', async () => {
    // The date was read as a due date, and if that survived the save it would nag on the day it was
    // photographed Ã¢â‚¬â€ a warranty is not something you do today.
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      pickType('document', true);
      document.getElementById('captureText').value = 'Car insurance policy';
      document.getElementById('captureDueDate').value = '2027-05-01T09:00';
      document.getElementById('captureDocExpires').value = '2027-05-01';
      document.getElementById('captureDocIssuer').value = 'HDFC';
      await saveCapture(true);
      const item = state.items[0];
      return item
        ? { kind: item.kind, dueDate: item.dueDate, expiresOn: item.expiresOn, issuer: item.issuer }
        : { error: 'nothing was saved' };
    });
    assert.ok(!r.error, r.error);
    assert.equal(r.kind, 'document', `saved as ${r.kind}`);
    assert.equal(r.expiresOn, '2027-05-01', 'the expiry was not saved');
    assert.equal(r.issuer, 'HDFC', 'the issuer was not saved');
    assert.equal(r.dueDate, '', 'the document kept the due date and will nag as a task');
  });
  // ---------- The view ----------
  await check('the Documents view groups by urgency and hides empty groups', async () => {
    const r = await run((isos) => {
      state.items = [
        { id: 'a', kind: 'document', title: 'Lapsed policy', created: 1, expiresOn: isos.past },
        { id: 'b', kind: 'document', title: 'This week', created: 2, expiresOn: isos.week },
        { id: 'c', kind: 'document', title: 'Later', created: 3, expiresOn: isos.later },
        { id: 'd', kind: 'task', title: 'Not a document', created: 4 },
      ];
      renderDocuments();
      return {
        heads: [...document.querySelectorAll('#documentsList .card-head h3')]
          .map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
        rows: document.querySelectorAll('#documentsList .task-row').length,
        chips: [...document.querySelectorAll('#documentsList .doc-chip')].map((c) => c.className),
      };
    }, { past: await inDays(-5), week: await inDays(4), later: await inDays(300) });
    assert.equal(r.rows, 3, `expected the three documents, saw ${r.rows} rows Ã¢â‚¬â€ a task leaked in`);
    assert.ok(!r.heads.some((h) => /no expiry/i.test(h)),
      `an empty group was rendered: ${JSON.stringify(r.heads)}`);
    assert.ok(r.heads.some((h) => /expired/i.test(h)), 'the expired group is missing');
    assert.ok(r.chips.some((c) => /doc-expired/.test(c)), 'the expired chip is not marked');
  });

  await check('the expiry chip says something a person can act on', async () => {
    const r = await run((isos) => ({
      today: documentLabel({ kind: 'document', expiresOn: isos.today }),
      tomorrow: documentLabel({ kind: 'document', expiresOn: isos.tomorrow }),
      soon: documentLabel({ kind: 'document', expiresOn: isos.soon }),
      past: documentLabel({ kind: 'document', expiresOn: isos.past }),
    }), { today: await inDays(0), tomorrow: await inDays(1), soon: await inDays(9), past: await inDays(-2) });
    assert.match(r.today, /today/i, `got "${r.today}"`);
    assert.match(r.tomorrow, /tomorrow/i, `got "${r.tomorrow}"`);
    assert.match(r.soon, /9 days/, `got "${r.soon}"`);
    assert.match(r.past, /expired/i, `got "${r.past}"`);
  });

  await check('a title with quotes cannot break the row', async () => {
    // The onclick carries the id through a JS string and every attribute goes through escapeHtml.
    // A real receipt title does contain quotes.
    const r = await run(() => {
      state.items = [{ id: 'id"with\'quotes', kind: 'document', title: 'Bill "X" & co', created: 1 }];
      renderDocuments();
      const el = document.querySelector('#documentsList [onclick]');
      return el
        ? { onclick: el.getAttribute('onclick'), text: el.textContent }
        : { error: 'no row rendered' };
    });
    assert.ok(!r.error, r.error);
    assert.ok(r.onclick.includes('openPanel'), 'the row is not clickable');
    assert.ok(r.text.includes('Bill'), `the title was mangled: "${r.text}"`);
  });

  // ---------- Round trip ----------
  await check('a document survives the row round trip', async () => {
    const r = await run(() => {
      documentColumns.docType = true;
      documentColumns.issuer = true;
      documentColumns.docNumber = true;
      documentColumns.expiresOn = true;
      const item = rowToItem({
        id: 'd9', kind: 'document', title: 'Passport', created: 1,
        doc_type: 'passport', issuer: 'Passport Office',
        doc_number: 'X123', expires_on: '2031-01-09',
      });
      return { t: item.docType, i: item.issuer, n: item.docNumber, e: item.expiresOn };
    });
    assert.deepEqual(r, { t: 'passport', i: 'Passport Office', n: 'X123', e: '2031-01-09' },
      `fields lost on the way in: ${JSON.stringify(r)}`);
  });

  await check('a task does not inherit an issuer left on its row', async () => {
    // A row that used to be a document and was re-typed as a task must not keep the fields.
    const r = await run(() => {
      documentColumns.issuer = true;
      const item = rowToItem({ id: 't9', kind: 'task', title: 'Task', created: 1, issuer: 'Croma' });
      return { leaked: item.issuer !== undefined, isDoc: isDocument(item) };
    });
    assert.ok(!r.leaked, 'a task picked up a document field');
    assert.ok(!r.isDoc, 'a task must not be treated as a document');
  });

  await check('a broken expiry from the server is dropped rather than shown', async () => {
    const r = await run(() => {
      documentColumns.expiresOn = true;
      return documentBucket(rowToItem({
        id: 'd8', kind: 'document', title: 'Broken', created: 1, expires_on: 'next year',
      }));
    });
    assert.equal(r, 'none', 'an unreadable expiry was sorted as if it meant something');
  });

  await check('the columns are only sent when the database has them', async () => {
    // PostgREST rejects an entire upsert over one unknown column, so the probe is what keeps a
    // database that has not run migration 010 saving normally.
    const r = await run(() => {
      documentColumns.docType = false;
      documentColumns.expiresOn = false;
      const row = itemToRow({ id: 'd7', kind: 'document', title: 'No migration yet', created: 1 });
      return { hasType: 'doc_type' in row, hasExpiry: 'expires_on' in row };
    });
    assert.ok(!r.hasType && !r.hasExpiry, 'the row claimed columns the database may not have');
  });

  await check('the reminder text names the expiry', async () => {
    const r = await run((iso) => reminderPayload(doc({ expiresOn: iso, sub: '' })).body, await inDays(12));
    assert.match(r, /expire/i, `the notification said "${r}"`);
  });
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
if (!failed) console.log(`\nALL ${results.length} DOCUMENT CHECKS PASSED`);
else console.log(`\n${failed} of ${results.length} document checks FAILED`);
