// Dialog layer probe: semantics, focus in, focus trapped, focus returned, app never left frozen.
//
//   node Everything/tests/layers-probe.mjs
//
// Why this is its own file: four of the five overlays in this app were not marked as dialogs, none of
// them trapped Tab, and none of them gave focus back on close. Every other suite passed the whole
// time, because a missing role and an escaping Tab break nothing â€” they just quietly make the app
// unusable for anyone not using a mouse with sight. A defect that invisible has to be driven
// deliberately, so it gets a probe rather than an extra assertion buried in an unrelated one.
//
// The last check is the important one. An earlier version kept its own list of open dialogs, and a
// close path that forgot to remove its entry left the whole app inert â€” frozen, unclickable, gone. It
// passed four checks and failed one, and that one was the whole ballgame. So the freeze is asserted
// directly, by closing every dialog without telling anyone and checking the app comes back.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl, bootApp } from './test-server.mjs';

let PORT = 4456;

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

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await bootApp(page, PORT);
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    state.items = [{ id: 'e1', kind: 'task', title: 'Renew the passport', done: false, created: 1 }];
    state.people = [{ id: 'p1', name: 'Ravi' }];
    if (typeof renderAll === 'function') renderAll();
    if (typeof renderNav === 'function') renderNav();
    switchView('tasks', { history: 'none' });
  });
  await page.waitForTimeout(300);
  // Stand on a real control first, so "focus came back here" has somewhere to come back to.
  await page.evaluate(() => { document.querySelector('.capture-btn').focus(); });

  await check('every overlay is a dialog with an accessible name', async () => {
    // Read from the markup rather than from a list kept here, so a sixth modal added later is
    // covered by not needing to be special-cased â€” and one that forgets fails here.
    const layers = await page.evaluate(() =>
      [...document.querySelectorAll('.modal-overlay, .ask-overlay')]
        .map((el) => ({
          id: el.id,
          role: el.getAttribute('role') || '',
          modal: el.getAttribute('aria-modal') || '',
          labelledby: el.getAttribute('aria-labelledby') || '',
          label: el.getAttribute('aria-label') || '',
        })));
    assert.ok(layers.length >= 6, `expected six overlays, found ${layers.length}`);
    for (const l of layers) {
      // alertdialog is accepted, and is in fact correct for the confirm dialog: it is interruptive
      // and destructive, so a screen reader should announce it more urgently than an ordinary sheet.
      // A plain dialog would be the weaker choice, not the stricter one.
      assert.ok(l.role === 'dialog' || l.role === 'alertdialog',
        `${l.id} is not marked as a dialog (role is "${l.role}")`);
      assert.equal(l.modal, 'true', `${l.id} is not aria-modal`);
      assert.ok(l.labelledby || l.label, `${l.id} has no accessible name`);
      if (l.labelledby) {
        assert.ok(await page.evaluate((id) => !!document.getElementById(id), l.labelledby),
          `${l.id} is labelled by "${l.labelledby}", which does not exist`);
      }
    }
  });

  await check('opening Capture moves focus into the sheet', async () => {
    await page.evaluate(() => openCapture());
    await page.waitForTimeout(250);
    const where = await page.evaluate(() => ({
      inside: document.getElementById('captureModal').contains(document.activeElement),
      id: document.activeElement?.id || '',
    }));
    assert.ok(where.inside, `focus stayed outside the sheet, on ${where.id || '<body>'}`);
  });

  await check('Tab stays inside the sheet instead of walking into the page behind it', async () => {
    // Real Tab presses, not a count of focusable elements. The actual failure is focus leaving the
    // dialog, so reproducing that is the only thing that proves it fixed.
    await page.evaluate(() => { document.getElementById('captureText').focus(); });
    const escapes = [];
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      if (!await page.evaluate(() => document.getElementById('captureModal')
        .contains(document.activeElement))) {
        escapes.push(await page.evaluate(() =>
          `${document.activeElement?.tagName}#${document.activeElement?.id || ''}`));
        break;
      }
    }
    assert.deepEqual(escapes, [], `Tab escaped the sheet and landed on ${escapes.join(', ')}`);
  });

  await check('Shift+Tab stays inside the sheet too', async () => {
    await page.evaluate(() => { document.getElementById('captureText').focus(); });
    const escapes = [];
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press('Shift+Tab');
      if (!await page.evaluate(() => document.getElementById('captureModal')
        .contains(document.activeElement))) {
        escapes.push(await page.evaluate(() => document.activeElement?.tagName));
        break;
      }
    }
    assert.deepEqual(escapes, [], `Shift+Tab escaped to ${escapes.join(', ')}`);
  });
