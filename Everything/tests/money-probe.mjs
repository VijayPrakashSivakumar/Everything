// Proves the Money module's Phase 1: an expense, its amount, its category, and the month total.
//
//   node Everything/tests/money-probe.mjs
//
// The whole module rests on one number, and every way it can be quietly wrong looks correct on
// screen. A float creeps in and a total is off by a paisa. A lakh reads as "12,04,50". A currency
// gets added to a total it does not belong in. An expense saves with no amount and the month
// under-counts forever. Those are the checks below.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4422;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => {
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
  });

  const run = (fn, arg) => page.evaluate(fn, arg);
  await page.evaluate(() => {
    window.exp = (over = {}) => ({ id: 'e1', kind: 'expense', title: 'Expense', done: false, created: 1, ...over });
    window.moneyItem = (minor, over = {}) => ({
      ...window.exp(over),
      captureMetadata: { amountMinor: minor, currency: 'INR', ...(over.captureMetadata || {}) },
    });
  });

  // ---------- The amount ----------
  await check('an amount is an exact integer of paise, never a float', async () => {
    const r = await run(() => [
      parseMoneyToMinor('450'),
      parseMoneyToMinor('450.50'),
      parseMoneyToMinor('₹1,200.50'),
      parseMoneyToMinor('1,20,000'),
    ]);
    assert.deepEqual(r, [45000, 45050, 120050, 12000000],
      `amounts came back as ${JSON.stringify(r)}`);
    // The reason for the whole design, shown rather than asserted on a constant: parseFloat is a
    // double, and doubles do not add up. Ten expenses of ₹450.50 are ₹4,505 exactly, as integers.
    assert.ok(0.1 + 0.2 !== 0.3, 'the float demonstration no longer holds — re-check this test');
    const exact = await run(() => {
      const items = Array.from({ length: 10 }, () => ({ captureMetadata: { amountMinor: 45050, currency: 'INR' } }));
      return sumMoney(items);
    });
    assert.equal(exact, 450500, `ten expenses of ₹450.50 totalled ${exact}`);
  });

  await check('paise that round up carry into the rupee', async () => {
    // 99.999 rounds to 100 paise. Stored as 100 paise instead of 1 rupee, every total containing it
    // is exactly one rupee short, and the error never shows up as an error.
    const r = await run(() => [parseMoneyToMinor('99.999'), formatMoney(parseMoneyToMinor('99.999'))]);
    assert.equal(r[0], 10000, `99.999 stored as ${r[0]} paise`);
    assert.equal(r[1], '₹100', `99.999 rendered as ${r[1]}`);
  });

  await check('a third decimal is rounded, not dropped', async () => {
    const r = await run(() => parseMoneyToMinor('450.505'));
    assert.equal(r, 45051, `450.505 stored as ${r} — a half paisa was lost`);
  });

  await check('rupees are grouped the Indian way', async () => {
    // A single-pass comma regex produces "12,04,50" here. This is the exact number that proves it.
    // The arguments are paise, so 100000 is a thousand rupees.
    const r = await run(() => [
      formatMoney(45000), formatMoney(12045000), formatMoney(12345678900), formatMoney(100000),
    ]);
    assert.deepEqual(r, ['₹450', '₹1,20,450', '₹12,34,56,789', '₹1,000'],
      `grouping came back as ${JSON.stringify(r)}`);
  });

  await check('a bare number is not money', async () => {
    // "paid 3 people" is three rupees to a reader and the wrong answer to a person.
    const r = await run(() => [
      parseAmountFromText('paid 3 people for the meal'),
      parseAmountFromText('spent ₹450 for groceries'),
      parseAmountFromText('Rs 1200.50 on dinner'),
      parseAmountFromText('450 rupees for rent'),
    ]);
    assert.equal(r[0], null, `"paid 3 people" was read as ${r[0]} paise`);
    assert.equal(r[1], 45000, `₹450 read as ${r[1]}`);
    assert.equal(r[2], 120050, `Rs 1200.50 read as ${r[2]}`);
    assert.equal(r[3], 45000, `"450 rupees" read as ${r[3]}`);
  });

  // ---------- Currency ----------
  await check('a total never adds two currencies together', async () => {
    const r = await run(() => {
      state.items = [
        { id: 'a', kind: 'expense', created: Date.now(), captureMetadata: { amountMinor: 45000, currency: 'INR' } },
        { id: 'b', kind: 'expense', created: Date.now(), captureMetadata: { amountMinor: 45000, currency: 'USD' } },
      ];
      return sumMoney(state.items);
    });
    assert.equal(r, 45000, `the total came to ${r} — a rupee and a dollar were added together`);
  });

  // ---------- Categories ----------
  await check('groceries and food are two different things', async () => {
    // Merging them is the single most common way a spending report becomes useless: it is the
    // difference between "we eat well" and "we spend too much on vegetables".
    const r = await run(() => [
      guessMoneyCategory('Spent ₹450 for groceries'),
      guessMoneyCategory('spent 400 on dinner'),
      guessMoneyCategory('grocery shopping at D-Mart'),
      moneyCategoryLabel('groceries'),
      moneyCategoryLabel('food'),
    ]);
    assert.equal(r[0], 'groceries', `"groceries" was filed as ${r[0]}`);
    assert.equal(r[1], 'food', `"dinner" was filed as ${r[1]}`);
    assert.equal(r[2], 'groceries', `"grocery shopping" was filed as ${r[2]} — Shopping won over Groceries`);
    assert.equal(r[3], 'Groceries', 'the groceries label is wrong');
    assert.equal(r[4], 'Food', 'the food label is wrong');
    assert.notEqual(r[3], r[4], 'groceries and food resolved to the same category');
  });

  // ---------- The capture path ----------
  await check('"Spent ₹450 for groceries" becomes an expense with that amount', async () => {
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      document.getElementById('captureText').value = 'Spent ₹450 for groceries';
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 900));
      await saveCapture(true);
      const item = state.items[0];
      if (!item) return { error: 'nothing was saved' };
      return {
        kind: item.kind,
        amount: moneyOf(item).amountMinor,
        category: moneyOf(item).category,
        dueDate: item.dueDate,
      };
    });
    assert.ok(!r.error, r.error);
    assert.equal(r.kind, 'expense', `it was saved as a ${r.kind}`);
    assert.equal(r.amount, 45000, `the amount saved as ${r.amount}`);
    assert.equal(r.category, 'groceries', `the category saved as ${r.category}`);
    // Money already spent has no due date, so it cannot nag as a task on the day it was typed.
    assert.equal(r.dueDate, '', 'the expense kept a due date and will nag as a task');
  });

  await check('an expense with no amount is refused, not saved at zero', async () => {
    // The failure nobody would notice: the row saves, the list shows a dash, and the month total
    // under-counts every single time. Refused at the door instead.
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      pickType('expense', true);
      document.getElementById('captureText').value = 'Spent some money on shopping';
      const saved = await saveCapture(true);
      return { saved: Boolean(saved), items: state.items.length, hint: document.getElementById('captureHint').textContent };
    });
    assert.equal(r.items, 0, 'an expense with no amount was saved anyway');
    assert.equal(r.saved, false, 'saveCapture reported success');
    assert.match(r.hint, /how much/i, `nothing told the person what was wrong: "${r.hint}"`);
  });

  await check('a typed amount overrides one read out of the sentence', async () => {
    // A correction is a decision, so the box wins over the sentence.
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      pickType('expense', true);
      document.getElementById('captureText').value = 'Spent ₹450 for groceries';
      document.getElementById('captureAmount').value = '475';
      await saveCapture(true);
      return state.items[0] ? moneyOf(state.items[0]).amountMinor : null;
    });
    assert.equal(r, 47500, `the typed amount was overridden and it saved as ${r}`);
  });

  await check('"pay the electricity bill on the 5th" is a reminder, not a spend', async () => {
    // The other direction, and the one that matters more: this is money that has NOT been spent.
    const r = await run(() => [textLooksLikeExpense('pay the electricity bill on the 5th'), parseAmountFromText('pay the electricity bill on the 5th')]);
    assert.equal(r[0], true, 'the wording was not recognised as money at all');
    assert.equal(r[1], null, 'a day number was read as a rupee amount');
  });
  // ---------- The view ----------
  await check('the month total is the sum of the amounts, exactly', async () => {
    const r = await run(() => {
      const today = isoDateString(new Date());
      state.items = [
        { id: 'a', kind: 'expense', title: 'Groceries', created: Date.now(), captureMetadata: { amountMinor: 45050, currency: 'INR', category: 'groceries', spentOn: today } },
        { id: 'b', kind: 'expense', title: 'Dinner', created: Date.now(), captureMetadata: { amountMinor: 120000, currency: 'INR', category: 'food', spentOn: today } },
        { id: 'c', kind: 'task', title: 'Not an expense', created: Date.now() },
      ];
      renderMoney();
      return {
        total: sumMoney(expensesThisMonth()),
        shown: (document.getElementById('moneyStats').textContent || '').replace(/\s+/g, ' '),
        cats: expensesByCategory().map((c) => c.id),
        rows: document.querySelectorAll('#moneyList .task-row').length,
      };
    });
    assert.equal(r.total, 165050, `the month total came to ${r.total}`);
    assert.match(r.shown, /₹1,650\.50/, `the screen showed "${r.shown}"`);
    assert.deepEqual(r.cats, ['food', 'groceries'], `categories came back as ${JSON.stringify(r.cats)}`);
    assert.equal(r.rows, 2, 'a task leaked into the expenses list');
  });

  await check('last month is not counted in this month', async () => {
    // A monthly report that quietly includes the 31st twice is worse than no report.
    const r = await run(() => {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const iso = isoDateString(lastMonth);
      state.items = [
        { id: 'old', kind: 'expense', title: 'Last month', created: Date.now(), captureMetadata: { amountMinor: 99900, currency: 'INR', spentOn: iso } },
      ];
      return { count: expensesThisMonth().length, total: sumMoney(expensesThisMonth()) };
    });
    assert.equal(r.count, 0, 'an expense from last month was counted in this month');
    assert.equal(r.total, 0, `last month contributed ${r.total} to this month's total`);
  });

  await check('an expense is kept out of the schedule and never reminds', async () => {
    const r = await run(() => {
      const item = window.exp({ dueDate: new Date().toISOString(), snoozedUntil: 0, notified: false });
      item.snoozedUntil = '';
      return {
        reminder: itemReminderTime(item),
        isExpense: isExpense(item),
        documentReminder: itemReminderTime(window.exp({ expiresOn: '' })),
      };
    });
    assert.equal(r.isExpense, true, 'the item is not recognised as an expense');
    assert.equal(r.reminder, null, 'an expense fired a reminder off its due date');
    assert.equal(r.documentReminder, null, 'an expense with no amount was treated as a document');
  });

  await check('the amount survives the row round trip', async () => {
    // capture_metadata is jsonb, so the number crosses a JSON boundary in both directions. A float
    // would come back as 45049.999999999993 here; an integer has to come back identical. The
    // snapshot is checked too, because it is what an export and the offline queue both carry.
    const r = await run(() => {
      // The row only carries capture_metadata when the column probe found it (migration 007). In the
      // app that probe runs at sign-in; here it has to be switched on by hand. If it is not, the
      // amount is dropped on the way to the server — the silent data loss this check makes visible.
      smartCaptureColumns.metadata = true;
      const item = rowToItem({
        id: 'e9', kind: 'expense', title: 'Groceries', created: 1,
        capture_metadata: { amountMinor: 45050, currency: 'INR', category: 'groceries', spentOn: '2026-03-04' },
      });
      const back = itemSnapshot(item);
      const row = itemToRow(item);
      return {
        amount: moneyOf(item).amountMinor,
        category: moneyOf(item).category,
        spentOn: moneyOf(item).spentOn,
        snapAmount: back.captureMetadata.amountMinor,
        rowAmount: normaliseCaptureMetadata(row.capture_metadata).amountMinor,
      };
    });
    assert.equal(r.amount, 45050, `the amount came back as ${r.amount}`);
    assert.equal(r.category, 'groceries', `the category came back as ${r.category}`);
    assert.equal(r.spentOn, '2026-03-04', `the date came back as ${r.spentOn}`);
    assert.equal(r.snapAmount, 45050, 'the backup snapshot lost or mangled the amount');
    assert.equal(r.rowAmount, 45050, 'the row written to the server lost or mangled the amount');
  });

  await check('a title with quotes cannot break an expense row', async () => {
    const r = await run(() => {
      state.items = [{ id: 'id"with\'quotes', kind: 'expense', title: 'Cafe "Blue" ₹', created: Date.now(), captureMetadata: { amountMinor: 45000, currency: 'INR' } }];
      renderMoney();
      const el = document.querySelector('#moneyList [onclick]');
      return el ? { onclick: el.getAttribute('onclick'), text: el.textContent } : { error: 'no row rendered' };
    });
    assert.ok(!r.error, r.error);
    assert.ok(r.onclick.includes('openPanel'), 'the row is not clickable');
    assert.ok(r.text.includes('Cafe'), `the title was mangled: "${r.text}"`);
  });
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
if (!failed) console.log(`\nALL ${results.length} MONEY CHECKS PASSED`);
else console.log(`\n${failed} of ${results.length} money checks FAILED`);
