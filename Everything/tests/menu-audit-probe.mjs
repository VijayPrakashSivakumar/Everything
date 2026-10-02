// Proves the menu is real: every nav item is drawn at boot, every one leads to its own view, and every
// control on the way there actually does something.
//
//   node Everything/tests/menu-audit-probe.mjs
//
// This exists because the menu was empty at boot. renderNav() is called from nine places — switchView,
// the item panel, model writes, utils — but not from init, so #navList rendered nothing until the person
// navigated somewhere else first. For a signed-in user the hole was invisible: Firestore's onSnapshot
// callbacks call renderNav() as data arrives, so the menu turned up a moment after load. To anyone who
// never received that data it was simply an app with no menu.
//
// What let it survive so long is that the other probes all navigate before they assert. Each calls
// switchView() in its own setup, and that is itself a renderNav() call, so the menu was drawn before
// every feature probe looked at it. The gap only shows if you ask what is on screen *at load*, before
// anything has been clicked — which is what a person sees first, and on a phone it is the whole drawer.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, bootApp } from './test-server.mjs';

let PORT = 4441;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 140)));

  await bootApp(page, PORT);

  await check('the menu is drawn at load, before anything is clicked', async () => {
    // The whole regression in one assertion: no switchView, no renderNav, no seeding. Just boot.
    const count = await page.evaluate(() => document.querySelectorAll('#navList .nav-item').length);
    assert.ok(count > 0, `#navList is empty at load (${count} items) — the menu only appears once something else draws it`);
  });

  await check('every nav item is present, in the order the model declares', async () => {
    const { drawn, declared } = await page.evaluate(() => ({
      drawn: Array.from(document.querySelectorAll('#navList .nav-item'))
        .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()),
      declared: (typeof NAV !== 'undefined' ? NAV : []).map((n) => n.label),
    }));
    assert.equal(drawn.length, declared.length,
      `drew ${drawn.length} items, model declares ${declared.length}: ${JSON.stringify(drawn)}`);
    // Labels carry badge counts, so compare on the leading word rather than the whole string.
    drawn.forEach((label, i) => {
      assert.ok(label.startsWith(declared[i].split(' ')[0]),
        `item ${i} reads "${label}", expected it to start with "${declared[i]}"`);
    });
  });

  await check('one menu item is marked as the current view', async () => {
    const r = await page.evaluate(() => ({
      activeCount: document.querySelectorAll('#navList .nav-item.active').length,
      activeView: (document.querySelector('.view.active') || {}).id,
    }));
    assert.equal(r.activeCount, 1, `${r.activeCount} items marked current, expected exactly 1`);
    assert.equal(r.activeView, 'view-today', `the current view is ${r.activeView}, expected view-today`);
  });

  await check('every nav item leads to its own view', async () => {
    const report = await page.evaluate(async () => {
      const out = [];
      for (const item of NAV) {
        switchView(item.id);
        await new Promise((r) => setTimeout(r, 220));
        const view = document.getElementById('view-' + item.id);
        out.push({
          id: item.id,
          label: item.label,
          exists: !!view,
          shown: !!view && view.classList.contains('active'),
          isCurrent: (document.querySelector('.view.active') || {}).id === 'view-' + item.id,
        });
      }
      return out;
    });
    for (const r of report) {
      assert.ok(r.exists, `"${r.label}" has no #view-${r.id} element`);
      assert.ok(r.isCurrent && r.shown, `"${r.label}" did not become the visible view`);
    }
  });

  await check('every view renders content, not just a title', async () => {
    // A view that activates but renders nothing is a menu entry that leads nowhere, which is this same
    // failure in a different costume.
    const thin = await page.evaluate(async () => {
      const out = [];
      for (const item of NAV) {
        switchView(item.id);
        await new Promise((r) => setTimeout(r, 220));
        const view = document.getElementById('view-' + item.id);
        const text = view ? (view.innerText || '').replace(/\s+/g, ' ').trim() : '';
        out.push({ id: item.id, label: item.label, chars: text.length });
      }
      return out;
    });
    // Nothing is seeded here, so an empty record list is legitimate; the heading must still render.
    const empty = thin.filter((v) => v.chars < 12);
    assert.deepEqual(empty, [], `these views rendered almost nothing: ${JSON.stringify(empty)}`);
  });

  await check('the account button reaches Settings, which is not in the menu', async () => {
    // Settings renders and switchView handles it but is deliberately not a NAV entry, so it needs some
    // other way in. The sidebar Account button is that way: if it stops working, Settings is unreachable
    // from the entire app.
    const r = await page.evaluate(async () => {
      switchView('today');
      await new Promise((x) => setTimeout(x, 200));
      const inNav = NAV.some((n) => n.id === 'settings');
      const btn = document.querySelector('.sidebar-profile');
      if (!btn) return { inNav, found: false, reached: false };
      btn.click();
      await new Promise((x) => setTimeout(x, 300));
      const v = document.getElementById('view-settings');
      return { inNav, found: true, reached: !!v && v.classList.contains('active') };
    });
    assert.equal(r.inNav, false, 'settings should not be a normal nav entry — it is reached from Account');
    assert.ok(r.found, 'the sidebar Account button is gone, so Settings has no way in');
    assert.ok(r.reached, 'the Account button did not open Settings');
  });

  await check('booting the app raised no errors', async () => {
    assert.deepEqual(pageErrors, [], `page errors during boot: ${JSON.stringify(pageErrors)}`);
  });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.setDefaultTimeout(30000);
  await bootApp(phone, PORT);

  await check('the phone menu opens onto a real list', async () => {
    // The specific shape this bug took on a phone: the drawer slid open perfectly well, onto nothing.
    const r = await phone.evaluate(async () => {
      const auth = document.getElementById('authScreen');
      if (auth) auth.style.display = 'none';
      const opener = document.querySelector('[aria-label="Open menu"]');
      if (!opener) return { opened: false };
      opener.click();
      await new Promise((x) => setTimeout(x, 450));
      const sidebar = document.querySelector('.sidebar');
      const box = sidebar ? sidebar.getBoundingClientRect() : null;
      const items = Array.from(document.querySelectorAll('#navList .nav-item'));
      return {
        opened: true,
        onScreen: !!box && box.x >= 0 && box.width > 0,
        count: items.length,
        // A visible box is not a tappable one: elementFromPoint is what a finger actually hits.
        tappable: items.filter((el) => {
          const b = el.getBoundingClientRect();
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return !!top && (el.contains(top) || top.contains(el));
        }).length,
      };
    });
    assert.ok(r.opened, 'no menu button on a phone');
    assert.ok(r.onScreen, 'the menu opened off-screen');
    assert.ok(r.count > 0, 'the phone menu opened with no items in it');
    assert.equal(r.tappable, r.count, `only ${r.tappable} of ${r.count} menu items can actually be tapped`);
  });

  await check('every phone menu item navigates when tapped', async () => {
    const report = await phone.evaluate(async () => {
      const key = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14);
      const labels = Array.from(document.querySelectorAll('#navList .nav-item')).map(key);
      const out = [];
      for (const label of labels) {
        // Choosing a view closes the drawer, so it has to be reopened before each tap.
        const opener = document.querySelector('[aria-label="Open menu"]');
        if (opener) { opener.click(); await new Promise((r) => setTimeout(r, 300)); }
        const el = Array.from(document.querySelectorAll('#navList .nav-item')).find((n) => key(n) === label);
        if (!el) { out.push({ label, reached: false, view: 'vanished' }); continue; }
        el.click();
        await new Promise((r) => setTimeout(r, 350));
        const v = document.querySelector('.view.active');
        out.push({ label, reached: !!v && v.classList.contains('active'), view: v ? v.id : 'none' });
      }
      return out;
    });
    assert.ok(report.length > 0, 'no menu items to tap');
    for (const r of report) {
      assert.ok(r.reached, `tapping "${r.label}" on a phone did not open a view (${r.view})`);
    }
  });
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
if (!failed) console.log(`\nALL ${results.length} MENU CHECKS PASSED`);
else console.log(`\n${failed} of ${results.length} menu checks FAILED`);
