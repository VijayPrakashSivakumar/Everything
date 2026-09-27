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
await page.route('**/api/ask', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ extraction: reply[0], items: reply, provider: 'auto', model: 'auto' }),
}));

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
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : `\nALL ${results.length} AUTO-SAVE CHECKS PASSED`);

