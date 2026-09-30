// Real-time visual check: renders the capture sheet with a plan and screenshots it, so the
// layout can be looked at rather than inferred. Also asserts the plan does not overflow the
// sheet, which the mobile audit cannot do on its own (it only ever sees an empty sheet).
//   node Everything/tests/plan-visual.mjs
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.resolve(root, '..', 'tmp');
let PORT = 4402;

const PLAN = [
  { kind: 'event', title: 'Design team meeting', dueDate: '2026-09-27T09:00:00.000Z', person: 'Priya', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
  { kind: 'agenda', title: 'Discuss the new app rollout', dueDate: '', person: '', project: '', priority: '', recurrence: 'none', confidence: 'high', ambiguous: '' },
  { kind: 'task', title: 'Send Priya\'s <proposal> & quote "v2"', dueDate: '', person: 'Priya', project: 'Atlas', priority: 'high', recurrence: 'none', confidence: 'medium', ambiguous: 'Send it to Priya or the whole team?' },
  { kind: 'waiting', title: 'Signed contract from the client', dueDate: '', person: 'Ravi', project: 'Atlas', priority: '', recurrence: 'none', confidence: 'medium', ambiguous: '' },
];

const server = await startTestServer(PORT, (p) => { PORT = p; });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];
const record = (ok, name, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const SENTENCE = 'Tomorrow we have a meeting with the design team at 9 AM. Need to discuss the new app and send the proposal afterward, and chase the signed contract from Ravi.';

const shoot = async (name, viewport) => {
  const page = await browser.newPage({ viewport });
  await page.route('**/api/ask', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ extraction: PLAN[0], items: PLAN, provider: 'visual', model: 'visual' }),
  }));
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.openCapture === 'function' && !!document.getElementById('quickRemember'));
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => openCapture());
  await page.fill('#captureText', SENTENCE);
  await page.waitForSelector('.capture-plan-row', { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  return page;
};


const geometry = () => {
  const s = document.querySelector('.modal-capture').getBoundingClientRect();
  return {
    sheet: { left: Math.round(s.left), right: Math.round(s.right) },
    vw: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    rowCount: document.querySelectorAll('.capture-plan-row').length,
    label: document.getElementById('captureSaveBtn').textContent,
    rows: [...document.querySelectorAll('.capture-plan-row')].map((r) => {
      const b = r.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right) };
    }),
    due: [...document.querySelectorAll('.capture-plan-due')].map((d) => Math.round(d.getBoundingClientRect().width)),
    rawTitle: document.querySelectorAll('.capture-plan-title')[0]?.value || '',
  };
};

try {
  const desk = await shoot('plan-desktop', { width: 1280, height: 900 });
  const d = await desk.evaluate(geometry);
  // 4 entries: event (drives the form), agenda (folds into its checklist), task, waiting.
  // So 2 rows, and 3 saved items Ã¢â‚¬â€ the agenda line is not a fourth item.
  record(d.rowCount === 2, 'only the two work items are listed as rows', JSON.stringify(d.rowCount));
  record(/Save 3 items/.test(d.label), 'the save button counts items, not entries', d.label);
  record(d.rows.every((r) => r.left >= d.sheet.left && r.right <= d.sheet.right), 'every row sits inside the sheet', JSON.stringify(d.rows));
  record(d.scrollW <= d.vw, 'the page does not scroll horizontally', `scrollW=${d.scrollW} vw=${d.vw}`);
  // The apostrophes, angle brackets and ampersand must come back as literal text.
  record(d.rawTitle.includes('<proposal>') && d.rawTitle.includes("'s"), 'a hostile title is stored verbatim', d.rawTitle);

  const mob = await shoot('plan-mobile', { width: 390, height: 844 });
  const m = await mob.evaluate(geometry);
  record(m.rows.every((r) => r.left >= m.sheet.left && r.right <= m.sheet.right), 'rows fit the sheet at 390px', JSON.stringify(m.rows));
  record(m.scrollW <= m.vw, 'no horizontal scroll at 390px', `scrollW=${m.scrollW} vw=${m.vw}`);
  record(m.due.length > 0 && m.due.every((w) => w > 60), 'the date inputs stay usable at 390px', JSON.stringify(m.due));

  // Reachability. A plan makes the sheet taller than one screen, which is acceptable only if the
  // count is readable while reviewing (the header) and Save is reachable by scrolling the sheet.
  const reach = await mob.evaluate(() => {
    const sheet = document.querySelector('.modal-capture');
    const btn = document.getElementById('captureSaveBtn');
    const s = sheet.getBoundingClientRect();
    const head = document.querySelector('.capture-plan-head').getBoundingClientRect();
    return {
      scrolls: sheet.scrollHeight > sheet.clientHeight,
      sheetScroll: sheet.scrollHeight,
      sheetClient: sheet.clientHeight,
      headVisible: head.bottom <= s.bottom,
      saveReachable: btn.getBoundingClientRect().top - s.top < sheet.scrollHeight,
    };
  });
  record(reach.headVisible, 'the item count is readable while reviewing, without scrolling', JSON.stringify(reach));
  record(reach.scrolls && reach.saveReachable, 'the sheet scrolls, so Save is reachable', JSON.stringify(reach));
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nVISUAL CHECKS FAILED' : `\nALL ${results.length} VISUAL CHECKS PASSED`);
console.log(`screenshots: ${OUT}\\plan-desktop.png, ${OUT}\\plan-mobile.png`);
