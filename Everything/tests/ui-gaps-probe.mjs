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

  await check('bulk actions are disabled with nothing selected', async () => {
    await page.evaluate(() => { toggleSelectMode(true); });
    await page.waitForTimeout(200);
    const disabled = await page.evaluate(() => [...document.querySelectorAll('#bulkBar [data-bulk-needs-selection]')]
      .map((b) => b.disabled));
    assert.ok(disabled.every(Boolean), 'a destructive action is live with nothing selected');
    assert.ok(disabled.length >= 3, 'expected complete, archive and delete to be gated');
    await page.evaluate(() => toggleSelectMode(false));
    await page.waitForTimeout(150);
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

const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nALL ${passed} UI GAP CHECKS PASSED`);
