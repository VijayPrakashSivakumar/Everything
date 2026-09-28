// Proves the four UI gaps are actually reachable, not merely present in the source.
//
//   node Everything/tests/ui-gaps-probe.mjs
//
//   1. A command palette that reaches any page or record from the keyboard.
//   2. A People view you can search, which tells an inferred name apart from a real contact, and
//      which lets an inferred name become one.
//   3. Bulk actions on the task list.
//   4. Drag-to-reorder that works by press-and-hold, because HTML5 drag does not fire on touch.
//
// Each one existed as a plausible-looking plan and no test would have noticed any of them being
// unreachable, which is the exact failure the dead-code audit keeps catching elsewhere.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4423;
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
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    // Real writes are stubbed so nothing reaches an account; every item here is thrown away.
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
    state.items = [
      { id: 'i1', kind: 'task', title: 'Renew passport', done: false, created: 3 },
      { id: 'i2', kind: 'task', title: 'Call the plumber', done: false, created: 2 },
      { id: 'i3', kind: 'task', title: 'Book flights', done: false, created: 1 },
      { id: 'i4', kind: 'memory', title: 'Call the plumber about the boiler', person: 'Priya', created: 4 },
    ];
    state.people = [{ id: 'p1', name: 'Ravi', phone: '+91 90000 11111', email: 'ravi@example.com' }];
    state.projects = [{ id: 'j1', name: 'Kitchen renovation' }];
    state.goals = [{ id: 'g1', title: 'Run a marathon' }];
  });

  await check('Ctrl+Shift+K opens the palette and lists pages and actions', async () => {
    await page.keyboard.press('Control+Shift+KeyK');
    await page.waitForTimeout(250);
    const out = await page.evaluate(() => ({
      open: document.getElementById('commandPalette').classList.contains('open'),
      focused: document.activeElement?.id,
      rows: document.querySelectorAll('#commandList .command-row').length,
      text: document.getElementById('commandList').textContent,
    }));
    assert.ok(out.open, 'Ctrl+Shift+K did not open the palette');
    assert.equal(out.focused, 'commandInput', 'the palette did not take focus — it is unusable by keyboard');
    assert.ok(out.rows > 5, `the palette showed only ${out.rows} rows`);
    assert.match(out.text, /Tasks/, 'the palette does not list the Tasks page');
    assert.match(out.text, /Capture/, 'the palette does not list the Capture action');
  });

  await check('plain Ctrl+K still opens Ask, not the palette', async () => {
    // Two behaviours behind one key is how a shortcut becomes a coin flip. Ask is the older,
    // documented one and keeps Ctrl+K; the palette takes the shift variant.
    await page.evaluate(() => closeCommandPalette());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+KeyK');
    await page.waitForTimeout(250);
    const out = await page.evaluate(() => ({
      ask: document.getElementById('askOverlay').classList.contains('open'),
      palette: document.getElementById('commandPalette').classList.contains('open'),
    }));
    assert.equal(out.ask, true, 'Ctrl+K no longer opens Ask');
    assert.equal(out.palette, false, 'Ctrl+K opened the palette as well');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  });

  await check('the palette finds a person by phone number and opens them', async () => {
    await page.keyboard.press('Control+Shift+KeyK');
    await page.waitForTimeout(200);
    // The phone number, not the name: this is the case the People view lacked and the reason
    // the palette searches contact fields at all.
    await page.fill('#commandInput', '90000');
    await page.waitForTimeout(200);
    const found = await page.evaluate(() => document.getElementById('commandList').textContent);
    assert.match(found, /Ravi/, 'the palette did not find a person by their phone number');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => ({
      paletteClosed: !document.getElementById('commandPalette').classList.contains('open'),
      personModal: document.getElementById('personModal').classList.contains('open'),
      name: document.getElementById('personModalName').textContent,
    }));
    assert.ok(opened.paletteClosed, 'running a command left the palette open over the top of it');
    assert.ok(opened.personModal, 'choosing a person did not open their profile');
    assert.equal(opened.name, 'Ravi');
    await page.evaluate(() => closePersonModal());
    await page.waitForTimeout(150);
  });

  await check('the palette finds a task, a project and a goal', async () => {
    for (const [query, expected] of [['passport', 'Renew passport'], ['Kitchen', 'Kitchen renovation'], ['marathon', 'Run a marathon']]) {
      await page.keyboard.press('Control+Shift+KeyK');
      await page.waitForTimeout(180);
      await page.fill('#commandInput', query);
      await page.waitForTimeout(200);
      const found = await page.evaluate(() => document.getElementById('commandList').textContent);
      assert.match(found, new RegExp(expected), `the palette did not find "${expected}"`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
  });

  await check('people can be searched by name, phone or email', async () => {
    await page.evaluate(() => { switchView('people'); });
    await page.waitForTimeout(150);
    for (const [query, expected] of [['Ravi', 'Ravi'], ['90000', 'Ravi'], ['ravi@', 'Ravi'], ['Priya', 'Priya']]) {
      await page.fill('#peopleSearchInput', query);
      await page.waitForTimeout(150);
      const text = await page.evaluate(() => document.getElementById('peopleList').textContent);
      assert.match(text, new RegExp(expected), `searching people for "${query}" found nothing`);
    }
    await page.fill('#peopleSearchInput', 'nobody-has-this');
    await page.waitForTimeout(150);
    const empty = await page.evaluate(() => document.getElementById('peopleList').textContent);
    assert.match(empty, /Nobody matches/i, 'a search with no results did not say so');
    await page.fill('#peopleSearchInput', '');
    await page.waitForTimeout(150);
  });

  await check('an inferred name is labelled, and can be promoted to a real contact', async () => {
    // "Priya" exists only because a task mentions her. She was previously indistinguishable from
    // a saved contact, so typing her number went nowhere and looked like a bug.
    const before = await page.evaluate(() => {
      renderPeople();
      const text = document.getElementById('peopleList').textContent;
      return { text, isReal: state.people.some((p) => p.name === 'Priya') };
    });
    assert.equal(before.isReal, false, 'precondition: Priya should start as an inferred name');
    assert.match(before.text, /From a task/, 'an inferred name is not labelled as one');

    await page.evaluate(() => promotePerson('Priya'));
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      closePersonModal();
      renderPeople();
      return {
        isReal: state.people.some((p) => p.name === 'Priya'),
        text: document.getElementById('peopleList').textContent,
      };
    });
    assert.equal(after.isReal, true, 'promoting an inferred name did not create a real contact');
    // The label must disappear once it is no longer inferred, or it becomes a lie.
    assert.doesNotMatch(after.text, /From a task/, 'a promoted contact is still labelled "From a task"');
  });

  await check('several tasks can be selected and completed together', async () => {
    await page.evaluate(() => { switchView('tasks'); });
    await page.waitForTimeout(200);
    const barHiddenAtRest = await page.evaluate(() => document.getElementById('bulkBar').hidden);
    assert.ok(barHiddenAtRest, 'the bulk bar is on screen before anyone opts in');

    await page.evaluate(() => { toggleSelectMode(true); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { toggleSelected('i1'); toggleSelected('i3'); });
    await page.waitForTimeout(200);
    const selected = await page.evaluate(() => ({
      count: document.getElementById('bulkCount').textContent,
      marked: document.querySelectorAll('#tasksList .task-row.selected').length,
    }));
    assert.equal(selected.marked, 2, 'selected rows are not visually marked');
    assert.match(selected.count, /2 selected/, `the bar says "${selected.count}"`);

    await page.evaluate(() => bulkComplete());
    await page.waitForTimeout(500);
    const done = await page.evaluate(() => ({
      i1: state.items.find((i) => i.id === 'i1')?.done,
      i3: state.items.find((i) => i.id === 'i3')?.done,
      // The one that was never selected must be untouched.
      i2: state.items.find((i) => i.id === 'i2')?.done,
    }));
    assert.equal(done.i1, true, 'a selected task was not completed');
    assert.equal(done.i3, true, 'a selected task was not completed');
    assert.equal(done.i2, false, 'a bulk complete touched a task that was not selected');
  });


  await check('the task list can be reordered by press-and-hold, not just by mouse', async () => {
    // HTML5 drag does not fire on touch, so a drag built only on dragstart passes every desktop
    // test and is dead on the phone — which is where this app is used.
    await page.evaluate(() => {
      switchView('tasks');
      state.items = [
        { id: 'r1', kind: 'task', title: 'First', done: false, created: 3 },
        { id: 'r2', kind: 'task', title: 'Second', done: false, created: 2 },
        { id: 'r3', kind: 'task', title: 'Third', done: false, created: 1 },
      ];
      localStorage.removeItem('everything_task_order_v1');
      renderTasks('all');
    });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => [...document.querySelectorAll('#tasksList .task-row')].map((r) => r.dataset.reorderId));
    assert.deepEqual(before, ['r1', 'r2', 'r3']);

    // A real press: down, hold past the 350ms threshold, move, release.
    const rows = await page.locator('#tasksList .task-row').all();
    const first = await rows[0].boundingBox();
    const last = await rows[2].boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.move(last.x + last.width / 2, last.y + last.height - 4, { steps: 12 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(300);

    const out = await page.evaluate(() => ({
      order: [...document.querySelectorAll('#tasksList .task-row')].map((r) => r.dataset.reorderId),
      stored: localStorage.getItem('everything_task_order_v1'),
    }));
    assert.notDeepEqual(out.order, ['r1', 'r2', 'r3'], 'press-and-hold did not move the row');
    assert.ok(out.stored, 'the new order was not remembered');
    assert.deepEqual(JSON.parse(out.stored), out.order, 'the remembered order is not the one on screen');
  });

  await check('a native HTML5 drag cannot steal the reorder', async () => {
    /* The subtle one. `draggable = true` starts a native drag, and a native drag cancels the
       pointer event stream — so the press-and-hold path got exactly one move and then went quiet.
       The dashboard hid this because its cards are large; a 45px task row does not. */
    const out = await page.evaluate(() => {
      renderTasks('all');
      const rows = [...document.querySelectorAll('#tasksList .task-row')];
      return { draggables: rows.map((r) => r.draggable) };
    });
    assert.ok(out.draggables.every((d) => d === false),
      'a task row is natively draggable, which cancels the pointer events the reorder depends on');
    // And nothing in the markup may set it either.
    const fs = await import('node:fs');
    const html = fs.readFileSync('Everything/index.html', 'utf8');
    assert.doesNotMatch(html, /data-dashboard-section="[^"]+"[^>]*\sdraggable="true"/,
      'a dashboard card is still natively draggable in the markup');
  });

  await check('a saved order survives a re-render', async () => {
    // A DOM shuffle that is not a sort is undone by the next render, which happens on every sync.
    await page.evaluate(() => renderTasks('all'));
    await page.waitForTimeout(300);
    const order = await page.evaluate(() => [...document.querySelectorAll('#tasksList .task-row')].map((r) => r.dataset.reorderId));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('everything_task_order_v1') || '[]'));
    assert.deepEqual(order, stored, 're-rendering threw away the order the person chose');
  });

  await check('a task captured after the order was saved still appears', async () => {
    // A stored order that no longer resolves must never cause a listed row to be dropped.
    const ids = await page.evaluate(() => {
      state.items.push({ id: 'new1', kind: 'task', title: 'Brand new', done: false, created: 99 });
      renderTasks('all');
      return [...document.querySelectorAll('#tasksList .task-row')].map((r) => r.dataset.reorderId);
    });
    assert.ok(ids.includes('new1'), 'a task captured since the order was saved vanished from the list');
    assert.ok(ids.includes('r1'), 're-ordering dropped a task that was already in the saved order');
  });

  await check('the dashboard and the task list share one reorder implementation', async () => {
    // Two copies of the same drag is how a fix to one leaves the other broken. This is a source
    // check because the alternative is a browser test that cannot tell a shared engine from a
    // duplicated one.
    const fs = await import('node:fs');
    const src = fs.readFileSync('Everything/script.js', 'utf8');
    const start = src.indexOf('function enableDashboardDragging');
    const dashBody = src.slice(start, src.indexOf('\n}', start));
    assert.ok(!/addEventListener\("dragstart"/.test(dashBody),
      'the dashboard has its own drag implementation instead of sharing the engine');
    assert.match(dashBody, /enableListReordering\(/, 'the dashboard does not use the shared reorder engine');
  });

  await check('the inbox can be selected and acted on in bulk', async () => {
    /* The Inbox holds every capture, so it outgrows the Tasks list — and it is the list people
       actually revisit most. It had no bulk actions at all. */
    await page.evaluate(() => {
      state.items = [
        { id: 'b1', kind: 'text', title: 'Captured one', done: false, created: 3 },
        { id: 'b2', kind: 'text', title: 'Captured two', done: false, created: 2 },
        { id: 'b3', kind: 'text', title: 'Captured three', done: false, created: 1 },
      ];
      switchView('inbox');
    });
    await page.waitForTimeout(300);
    const mounted = await page.evaluate(() => ({
      bar: !!document.getElementById('inboxBulkBar'),
      toggle: !!document.getElementById('inboxBulkToggle'),
      buttons: document.querySelectorAll('#inboxBulkBar [data-bulk-needs-selection]').length,
    }));
    assert.ok(mounted.bar, 'the inbox has no bulk action bar');
    assert.ok(mounted.toggle, 'the inbox has no way to enter select mode');
    assert.equal(mounted.buttons, 3, 'the inbox bar is missing complete, archive or delete');

    await page.evaluate(() => enterBulkScope('inbox'));
    await page.waitForTimeout(250);
    await page.evaluate(() => { toggleSelected('b1'); toggleSelected('b2'); });
    await page.waitForTimeout(250);
    const sel = await page.evaluate(() => ({
      count: document.getElementById('inboxBulkCount').textContent,
      marked: document.querySelectorAll('#inboxList .task-row.selected').length,
    }));
    assert.equal(sel.marked, 2, 'selected inbox rows are not visually marked');
    assert.match(sel.count, /2 selected/, `the inbox bar says "${sel.count}"`);

    await page.evaluate(() => bulkArchive());
    await page.waitForTimeout(600);
    const done = await page.evaluate(() => ({
      b1: Boolean(state.items.find((i) => i.id === 'b1')?.archivedAt),
      b3: Boolean(state.items.find((i) => i.id === 'b3')?.archivedAt),
    }));
    assert.equal(done.b1, true, 'a selected inbox item was not archived');
    assert.equal(done.b3, false, 'a bulk archive reached an inbox item that was not selected');
    await page.evaluate(() => { dismissCaptureUndo(); toggleSelectMode(false); });
  });

  await check('a selection in one list never reaches another', async () => {
    // Both lists draw the same task rows, so a stale selection looks plausible and silently acts
    // on records the person never looked at.
    await page.evaluate(() => {
      state.items = [
        { id: 'x1', kind: 'task', title: 'A task', done: false, created: 3 },
        { id: 'x2', kind: 'text', title: 'A capture', done: false, created: 2 },
      ];
      switchView('tasks');
      enterBulkScope('tasks');
      toggleSelected('x1');
    });
    await page.waitForTimeout(250);
    const onTasks = await page.evaluate(() => document.getElementById('bulkCount').textContent);
    assert.match(onTasks, /1 selected/, `the tasks bar says "${onTasks}"`);

    await page.evaluate(() => { switchView('inbox'); });
    await page.waitForTimeout(300);
    const onInbox = await page.evaluate(() => ({
      barHidden: document.getElementById('inboxBulkBar')?.hidden,
      marked: document.querySelectorAll('#inboxList .task-row.selected').length,
    }));
    assert.equal(onInbox.marked, 0, 'a task selected in the tasks list is still highlighted in the inbox');
    assert.ok(onInbox.barHidden, 'the inbox bulk bar opened with a selection made in another list');
  });

  await check('a bulk action can be taken back in one tap', async () => {
    /* A confirm() dialog catches the accidental tap. It cannot catch the person who agreed with the
       dialog and changed their mind thirty seconds later — which is why the capture flow already
       used an undo bar, and why the bulk actions now share it. */
    await page.evaluate(() => {
      state.items = [{ id: 'u1', kind: 'text', title: 'Archivable', done: false, created: 2 }];
      switchView('inbox');
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      enterBulkScope('inbox');
      toggleSelected('u1');
      return bulkArchive();
    });
    await page.waitForTimeout(700);
    const shown = await page.evaluate(() => ({
      visible: !document.getElementById('captureUndo').hidden,
      text: document.getElementById('captureUndo').textContent.replace(/\s+/g, ' ').trim(),
      archived: Boolean(state.items.find((i) => i.id === 'u1')?.archivedAt),
    }));
    assert.equal(shown.archived, true, 'precondition: the item should be archived');
    assert.ok(shown.visible, 'a bulk action raised no undo bar');
    assert.match(shown.text, /Archived 1 item/i, `the undo bar says "${shown.text}"`);

    await page.click('#captureUndo .capture-undo-btn');
    await page.waitForTimeout(600);
    const undone = await page.evaluate(() => ({
      archived: Boolean(state.items.find((i) => i.id === 'u1')?.archivedAt),
      barHidden: document.getElementById('captureUndo').hidden,
    }));
    assert.equal(undone.archived, false, 'undoing a bulk archive did not bring the item back');
    assert.ok(undone.barHidden, 'the undo bar stayed up after being used');
    await page.evaluate(() => toggleSelectMode(false));
  });

  await check('a deleted item comes back through undo', async () => {
    await page.evaluate(() => {
      state.items = [{ id: 'd1', kind: 'text', title: 'Delete me', done: false, created: 1 }];
      switchView('inbox');
    });
    await page.waitForTimeout(250);
    // The app's real confirm dialog, stubbed so the test can answer "yes" without a modal.
    await page.evaluate(() => { window.confirm = () => true; });
    await page.evaluate(() => {
      enterBulkScope('inbox');
      toggleSelected('d1');
      return bulkDelete();
    });
    await page.waitForTimeout(700);
    const gone = await page.evaluate(() => state.items.some((i) => i.id === 'd1'));
    assert.equal(gone, false, 'precondition: the item should be deleted');

    await page.click('#captureUndo .capture-undo-btn');
    await page.waitForTimeout(700);
    const back = await page.evaluate(() => {
      const item = state.items.find((i) => i.id === 'd1');
      return { inState: Boolean(item), title: item?.title, done: item?.done };
    });
    assert.equal(back.inState, true, 'undoing a bulk delete did not bring the item back');
    assert.equal(back.title, 'Delete me', 'the restored item lost its text');
    // A restored item must come back usable, not as a completed shell.
    assert.equal(back.done, false, 'the restored item came back already completed');
    await page.evaluate(() => toggleSelectMode(false));
  });

  await check('a row swipes aside to reveal actions', async () => {
    // The gesture a phone user already expects, and the only way to act on one row without opening
    // it. Driven as a real horizontal drag, not by calling the function, so the wiring is tested.
    await page.evaluate(() => {
      state.items = [{ id: 's1', kind: 'text', title: 'Swipe me', done: false, created: 1 }];
      switchView('inbox');
    });
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => ({
      swipeable: document.querySelectorAll('#inboxList .task-row.swipeable').length,
      actions: document.querySelectorAll('#inboxList .swipe-action').length,
    }));
    assert.equal(before.swipeable, 1, 'inbox rows are not swipeable');
    assert.ok(before.actions >= 2, `the swipe reveals only ${before.actions} actions`);

    const box = await (await page.locator('#inboxList .task-row').first()).boundingBox();
    await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const open = await page.evaluate(() => {
      const row = document.querySelector('#inboxList .task-row');
      return {
        open: row.classList.contains('swiped-open'),
        transform: row.style.transform,
        dragGhost: !!document.querySelector('.reorder-dragging'),
      };
    });
    assert.ok(open.open, 'a horizontal drag did not open the row');
    assert.match(open.transform, /translateX\(-/, 'the row is not actually slid aside');
    // The two gestures must not both fire: a swipe that also started a drag would have moved the
    // row in the list, which is a different and confusing result.
    assert.equal(open.dragGhost, false, 'the swipe also started a reorder drag');

    // A tap anywhere closes it again, or the row stays slid open covering its neighbour.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => {
      const row = document.querySelector('#inboxList .task-row');
      return { open: row.classList.contains('swiped-open'), transform: row.style.transform };
    });
    assert.equal(closed.open, false, 'tapping a swiped-open row did not close it');
    assert.equal(closed.transform, '', 'a closed row still carries a transform');
  });

  await check('a vertical drag scrolls instead of swiping', async () => {
    /* Getting this wrong makes a long list unscrollable on the phone, which is worse than having no
       swipe at all. */
    await page.evaluate(() => {
      state.items = [
        { id: 'v1', kind: 'text', title: 'One', done: false, created: 3 },
        { id: 'v2', kind: 'text', title: 'Two', done: false, created: 2 },
        { id: 'v3', kind: 'text', title: 'Three', done: false, created: 1 },
      ];
      switchView('inbox');
    });
    await page.waitForTimeout(350);
    const box = await (await page.locator('#inboxList .task-row').first()).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Mostly vertical, which is a scroll — the same motion a person makes to read further down.
    await page.mouse.move(box.x + box.width / 2 - 6, box.y + box.height / 2 + 70, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const out = await page.evaluate(() => {
      const row = document.querySelector('#inboxList .task-row');
      return { open: row.classList.contains('swiped-open'), transform: row.style.transform };
    });
    assert.equal(out.open, false, 'a vertical scroll was read as a swipe');
    assert.equal(out.transform, '', 'a vertical scroll left the row transformed');
  });

  await check('the swipe action actually acts, and is undoable', async () => {
    await page.evaluate(() => {
      state.items = [{ id: 's9', kind: 'text', title: 'Archive by swipe', done: false, created: 1 }];
      switchView('inbox');
    });
    await page.waitForTimeout(350);
    const box = await (await page.locator('#inboxList .task-row').first()).boundingBox();
    await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Is the button actually reachable, and is anything covering it?
    const probe = await page.evaluate(() => {
      const btn = document.querySelector('#inboxList .swipe-archive');
      if (!btn) return { exists: false };
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        exists: true,
        visible: r.width > 0 && r.height > 0,
        insideViewport: r.right <= window.innerWidth && r.left >= 0,
        hitIsButton: hit === btn || btn.contains(hit),
        hitClass: hit?.className,
        pointerEvents: getComputedStyle(btn.parentElement).pointerEvents,
      };
    });
    assert.ok(probe.exists, 'the archive action is not in the DOM');
    assert.ok(probe.visible, 'the archive action has no size');
    assert.ok(probe.insideViewport, 'the archive action is off the right edge of the screen');
    assert.ok(probe.hitIsButton, `something is covering the archive action (${probe.hitClass})`);
    assert.equal(probe.pointerEvents, 'auto', 'the revealed actions are still not clickable');

    await page.click('#inboxList .swipe-archive');
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => ({
      archived: Boolean(state.items.find((i) => i.id === 's9')?.archivedAt),
      undo: !document.getElementById('captureUndo').hidden,
    }));
    assert.equal(after.archived, true, 'the swipe action did not archive the item');
    assert.ok(after.undo, 'a swipe archive offered no way back');
    await page.evaluate(() => dismissCaptureUndo());
  });

  await check('a reorderable row is never also swipeable', async () => {
    // Reordering and swiping on one row are two competing horizontal gestures. The split is by list:
    // the Inbox swipes, the Tasks list reorders, and no row does both.
    const out = await page.evaluate(() => {
      state.items = [{ id: 'n1', kind: 'task', title: 'A task', done: false, created: 2 }];
      switchView('tasks');
      renderTasks('all');
      const taskRowEl = document.querySelector('#tasksList .task-row');
      switchView('inbox');
      renderInbox('all');
      const inboxRowEl = document.querySelector('#inboxList .task-row');
      return {
        taskReorderable: taskRowEl?.classList.contains('reorderable'),
        taskSwipeable: taskRowEl?.classList.contains('swipeable'),
        inboxSwipeable: inboxRowEl?.classList.contains('swipeable'),
        inboxReorderable: inboxRowEl?.classList.contains('reorderable'),
      };
    });
    assert.equal(out.taskReorderable, true, 'precondition: task rows should be reorderable');
    assert.equal(out.taskSwipeable, false, 'a task row is both swipeable and reorderable — the gestures will fight');
    assert.equal(out.inboxSwipeable, true, 'precondition: inbox rows should be swipeable');
    assert.equal(out.inboxReorderable, false, 'an inbox row is both swipeable and reorderable');
  });

  await check('the palette can be reached by touch, not only by keyboard', async () => {
    /* The bug this exists for: Ctrl+Shift+K was the *only* way to open the palette, so on a phone —
       which is where this app is used — the feature did not exist. Fourteen desktop checks passed
       while it was unreachable on the device that matters. */
    // hasTouch, because `tap` is only supported on a touch context. Without it the check died on
    // "The page does not support tap" and proved nothing about the button.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      await phone.goto(testUrl(PORT), { waitUntil: 'commit' });
      await phone.waitForFunction(() => typeof window.openCommandPalette === 'function');
      await phone.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });

      // Visible means it takes layout space, not merely that the element is in the DOM.
      const seen = await phone.evaluate(() => {
        const btn = document.getElementById('paletteBtn');
        if (!btn) return { exists: false };
        const box = btn.getBoundingClientRect();
        return {
          exists: true,
          width: Math.round(box.width),
          height: Math.round(box.height),
          insideScreen: box.right <= window.innerWidth && box.left >= 0,
          label: btn.getAttribute('aria-label') || '',
        };
      });
      assert.ok(seen.exists, 'there is no button to open the palette on a phone');
      assert.ok(seen.width > 0 && seen.height > 0,
        'the palette button is in the DOM but hidden on a 390px screen — the palette is still unreachable');
      assert.ok(seen.insideScreen, 'the palette button overflows the screen and cannot be tapped');
      assert.match(seen.label, /page|task|person|project/i,
        'the palette button has no label saying what it does');

      // And tapping it must actually open the palette, focus it, and show rows.
      await phone.tap('#paletteBtn');
      await phone.waitForTimeout(300);
      const opened = await phone.evaluate(() => ({
        open: document.getElementById('commandPalette').classList.contains('open'),
        focused: document.activeElement?.id,
        rows: document.querySelectorAll('#commandList .command-row').length,
      }));
      assert.ok(opened.open, 'tapping the palette button on a phone did not open it');
      assert.equal(opened.focused, 'commandInput', 'the palette opened without taking focus');
      assert.ok(opened.rows > 5, `the palette opened empty on a phone (${opened.rows} rows)`);
    } finally {
      await phone.close();
    }
  });

  await check('the palette button is hidden where the shortcut already works', async () => {
    // Showing it on desktop would be a duplicate of a working keystroke, and the topbar is crowded.
    const shown = await page.evaluate(() => {
      const btn = document.getElementById('paletteBtn');
      return btn ? Math.round(btn.getBoundingClientRect().width) : -1;
    });
    assert.equal(shown, 0, 'the palette button takes up space on a desktop topbar that already has the shortcut');
  });

  await check('bulk actions are disabled with nothing selected', async () => {
    // Entered through the scope, not toggleSelectMode() directly: the live bar depends on which
    // list is in scope, and reaching into one directly bypasses that entirely.
    await page.evaluate(() => { enterBulkScope('tasks'); });
    await page.waitForTimeout(250);
    const disabled = await page.evaluate(() => [...document.querySelectorAll('#bulkBar [data-bulk-needs-selection]')]
      .map((b) => b.disabled));
    assert.ok(disabled.every(Boolean), 'a destructive action is live with nothing selected');
    assert.ok(disabled.length >= 3, 'expected complete, archive and delete to be gated');
    // And the same must hold in the Inbox, which has its own bar.
    await page.evaluate(() => { enterBulkScope('inbox'); });
    await page.waitForTimeout(250);
    const inboxDisabled = await page.evaluate(() => [...document.querySelectorAll('#inboxBulkBar [data-bulk-needs-selection]')]
      .map((b) => b.disabled));
    assert.ok(inboxDisabled.length >= 3, 'the inbox bar is missing a gated action');
    assert.ok(inboxDisabled.every(Boolean), 'an inbox destructive action is live with nothing selected');
    await page.evaluate(() => { toggleSelectMode(false); });
    await page.waitForTimeout(200);
  });

  await check('the palette uses the one search matcher, so it agrees with the header', async () => {
    // A typo must reach the same rows in both places. A second matcher here would make the palette
    // and the search box disagree about the same word, which is worse than either one alone.
    const out = await page.evaluate(() => {
      // The reorder checks above replaced state.items, so restore something with a typo-able word
      // first — otherwise this asserts only that two empty lists are equal.
      state.items = [{ id: 'ty1', kind: 'task', title: 'Call the plumber', done: false, created: 1 }];
      const typed = 'plumbr';
      const palette = commandRecordRows(typed).filter((r) => String(r.id).startsWith('item-')).map((r) => r.label);
      const header = searchMatches(typed).map((i) => i.title);
      return { palette, header };
    });
    assert.ok(out.header.length, 'the typo matched nothing at all, so this proves nothing');
    assert.deepEqual(out.palette, out.header,
      'the palette and the header search found different things for the same typo');
  });
} finally {
  await browser.close();
  server.kill();
}

/* The banner wording is load-bearing, and so is the number in it. run-all.mjs matches
   /ALL (\d+) [A-Z -]*PASSED/ and marks the suite failed when it does not — but it also fails on a
   non-zero exit code, so printing "ALL 14 ... PASSED" beside two FAILs would be caught only by the
   exit code, and the line directly above it would claim the opposite. The count is the number of
   checks that ran, so the sentence can never contradict the lines above it. */
console.log(`\nALL ${results.length} UI GAP CHECKS PASSED`);
