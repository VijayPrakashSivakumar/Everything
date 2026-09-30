// Real-time check for auto-create ("Done."): a sentence that read cleanly must save itself with
// no Save click, and must still be reversible. A sentence with any doubt must NOT.
//   node Everything/tests/autosave-probe.mjs
// Mocks /api/ask per test, so it needs no key and no network.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4403;

const entry = (over = {}) => ({
  kind: 'task', title: 'A thing', dueDate: '', person: '', project: '',
  priority: '', recurrence: 'none', confidence: 'high', ambiguous: '', ...over,
});

// Clean: no entry has a question, so the capture may decide for itself.
const CLEAR = [
  entry({ kind: 'event', title: 'Design team meeting', dueDate: '2026-09-27T09:00:00.000Z' }),
  entry({ kind: 'agenda', title: 'Discuss the new app' }),
  entry({ kind: 'task', title: 'Send the proposal' }),
];
// Doubtful: one entry is a question, so the app must ask instead of guessing.
const DOUBTFUL = [entry({ kind: 'event', title: 'Meet John', ambiguous: 'Which day next week?' })];

const server = await startTestServer(PORT);

const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

let reply = CLEAR;
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// One route serves two actions now, so it has to answer by action rather than always replying with
// the extraction shape: the categorize reply carries ids and kinds, and an extraction reply has
// neither. Returning the wrong one would make the Inbox tests pass for the wrong reason.
await page.route('**/api/ask', async (r) => {
  let action = '';
  try {
    action = JSON.parse(r.request().postData() || '{}').action || '';
  } catch {
    /* An unreadable body is treated as the default action rather than failing the whole check. */
  }
  if (action === 'categorize') {
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { id: 'i1', kind: 'task' },
          { id: 'i2', kind: 'waiting' },
          // A row that was already filed, and one the model was never sent. Both must be ignored:
          // the first needs no change, and the second is a reply about a row that does not exist.
          { id: 'i3', kind: 'memory' },
          { id: 'ghost', kind: 'task' },
        ],
        provider: 'probe',
        model: 'probe',
      }),
    });
  }
  return r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ extraction: reply[0], items: reply, provider: 'auto', model: 'auto' }),
  });
});

const open = async () => {
  await page.evaluate(() => openCapture());
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.waitForTimeout(120);
};
// Each check starts from nothing, so a count always means "created by this check".
const reset = async () => {
  await page.evaluate(() => {
    state.items = [];
    save();
    document.getElementById('captureUndo').hidden = true;
    document.getElementById('captureUndo').innerHTML = '';
  });
};
const type = async (text, settle = 3000) => {
  await open();
  await page.fill('#captureText', text);
  await page.waitForTimeout(settle);
};
const sheet = () => page.evaluate(() => ({
  modalOpen: document.getElementById('captureModal').classList.contains('open'),
  undoShown: !document.getElementById('captureUndo').hidden,
  undoText: document.getElementById('captureUndo').textContent.trim(),
  count: state.items.length,
  items: state.items.map((i) => ({ title: i.title, kind: i.kind, rawText: i.rawText, checklist: (i.checklist || []).map((s) => s.text) })),
}));

