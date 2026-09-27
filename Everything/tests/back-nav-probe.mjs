// Real-browser check for swipe-back. A back press is a real history move, so the honest way to
// test it is to make one and watch what the screen does.
//   node Everything/tests/back-nav-probe.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 4405;

const server = spawn('node', [path.resolve(root, '..', 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
};

const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const view = () => page.evaluate(() => (document.querySelector('.view.active') || {}).id);
const layers = () => page.evaluate(() => JSON.stringify(navState.layers));
const openBits = () => page.evaluate(() => ({
  modal: !!document.querySelector('.modal-overlay.open'),
  ask: document.getElementById('askOverlay').classList.contains('open'),
  panel: document.getElementById('panel').classList.contains('open'),
  sidebar: document.getElementById('sidebar').classList.contains('open'),
  dropdown: !document.getElementById('searchDropdown').hidden,
}));
// What the person's thumb does, and what a router would receive.
const swipeBack = () => page.goBack();


try {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.initBackNavigation === 'function');
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    if (typeof renderNav === 'function') renderNav();
  });
  await page.waitForTimeout(300);

  await check('the app starts on one clean history entry', async () => {
    assert.equal(await view(), 'view-today');
    assert.equal(await layers(), '[]', 'no layer entries before anything is opened');
  });

  await check('navigating between pages builds a history entry each time', async () => {
    await page.evaluate(() => switchView('tasks', { history: 'push' }));
    await page.waitForTimeout(150);
    assert.equal(await view(), 'view-tasks');
    await page.evaluate(() => switchView('projects', { history: 'push' }));
    await page.waitForTimeout(150);
    assert.equal(await view(), 'view-projects');
    // And back walks them in reverse, which is the whole point.
    await swipeBack();
    await page.waitForTimeout(300);
    assert.equal(await view(), 'view-tasks', 'back from Projects must return to Tasks');
    await swipeBack();
    await page.waitForTimeout(300);
    assert.equal(await view(), 'view-today', 'back from Tasks must return to the Dashboard');
  });

  await check('a sheet opened on a page is one entry, and back closes just it', async () => {
    await page.evaluate(() => openCapture());
    await page.waitForTimeout(300);
    assert.deepEqual(JSON.parse(await layers()), ['modal'], 'the sheet must have its own entry');
    const before = await view();
    await swipeBack();
    await page.waitForTimeout(300);
    const open = await openBits();
    assert.equal(open.modal, false, 'back must close the sheet');
    assert.equal(await view(), before, 'back must not change the page underneath the sheet');
    assert.equal(await layers(), '[]', 'the entry must be consumed, not left behind');
  });

  await check('nested layers unwind one at a time', async () => {
    // Page -> sheet -> slide-over on top. Back must peel them one by one, not all at once.
    await page.evaluate(() => openCapture());
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      document.getElementById('captureModal').classList.remove('open');
      // openPanel() needs a real item, and this session has none signed in, so give it one.
      if (!state.items.length) {
        state.items.push({ id: 'probe-item', kind: 'task', title: 'Probe item', sub: 'Captured task', done: false, created: Date.now() });
      }
      openPanel(state.items[0].id);
    });
    await page.waitForTimeout(300);
    assert.deepEqual(JSON.parse(await layers()), ['modal', 'panel'], 'both layers must be tracked');
    await swipeBack();
    await page.waitForTimeout(300);
    const open = await openBits();
    assert.equal(open.panel, false, 'back must close the slide-over');
    assert.equal(open.modal, false, 'only the top layer may close on one press');
    assert.equal(await view(), 'view-today', 'the page underneath must be untouched');
  });

  await check('a layer closed by its own button does not leave a stale entry', async () => {
    await page.evaluate(() => openCapture());
    await page.waitForTimeout(300);
    assert.deepEqual(JSON.parse(await layers()), ['modal']);
    await page.evaluate(() => closeCapture());
    await page.waitForTimeout(400);
    assert.equal(await layers(), '[]', 'closing by button must unwind the entry too');
    await page.evaluate(() => switchView('goals', { history: 'push' }));
    await page.waitForTimeout(200);
    await swipeBack();
    await page.waitForTimeout(300);
    assert.equal(await view(), 'view-today', 'back must still walk pages after a button close');
  });

  await check('the menu and the search dropdown are guarded as well', async () => {
    await page.evaluate(() => { document.getElementById('sidebar').classList.add('open'); });
    await page.waitForTimeout(300);
    assert.deepEqual(JSON.parse(await layers()), ['sidebar'], 'the menu must get an entry');
    await swipeBack();
    await page.waitForTimeout(300);
    assert.equal((await openBits()).sidebar, false, 'back must close the menu');

    await page.evaluate(() => openSearch());
    await page.waitForTimeout(300);
    assert.deepEqual(JSON.parse(await layers()), ['search'], 'the search dropdown must get an entry');
    await swipeBack();
    await page.waitForTimeout(300);
    assert.equal((await openBits()).dropdown, false, 'back must close the search dropdown');
  });

  await check('Escape still closes things, and does not trap the history', async () => {
    await page.evaluate(() => openCapture());
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert.equal(await layers(), '[]', 'Escape must unwind the entry, or back would be swallowed');
    assert.equal((await openBits()).modal, false, 'Escape must still close the sheet');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nBACK CHECKS FAILED' : `\nALL ${results.length} BACK CHECKS PASSED`);
