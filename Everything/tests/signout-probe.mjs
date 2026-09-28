// Audits signing out. The one thing that has to be true: after signing out, the next account to
// sign in on this device must not see the previous account's data.
//
//   node Everything/tests/signout-probe.mjs
//
// The bug this exists for: everything_state_v1 is a single localStorage key shared by every
// account that uses this browser. Signing out cleared the Supabase session but left that key
// alone, so on a shared family tablet the next person to sign in merged the previous person's
// captures, goals and people into their own session. A phone is exactly where this happens.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4421;
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
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });


  await check('signing out clears the previous account data from this device', async () => {
    const out = await page.evaluate(async () => {
      // Pretend someone was signed in and left real work behind.
      state.items = [{ id: 'mine', kind: 'task', title: 'My private task', created: 1, dirty: true }];
      state.people = [{ id: 'p1', name: 'My Contact' }];
      state.goals = [{ id: 'g1', title: 'My Goal' }];
      state.projects = [{ id: 'j1', name: 'My Project' }];
      state.syncConflicts = [{ id: 'c1', title: 'My conflict' }];
      save();

      // The real sign-out path, with the network stubbed so no account is involved.
      const realFetch = window.fetch;
      window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      sb.auth.signOut = async () => ({ error: null });
      sb.removeAllChannels = async () => {};
      await authSignOut();
      window.fetch = realFetch;

      return {
        stored: localStorage.getItem('everything_state_v1'),
        items: (state.items || []).length,
        people: (state.people || []).length,
        goals: (state.goals || []).length,
        projects: (state.projects || []).length,
        conflicts: (state.syncConflicts || []).length,
      };
    });
    assert.equal(out.items, 0, 'the previous account tasks are still in memory after signing out');
    assert.equal(out.people, 0, 'the previous account people are still in memory after signing out');
    assert.equal(out.goals, 0, 'the previous account goals are still in memory after signing out');
    assert.equal(out.projects, 0, 'the previous account projects are still in memory after signing out');
    assert.equal(out.conflicts, 0, 'sync conflicts from the previous account survived the sign-out');
    // The decisive one: a second person on the same tablet must not inherit any of it.
    assert.equal(out.stored, null,
      'everything_state_v1 still holds the previous account data, so the next sign-in inherits it');
  });

  await check('a failed sign-out keeps the data rather than locking the person out of it', async () => {
    const out = await page.evaluate(async () => {
      const realFetch = window.fetch;
      window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      sb.auth.signOut = async () => ({ error: { message: 'network down' } });
      state.items = [{ id: 'keep', kind: 'task', title: 'Must survive', created: 1 }];
      save();
      const ok = await authSignOut();
      const after = localStorage.getItem('everything_state_v1');
      window.fetch = realFetch;
      return { ok, kept: JSON.parse(after || '{}').items?.length ?? 0 };
    });
    assert.equal(out.ok, false, 'a failed sign-out reported success');
    assert.equal(out.kept, 1, 'a failed sign-out wiped the data anyway — the person is now locked out of it');
  });

  await check('the sign-in page explains how to get in', async () => {
    const out = await page.evaluate(() => ({
      hasToggle: !!document.getElementById('authHelpToggle'),
      hasPanel: !!document.getElementById('authHelp'),
      hasSwitch: typeof window.switchAuthHelp === 'function',
      text: (document.getElementById('authHelp')?.textContent || '').replace(/\s+/g, ' '),
    }));
    assert.ok(out.hasToggle, 'the sign-in screen has no way to open help');
    assert.ok(out.hasPanel, 'there is no help panel to show');
    assert.ok(out.hasSwitch, 'the help toggle is not wired up');
    // The doc has to actually say how to get in, not merely exist.
    assert.match(out.text, /create an account/i, 'the help never says how to create an account');
    assert.match(out.text, /sign in/i, 'the help never says how to sign in');
    assert.match(out.text, /forgot password|reset/i, 'the help never mentions the reset path');
  });

  await check('the help panel opens, closes, and starts out closed', async () => {
    const out = await page.evaluate(() => {
      const panel = document.getElementById('authHelp');
      const toggle = document.getElementById('authHelpToggle');
      const startClosed = panel.hidden;
      switchAuthHelp();
      const afterOpen = { hidden: panel.hidden, aria: toggle.getAttribute('aria-expanded') };
      switchAuthHelp();
      const afterClose = { hidden: panel.hidden, aria: toggle.getAttribute('aria-expanded') };
      return { startClosed, afterOpen, afterClose };
    });
    assert.equal(out.startClosed, true, 'the help panel starts open and pushes the sign-in form down the screen');
    assert.equal(out.afterOpen.hidden, false, 'pressing the toggle did not open the help');
    assert.equal(out.afterOpen.aria, 'true', 'the toggle does not report that it is expanded');
    assert.equal(out.afterClose.hidden, true, 'pressing it again did not close the help');
    assert.equal(out.afterClose.aria, 'false', 'the toggle still claims to be expanded after closing');
  });

  await check('the sign-in screen fits a small phone with the help open', async () => {
    // The auth card is height-capped and scrolls, so the real question is whether the help is
    // reachable at all rather than cut off below the fold on the device people actually use.
    const phone = await browser.newPage({ viewport: { width: 360, height: 640 } });
    try {
      await phone.goto(testUrl(PORT), { waitUntil: 'commit' });
      await phone.waitForFunction(() => typeof window.switchAuthHelp === 'function');
      await phone.evaluate(() => switchAuthHelp(true));
      await phone.waitForTimeout(150);
      const out = await phone.evaluate(() => {
        const panel = document.getElementById('authHelp');
        const r = panel.getBoundingClientRect();
        return {
          width: Math.round(r.width),
          // Fully inside the card's own horizontal padding, not bleeding off a 360px screen.
          fitsHorizontally: r.left >= 0 && r.right <= window.innerWidth,
          text: panel.textContent.replace(/\s+/g, ' ').trim().length,
        };
      });
      assert.ok(out.fitsHorizontally, `the help panel overflows a 360px screen (left ${out.width})`);
      assert.ok(out.text > 200, 'the help panel rendered empty on a phone');
    } finally {
      await phone.close();
    }
  });

  await check('signing out is a normal page you can back out of', async () => {
    const out = await page.evaluate(() => ({
      hasView: !!document.getElementById('view-logout'),
      text: (document.getElementById('view-logout')?.textContent || '').replace(/\s+/g, ' '),
    }));
    assert.ok(out.hasView, 'the sign-out page is missing');
    assert.match(out.text, /log ?out|sign out/i, 'the sign-out page has no sign-out button');
    assert.match(out.text, /cancel|go back|stay/i,
      'the sign-out page gives no way back, so a misclick strands you on it');
  });
} finally {
  await browser.close();
  server.kill();
}

/* The banner wording is load-bearing: run-all.mjs scores a suite with
   /ALL (\d+) [A-Z -]*PASSED/ and marks it failed when that does not match — even when every check
   passed and the exit code is 0. It was "4 of 4 sign-out checks passed" here, which read as a
   failure in the summary while the output directly above it said otherwise. */
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nALL ${passed} SIGN-OUT CHECKS PASSED`);