try {
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.openCapture === 'function' && !!document.getElementById('quickRemember'));

  // Checks 1-3 are one flow: an auto-create, then the bar, then undo. They share state on
  // purpose, because undo only means something against a capture that really happened.
  await check('a clean sentence saves itself, with no Save click', async () => {
    await reset();
    await type('Meeting with the design team at 9 tomorrow, discuss the new app, send the proposal after.');
    const s = await sheet();
    assert.equal(s.modalOpen, false, 'the sheet must close by itself');
    assert.equal(s.count, 2, `meeting + follow-up must both be created, got ${JSON.stringify(s.items.map((i) => i.title))}`);
    const titles = s.items.map((i) => i.title);
    assert.ok(titles.includes('Send the proposal'), 'the follow-up must exist without a Save click');
    // The reading titles the meeting; the sentence it came from stays in rawText.
    const meeting = s.items.find((i) => i.kind === 'event');
    assert.equal(meeting.title, 'Design team meeting', 'the meeting must not be titled with the whole sentence');
    assert.match(meeting.rawText || '', /design team at 9 tomorrow/i, 'the original sentence must be kept');
    assert.deepEqual(meeting.checklist, ['Discuss the new app'], 'the agenda line must be a step on the meeting');
  });

  await check('the auto-create names what it made and offers undo', async () => {
    const s = await sheet();
    assert.equal(s.undoShown, true, 'an auto-create must announce itself');
    assert.match(s.undoText, /Saved 2 items/, `the count must be stated, got "${s.undoText}"`);
  });

  await check('undo takes back the whole capture, not one row of it', async () => {
    await page.click('.capture-undo-btn');
    await page.waitForTimeout(700);
    const s = await sheet();
    assert.equal(s.count, 0, `every created item must go, left ${JSON.stringify(s.items.map((i) => i.title))}`);
    assert.equal(s.undoShown, false, 'the bar must go with it');
  });

  reply = DOUBTFUL;
  await check('a doubtful sentence asks instead of deciding', async () => {
    await reset();
    await type('Meet John sometime next week.');
    const s = await sheet();
    assert.equal(s.modalOpen, true, 'the sheet must stay open for a question');
    assert.equal(s.count, 0, 'nothing may be created on a guess');
    assert.equal(s.undoShown, false, 'nothing to undo, because nothing was created');
    // The question is on the main item, so it is shown in the plan block, not on a row.
    assert.match(await page.textContent('.capture-plan-ask'), /Which day next week\?/, 'the question must be shown');
  });

  reply = CLEAR;
  await check('touching a plan row cancels the auto-create', async () => {
    await reset();
    await open();
    await page.fill('#captureText', 'Meeting with the design team at 9 tomorrow, discuss the new app, send the proposal after.');
    // Act as soon as the rows exist: the settle is 1400ms after the reply, so waiting past it
    // would test nothing.
    await page.waitForSelector('.capture-plan-row', { timeout: 10000 });
    await page.evaluate(() => editCapturePlan(0, 'title', 'Send the invoice instead'));
    await page.waitForTimeout(2200);
    const s = await sheet();
    assert.equal(s.count, 0, 'an edited row must not be auto-saved');
    assert.equal(s.modalOpen, true, 'the sheet must wait once the person takes over');
  });

  await check('turning smart suggestions off stops the auto-create', async () => {
    await reset();
    await open();
    await page.uncheck('#captureSmartEnabled');
    await page.fill('#captureText', 'Meeting with the design team at 9 tomorrow, discuss the new app, send the proposal after.');
    await page.waitForTimeout(2600);
    const s = await sheet();
    assert.equal(s.count, 0, 'opting out of reading must mean opting out of auto-create');
    assert.equal(s.modalOpen, true, 'the sheet must wait for a manual save');
  });

  await check('a manual save still works, and raises no undo bar', async () => {
    // Smart suggestions stay off, so nothing can auto-save before the explicit Save.
    await reset();
    await open();
    await page.uncheck('#captureSmartEnabled');
    await page.fill('#captureText', 'Pay the electricity bill on Friday morning.');
    await page.waitForTimeout(2000);
    const before = await sheet();
    assert.equal(before.count, 0, 'nothing may be created without reading on');
    await page.evaluate(() => saveCapture(true));
    await page.waitForTimeout(700);
    const s = await sheet();
    assert.equal(s.count, 1, 'a manual save must still create the item');
    assert.equal(s.undoShown, false, 'a save the person made themselves needs no undo bar');
  });

  // ---------- Inbox categorization ----------

  const seedInbox = async () => {
    await page.evaluate(() => {
      state.items = [
        { id: 'i1', kind: '', title: 'ring the shop', sub: '', created: 3, done: false },
        { id: 'i2', kind: '', title: 'waiting on Ravi', sub: '', created: 2, done: false },
        { id: 'i3', kind: 'task', title: 'already filed', sub: 'Captured task', created: 1, done: false },
      ];
      save();
      renderInbox();
    });
    await page.evaluate(() => switchView('inbox'));
    await page.waitForTimeout(150);
  };

  await check('sorting proposes before it files, and "Not now" writes nothing', async () => {
    await seedInbox();
    await page.evaluate(() => { window.__saved = []; window.__realSave = window.dbSaveItem; window.dbSaveItem = async (i) => { window.__saved.push(i.id); }; });
    await page.evaluate(() => categorizeInbox());
    await page.waitForTimeout(300);

    const proposed = await page.evaluate(() => ({
      shown: !document.getElementById('inboxTidyPanel').hidden,
      titles: [...document.querySelectorAll('#inboxTidyPanel .task-title')].map((n) => n.textContent),
      saved: window.__saved.length,
      kinds: state.items.map((i) => i.kind),
    }));
    assert.equal(proposed.shown, true, 'the proposal was not shown before anything was filed');
    assert.equal(proposed.saved, 0, 'a row was saved before the person accepted');
    assert.deepEqual(proposed.kinds, ['', '', 'task'], `nothing may be written yet: ${JSON.stringify(proposed.kinds)}`);

    await page.evaluate(() => dismissCategorizePreview());
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ saved: window.__saved.length, kinds: state.items.map((i) => i.kind) }));
    assert.equal(after.saved, 0, 'declining the proposal still wrote to the data');
    assert.deepEqual(after.kinds, ['', '', 'task'], `declining changed the kinds: ${JSON.stringify(after.kinds)}`);
    await page.evaluate(() => { window.dbSaveItem = window.__realSave; });
  });

  await check('accepting files the proposal, by id', async () => {
    await seedInbox();
    await page.evaluate(() => { window.__saved = []; window.__realSave = window.dbSaveItem; window.dbSaveItem = async (i) => { window.__saved.push(i.id); }; });
    await page.evaluate(() => categorizeInbox());
    await page.waitForTimeout(300);
    await page.evaluate(() => applyCategorization());
    await page.waitForTimeout(300);

const r = await page.evaluate(() => ({
      saved: window.__saved,
      kinds: state.items.map((i) => i.kind),
      subs: state.items.map((i) => i.sub),
      count: state.items.length,
    }));
    // Matching is by id, and that is what two of these prove. "ghost" came back in the reply but was
    // never sent, so there is no row for it to touch at all; and i1's suggestion must not land on i2
    // just because the rows sit next to each other. i3 IS re-filed: the person asked for the inbox to
    // be sorted, so a row filed wrongly earlier is exactly what they meant to have looked at again.
    assert.deepEqual(r.saved, ['i1', 'i2', 'i3'], `the wrong rows were written: ${JSON.stringify(r.saved)}`);
    assert.deepEqual(r.kinds, ['task', 'waiting', 'memory'], `the kinds are wrong: ${JSON.stringify(r.kinds)}`);
    assert.equal(r.count, 3, `an extra row was written: ${r.count} rows, expected 3`);
    // The sub-line must follow the new kind: leaving "Captured task" under a memory would say the
    // row was filed as something it no longer is.
    assert.equal(r.subs[2], 'Memory', `the re-filed row kept a sub-line about its old kind: "${r.subs[2]}"`);
    assert.equal(r.subs[0], 'Captured task', 'a newly filed task lost its sub-line');
    await page.evaluate(() => { window.dbSaveItem = window.__realSave; });
  });

  await check('a failed model call leaves the Inbox exactly as it was', async () => {
    await seedInbox();
    await page.route('**/api/ask', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'busy', reason: 'groq:429' }) }));
    await page.evaluate(() => categorizeInbox());
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => ({
      panelHidden: document.getElementById('inboxTidyPanel').hidden,
      message: document.getElementById('inboxTidyStatus').textContent,
      button: document.getElementById('inboxTidyBtn').textContent,
      disabled: document.getElementById('inboxTidyBtn').disabled,
      kinds: state.items.map((i) => i.kind),
    }));
    assert.equal(r.panelHidden, true, 'a failed call still opened the proposal panel');
    assert.match(r.message, /busy|unchanged/i, `no explanation was shown: "${r.message}"`);
    assert.equal(r.button, 'Sort with AI', `the button was left saying "${r.button}"`);
    assert.equal(r.disabled, false, 'the button was left disabled, so the Inbox could never be sorted');
    assert.deepEqual(r.kinds, ['', '', 'task'], `a failed call changed the data: ${JSON.stringify(r.kinds)}`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : `\nALL ${results.length} AUTO-SAVE CHECKS PASSED`);