await check('the page behind the sheet is inert, so a screen reader cannot read it', async () => {
    // The load-bearing part. The Tab handler only stops the keyboard; `inert` is what stops the page
    // behind being announced, and a trap that only works for sighted keyboard users is half a fix
    // wearing a whole fix's name.
    const app = await page.evaluate(() => {
      const el = document.querySelector('.app');
      return { found: !!el, inert: el ? el.inert : false };
    });
    assert.ok(app.found, 'could not find the app shell to check it went inert');
    assert.ok(app.inert, 'the app shell is still reachable behind an open dialog');
  });

  await check('closing the sheet hands focus back to where it came from', async () => {
    // Without this, focus falls to <body> and a keyboard user is dumped at the top of the document
    // with nothing to say where they were. It is the step that makes the trap worth having.
    await page.evaluate(() => { closeCapture(); });
    await page.waitForTimeout(250);
    const back = await page.evaluate(() => ({
      isBody: document.activeElement === document.body,
      appInert: document.querySelector('.app').inert === true,
      id: document.activeElement?.id || '',
    }));
    assert.ok(!back.isBody, `closing the sheet dropped focus on <body> (now on ${back.id})`);
    assert.ok(!back.appInert, 'the app shell stayed inert after the sheet closed');
  });

  await check('the edit dialog takes focus, which it never used to', async () => {
    await page.evaluate(() => { currentItemId = 'e1'; openEditModal(); });
    await page.waitForTimeout(250);
    const where = await page.evaluate(() => ({
      inside: document.getElementById('editModal').contains(document.activeElement),
      id: document.activeElement?.id || '',
    }));
    await page.evaluate(() => { closeEditModal(); });
    await page.waitForTimeout(200);
    assert.ok(where.inside, `the edit dialog took no focus; focus was on ${where.id || '<body>'}`);
  });

  await check('the person dialog takes focus too', async () => {
    await page.evaluate(() => { openPersonModal(null, 'Ravi'); });
    await page.waitForTimeout(250);
    const where = await page.evaluate(() => ({
      inside: document.getElementById('personModal').contains(document.activeElement),
      id: document.activeElement?.id || '',
    }));
    await page.evaluate(() => { closePersonModal(); });
    await page.waitForTimeout(200);
    assert.ok(where.inside, `the person dialog took no focus; focus was on ${where.id || '<body>'}`);
  });

  await check('the Ask overlay takes focus as well', async () => {
    // The fifth one, and the one the markup-driven check above caught after the first fix had already
    // declared four done. A list of remembered dialogs is a list that is wrong.
    await page.evaluate(() => openAsk());
    await page.waitForTimeout(250);
    const where = await page.evaluate(() => ({
      inside: document.getElementById('askOverlay').contains(document.activeElement),
id: document.activeElement?.id || '',
    }));
    await page.evaluate(() => { closeAsk(); });
    await page.waitForTimeout(200);
    assert.ok(where.inside, `the Ask overlay took no focus; focus was on ${where.id || '<body>'}`);
  });

  await check('two sheets stack, and only the background goes quiet', async () => {
    // Sheets open sheets. If inert marked everything except the top one, opening the second would
    // silence the first and leave the person with focus on something they can no longer reach.
    await page.evaluate(() => { openCapture(); });
    await page.waitForTimeout(250);
    await page.evaluate(() => { currentItemId = 'e1'; openEditModal(); });
    await page.waitForTimeout(300);
    const nested = await page.evaluate(() => ({
      captureInert: document.getElementById('captureModal').inert === true,
      appInert: document.querySelector('.app').inert === true,
      editInside: document.getElementById('editModal').contains(document.activeElement),
    }));
    assert.ok(nested.appInert, 'the app shell came back to life under the second dialog');
    assert.ok(nested.captureInert, 'the sheet underneath is still reachable behind the edit dialog');
    assert.ok(nested.editInside, 'focus is not in the topmost dialog');
    await page.evaluate(() => { closeEditModal(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { closeCapture(); });
    await page.waitForTimeout(250);
  });

  await check('a sheet closed by Escape leaves nothing behind', async () => {
    // The back handler closes layers without going through the close buttons, so it is a separate
    // path to the same freeze. Escape is also the first key a keyboard user reaches for.
    await page.evaluate(() => { openCapture(); });
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const left = await page.evaluate(() => ({
      open: document.querySelectorAll('.modal-overlay.open, .ask-overlay.open').length,
      appInert: document.querySelector('.app').inert === true,
    }));
    assert.equal(left.open, 0, 'Escape left a dialog open');
    assert.ok(!left.appInert, 'the app stayed inert after Escape closed the sheet');
  });
await check('the app is never left frozen, whichever way every dialog was closed', async () => {
    // The one that matters. The first attempt kept its own list of open layers, and any close path
    // that forgot to pop froze the whole app permanently — unclickable, no way back. This asserts the
    // freeze directly rather than trusting that every close path remembered to tidy up after itself.
    for (const id of ['captureModal', 'editModal', 'personModal', 'askOverlay', 'commandPalette']) {
      await page.evaluate((which) => {
        document.getElementById(which).classList.add('open');
        syncDialogBackground();
      }, id);
      await page.waitForTimeout(120);
      assert.ok(await page.evaluate(() => document.querySelector('.app').inert === true),
        `opening ${id} did not freeze the background`);
      // Closed the crude way: strip the class and nothing else. No close function runs, nothing is
      // told, nothing should need to tidy up — the observer reads the DOM and recovers by itself.
      await page.evaluate((which) => {
        document.getElementById(which).classList.remove('open');
      }, id);
      await page.waitForTimeout(220);
      assert.ok(await page.evaluate(() => document.querySelector('.app').inert === false),
        `the app stayed frozen after ${id} closed without telling anyone`);
    }
    const final = await page.evaluate(() => ({
      open: document.querySelectorAll('.modal-overlay.open, .ask-overlay.open').length,
      appInert: document.querySelector('.app').inert === true,
    }));
    assert.equal(final.open, 0, 'a dialog is still open after closing every one');
    assert.ok(!final.appInert, 'the app is frozen with nothing open');

    /* Not "focus is not on <body>". On a page nobody has clicked, body *is* the active element, so
       that would assert something untrue about every browser. The defect worth catching is "the app
       is frozen", and the honest way to show it is unfrozen is that the keyboard can walk back onto
       it: one Tab must reach a real control. `inert` would make that land on nothing. */
    await page.evaluate(() => { document.body.focus(); });
    await page.keyboard.press('Tab');
    const reachable = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName,
        isBody: el === document.body,
        inApp: !!el?.closest('.app'),
      };
    });
    assert.ok(!reachable.isBody && reachable.inApp,
      `after everything closed, Tab landed on ${reachable.tag} instead of a control in the app`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
/* Either the verdict or the banner, never both. run-all.mjs scores on /ALL (\d+) [A-Z -]*PASSED/, so
   printing that beside a FAIL records a broken suite as a green one — which is how the first version
   of this probe could have hidden the very freeze it was written to catch. */
console.log(process.exitCode
  ? '\nDIALOG-LAYER CHECKS FAILED'
  : `\nALL ${results.length} DIALOG-LAYER CHECKS PASSED`);
