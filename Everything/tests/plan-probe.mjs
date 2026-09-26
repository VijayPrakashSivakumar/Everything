// Live check for capture fan-out: one sentence must produce several saved items.
//   node Everything/tests/plan-probe.mjs
// Mocks /api/ask so the run needs no key and no network, then checks the sheet shows the plan
// and that saving writes one item per row, with agenda lines folded into the meeting's steps.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 4399;

const PLAN_REPLY = {
  items: [
    { kind: 'event', title: 'Design team meeting', dueDate: '2026-09-27T09:00:00.000Z', person: '', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
    { kind: 'agenda', title: 'Discuss the new app', dueDate: '', person: '', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
    { kind: 'task', title: 'Send the proposal', dueDate: '', person: '', project: '', priority: '', recurrence: 'none', confidence: 'medium', ambiguous: 'Send it to Priya or the whole team?' },
  ],
};

// A different plan for the second save. Now that work is titled by the reading, the same reply
// twice means the same title twice, which the duplicate guard correctly refuses.
const OTHER_REPLY = {
  items: [
    { kind: 'event', title: 'Friday sync', dueDate: '2026-09-25T14:00:00.000Z', person: '', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
    { kind: 'agenda', title: 'Review the roadmap', dueDate: '', person: '', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
    { kind: 'task', title: 'Send the invoice', dueDate: '', person: '', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
  ],
};

const server = spawn('node', [path.resolve(root, '..', 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
// Poll the server rather than sleeping: a fixed delay is a race on a cold start.
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/index.html`);
    if (res.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const page = await browser.newPage();
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

const MULTI = 'Tomorrow we have a meeting with the design team at 9 AM. Need to discuss the new app and send the proposal afterward.';
const typeIt = async (text, settle = 1800) => {
  await page.evaluate(() => openCapture());
  // The sign-in screen is re-shown by every auth-state callback, and it covers the sheet, so
  // it has to be lifted for each capture rather than once after load.
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.fill('#captureText', text);
  await page.waitForTimeout(settle);
};

try {
  // 'commit' rather than 'domcontentloaded': the head loads blocking CDN scripts, and the probe
  // must not hang on a slow CDN. Waiting for the global below is the real readiness signal.
  let reply = PLAN_REPLY;
  await page.route('**/api/ask', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ extraction: reply.items[0], items: reply.items, provider: 'probe', model: 'probe' }) }));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.openCapture === 'function' && !!document.getElementById('quickRemember'));
  // No session here, so the sign-in screen covers the app. Capture logic is unaffected, so
  // lift it out of the way rather than standing up a real account for a fan-out check.
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });

  await check('a one-clause capture shows no plan', async () => {
    await typeIt('call Ravi tomorrow at 10am about the quote', 1600);
    assert.equal(await page.locator('.capture-plan-row').count(), 0, 'no plan row for a single thing');
    assert.equal(await page.getAttribute('#capturePlan', 'hidden'), '', 'no plan block for a single thing');
    assert.match(await page.textContent('#captureSaveBtn'), /^Save$/, 'the label must not claim extra items');
  });

  await check('a multi-clause sentence shows every extra item, and says so', async () => {
    await typeIt(MULTI);
    assert.equal(await page.getAttribute('#capturePlan', 'hidden'), null, 'the plan must be shown');
    const rows = await page.$$eval('.capture-plan-row', (els) => els.map((el) => el.querySelector('.capture-plan-title').value));
    assert.deepEqual(rows, ['Send the proposal'], `only the follow-up is a separate item, got ${JSON.stringify(rows)}`);
    const head = await page.textContent('.capture-plan-head');
    assert.match(head, /holds 2 things/, `the count must be stated, got "${head}"`);
    assert.match(await page.textContent('#captureSaveBtn'), /Save 2 items/, 'the label must state the fan-out');
    assert.match(await page.textContent('.capture-plan-agenda'), /Discuss the new app/, 'the agenda line must be visible, not hidden');
    assert.match(await page.textContent('.capture-plan-flag'), /whole team/, 'an ambiguous row must carry its question');
  });

  await check('a row can be removed, and the label follows', async () => {
    await page.click('.capture-plan-remove');
    await page.waitForTimeout(150);
    // The block stays on purpose when an agenda line remains: it still has something to say
    // about the first item. What must go is the row and the extra count.
    assert.equal(await page.locator('.capture-plan-row').count(), 0, 'the row must be removed');
    assert.match(await page.textContent('#captureSaveBtn'), /^Save$/, 'the label must fall back to Save');
  });

  await check('saving writes one item per row, and the agenda becomes a checklist step', async () => {
    await typeIt(MULTI);
    await page.click('#captureSaveBtn');
    await page.waitForTimeout(900);
    const saved = await page.evaluate(() => state.items.map((i) => ({ id: i.id, title: i.title, kind: i.kind, rawText: i.rawText, checklist: (i.checklist || []).map((s) => s.text), planOf: i.captureMetadata?.planOf })));
    assert.equal(saved.length, 2, `expected 2 saved items, got ${JSON.stringify(saved.map((i) => i.title))}`);
    const main = saved.find((i) => i.kind === 'event');
    const extra = saved.find((i) => i.title === 'Send the proposal');
    assert.ok(main, `the meeting itself must be saved, got ${JSON.stringify(saved.map((i) => i.title))}`);
    assert.equal(main.title, 'Design team meeting', 'the reading must title the meeting, not echo the sentence');
    assert.equal(main.rawText, MULTI, 'the original sentence must still be kept');
    assert.ok(extra, 'the follow-up must be saved as its own item, not folded into the meeting');
    assert.equal(extra.kind, 'task');
    assert.deepEqual(main.checklist, ['Discuss the new app'], 'the agenda line must become a step on the meeting');
    assert.equal(extra.planOf, main.id, 'the extra item must link back to the first');
  });

  await check('a row edit is what gets saved, and a removed row is not', async () => {
    // A different plan, so the previous save is not a duplicate of this one.
    reply = OTHER_REPLY;
    await page.evaluate(() => openCapture());
    await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
    await page.fill('#captureText', 'On Friday we meet the team at 2 PM. Need to review the roadmap and send the invoice afterward.');
    // Edit only once the rows exist: a late setCapturePlan would overwrite the edit.
    await page.waitForSelector('.capture-plan-row', { timeout: 15000 });
    // Edited through the app's own handlers (what the row's oninput/onchange call) rather than
    // by typing, so this asserts the value the plan holds is the value that gets saved.
    await page.evaluate(() => {
      editCapturePlan(0, 'title', 'Book the room');
      editCapturePlan(0, 'kind', 'event');
      editCapturePlan(0, 'dueDate', '2026-10-02T14:00');
    });
    const edited = await page.evaluate(() => JSON.stringify({ ...capturePlan[0] }));
    assert.match(edited, /Book the room/, 'the edit must land on the plan');
    assert.match(edited, /"kind":"event"/, 'the changed kind must land on the plan');
    assert.match(edited, /2026-10-02/, 'the changed date must land on the plan');
    await page.click('#captureSaveBtn');
    await page.waitForTimeout(900);
    const titles = await page.evaluate(() => state.items.map((i) => ({ title: i.title, kind: i.kind, dueDate: i.dueDate })));
    assert.ok(titles.some((i) => i.title === 'Book the room'), `the edited title must win, got ${JSON.stringify(titles)}`);
    const saved = titles.find((i) => i.title === 'Book the room');
    assert.equal(saved.kind, 'event', 'the changed kind must be saved');
    assert.match(saved.dueDate, /^2026-10-02/, 'the changed date must be saved');
    assert.ok(titles.some((i) => i.title === 'Friday sync'), 'the main item must still be saved, titled by the reading');
    assert.ok(!titles.some((i) => i.title === 'Send the invoice'), 'the unedited model title must not be saved');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : `\nALL ${results.length} PLAN CHECKS PASSED`);
