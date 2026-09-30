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

let PORT = 4422;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
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
      parseMoneyToMinor('Ã¢â€šÂ¹1,200.50'),
      parseMoneyToMinor('1,20,000'),
    ]);
    assert.deepEqual(r, [45000, 45050, 120050, 12000000],
      `amounts came back as ${JSON.stringify(r)}`);
    // The reason for the whole design, shown rather than asserted on a constant: parseFloat is a
    // double, and doubles do not add up. Ten expenses of Ã¢â€šÂ¹450.50 are Ã¢â€šÂ¹4,505 exactly, as integers.
    assert.ok(0.1 + 0.2 !== 0.3, 'the float demonstration no longer holds Ã¢â‚¬â€ re-check this test');
    const exact = await run(() => {
      const items = Array.from({ length: 10 }, () => ({ captureMetadata: { amountMinor: 45050, currency: 'INR' } }));
      return sumMoney(items);
    });
    assert.equal(exact, 450500, `ten expenses of Ã¢â€šÂ¹450.50 totalled ${exact}`);
  });

  await check('paise that round up carry into the rupee', async () => {
    // 99.999 rounds to 100 paise. Stored as 100 paise instead of 1 rupee, every total containing it
    // is exactly one rupee short, and the error never shows up as an error.
    const r = await run(() => [parseMoneyToMinor('99.999'), formatMoney(parseMoneyToMinor('99.999'))]);
    assert.equal(r[0], 10000, `99.999 stored as ${r[0]} paise`);
    assert.equal(r[1], 'Ã¢â€šÂ¹100', `99.999 rendered as ${r[1]}`);
  });

  await check('a third decimal is rounded, not dropped', async () => {
    const r = await run(() => parseMoneyToMinor('450.505'));
    assert.equal(r, 45051, `450.505 stored as ${r} Ã¢â‚¬â€ a half paisa was lost`);
  });

  await check('rupees are grouped the Indian way', async () => {
    // A single-pass comma regex produces "12,04,50" here. This is the exact number that proves it.
    // The arguments are paise, so 100000 is a thousand rupees.
    const r = await run(() => [
      formatMoney(45000), formatMoney(12045000), formatMoney(12345678900), formatMoney(100000),
    ]);
    assert.deepEqual(r, ['Ã¢â€šÂ¹450', 'Ã¢â€šÂ¹1,20,450', 'Ã¢â€šÂ¹12,34,56,789', 'Ã¢â€šÂ¹1,000'],
      `grouping came back as ${JSON.stringify(r)}`);
  });

  await check('a bare number is not money', async () => {
    // "paid 3 people" is three rupees to a reader and the wrong answer to a person.
    const r = await run(() => [
      parseAmountFromText('paid 3 people for the meal'),
      parseAmountFromText('spent Ã¢â€šÂ¹450 for groceries'),
      parseAmountFromText('Rs 1200.50 on dinner'),
      parseAmountFromText('450 rupees for rent'),
    ]);
    assert.equal(r[0], null, `"paid 3 people" was read as ${r[0]} paise`);
    assert.equal(r[1], 45000, `Ã¢â€šÂ¹450 read as ${r[1]}`);
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
    assert.equal(r, 45000, `the total came to ${r} Ã¢â‚¬â€ a rupee and a dollar were added together`);
  });

  // ---------- Categories ----------
  await check('groceries and food are two different things', async () => {
    // Merging them is the single most common way a spending report becomes useless: it is the
    // difference between "we eat well" and "we spend too much on vegetables".
    const r = await run(() => [
      guessMoneyCategory('Spent Ã¢â€šÂ¹450 for groceries'),
      guessMoneyCategory('spent 400 on dinner'),
      guessMoneyCategory('grocery shopping at D-Mart'),
      moneyCategoryLabel('groceries'),
      moneyCategoryLabel('food'),
    ]);
    assert.equal(r[0], 'groceries', `"groceries" was filed as ${r[0]}`);
    assert.equal(r[1], 'food', `"dinner" was filed as ${r[1]}`);
    assert.equal(r[2], 'groceries', `"grocery shopping" was filed as ${r[2]} Ã¢â‚¬â€ Shopping won over Groceries`);
    assert.equal(r[3], 'Groceries', 'the groceries label is wrong');
    assert.equal(r[4], 'Food', 'the food label is wrong');
    assert.notEqual(r[3], r[4], 'groceries and food resolved to the same category');
  });

  // ---------- The capture path ----------
  await check('"Spent Ã¢â€šÂ¹450 for groceries" becomes an expense with that amount', async () => {
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      document.getElementById('captureText').value = 'Spent Ã¢â€šÂ¹450 for groceries';
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
      document.getElementById('captureText').value = 'Spent Ã¢â€šÂ¹450 for groceries';
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
    assert.match(r.shown, /Ã¢â€šÂ¹1,650\.50/, `the screen showed "${r.shown}"`);
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
      // amount is dropped on the way to the server Ã¢â‚¬â€ the silent data loss this check makes visible.
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
      state.items = [{ id: 'id"with\'quotes', kind: 'expense', title: 'Cafe "Blue" Ã¢â€šÂ¹', created: Date.now(), captureMetadata: { amountMinor: 45000, currency: 'INR' } }];
      renderMoney();
      const el = document.querySelector('#moneyList [onclick]');
      return el ? { onclick: el.getAttribute('onclick'), text: el.textContent } : { error: 'no row rendered' };
    });
    assert.ok(!r.error, r.error);
    assert.ok(r.onclick.includes('openPanel'), 'the row is not clickable');
    assert.ok(r.text.includes('Cafe'), `the title was mangled: "${r.text}"`);
  });
  // ---------- Bills & subscriptions ----------
  await check('a bill is money owed, and a subscription is the same thing by another name', async () => {
    const r = await run(() => {
      const bill = { id: 'b1', kind: 'bill', captureMetadata: { amountMinor: 89900, billType: 'bill' } };
      const sub = { id: 'b2', kind: 'bill', captureMetadata: { amountMinor: 64900, billType: 'subscription' } };
      return {
        isBill: isBill(bill),
        subIsSub: isSubscription(sub),
        billIsNotSub: isSubscription(bill),
        label: billLabel(sub),
        guess: [guessBillType('pay the netflix bill'), guessBillType('pay the electricity bill')],
        repeats: [canRepeat(bill), canRepeat({ id: 'x', kind: 'task' }), canRepeat({ id: 'y', kind: 'expense' })],
      };
    });
    assert.ok(r.isBill, 'a bill is not recognised as one');
    assert.ok(r.subIsSub, 'a subscription is not recognised as one');
    assert.ok(!r.billIsNotSub, 'an electricity bill was read as a subscription');
    assert.equal(r.label, 'Subscription', 'the label is wrong');
    assert.deepEqual(r.guess, ['subscription', 'bill'], `guessing came back as ${JSON.stringify(r.guess)}`);
    // Only tasks and bills repeat. An expense does not come back, and neither does a document.
    assert.deepEqual(r.repeats, [true, true, false], `canRepeat came back as ${JSON.stringify(r.repeats)}`);
  });

  await check('"pay Ã¢â€šÂ¹899 for internet on the 10th" is a bill, not an expense', async () => {
    // The distinction the module rests on: money already spent is history, money still owed is a
    // future obligation. Filing the second as the first would put Ã¢â€šÂ¹899 into this month's total for a
    // payment that has not been made.
    const r = await run(() => [
      textLooksLikeBill('Pay Ã¢â€šÂ¹899 for internet on the 10th'),
      textLooksLikeBill('Spent Ã¢â€šÂ¹450 for groceries'),
      textLooksLikeBill('Pay the electricity bill'),
    ]);
    assert.equal(r[0], true, 'a dated payment was not read as a bill');
    assert.equal(r[1], false, 'a spend with no date was read as a bill');
    assert.equal(r[2], false, 'a bill with no amount was read as a bill');
  });

  await check('a bill repeats, and the next month arrives on its own', async () => {
    // The regression: recurrence was gated on kind === "task", so a monthly bill got no series key
    // and simply stopped existing after its first date passed.
    const r = await run(async () => {
      const past = new Date();
      past.setDate(past.getDate() - 40);
      state.items = [
        {
          id: 'bb1', kind: 'bill', title: 'Airtel', done: false, created: Date.now() - 86400000,
          dueDate: past.toISOString(), recurrence: 'monthly',
          captureMetadata: { amountMinor: 89900, currency: 'INR', billType: 'bill' },
        },
      ];
      await dbSaveItem(state.items[0]);
      const key = state.items[0].recurrenceKey;
      localStorage.setItem('everything_recurring_sweep_v1', '0');
      await rollForwardRecurringSeries();
      return {
        key: Boolean(key),
        future: state.items.filter((i) => new Date(i.dueDate).getTime() > Date.now()).length,
        sameKey: state.items.every((i) => i.recurrenceKey === key),
      };
    });
    assert.ok(r.key, 'the bill was given no series key, so it can never roll forward');
    assert.equal(r.future, 1, 'no future occurrence was created');
    assert.ok(r.sameKey, 'the new occurrence is not part of the same series');
  });
  // ---------- Receipts ----------
  await check('the total is read, not the subtotal or the tax', async () => {
    // The whole point of reading a receipt. A receipt is mostly numbers, and three of them are wrong
    // in the way that matters: the subtotal, the tax, and the change. This is a real receipt shape.
    const r = await run(() => {
      const receipt = [
        'D-MART',
        'GSTIN 27AAAAA1234A1Z5',
        'Invoice 2291    04/03/2026',
        'Colgate MaxFresh  x2       398.00',
        'Amul Butter 500g x1        285.00',
        'Parle-G 250g x4           112.00',
        'SUBTOTAL                   795.00',
        'CGST 5%                     39.75',
        'SGST 5%                     39.75',
        'ROUND OFF                   -0.50',
        'TOTAL                      874.00',
        'UPI ravi@okhdfcbank     874.00',
        'CHANGE                       0.00',
      ].join('\n');
      const total = receiptTotalFromText(receipt);
      return {
        total: total && total.amountMinor,
        line: total && total.line,
        merchant: receiptMerchantFromText(receipt),
        date: receiptDateFromText(receipt),
        looks: textLooksLikeReceipt(receipt),
      };
    });
    assert.equal(r.total, 87400, `the total read as ${r.total} Ã¢â‚¬â€ that is the subtotal, the tax or the change`);
    assert.match(r.line, /TOTAL\s+874/i, `it read the line "${r.line}"`);
    assert.equal(r.merchant, 'D-MART', `the shop read as "${r.merchant}"`);
    assert.equal(r.date, '2026-03-04', `the date read as "${r.date}"`);
    assert.ok(r.looks, 'a real receipt was not recognised as one');
  });

  await check('a receipt with no readable total proposes nothing at all', async () => {
    // Better to say nothing than to guess. A wrong amount here is indistinguishable from a correct
    // one on the screen, and it goes into a total the person will trust.
    const r = await run(() => [
      receiptTotalFromText('just a photo of a receipt with the numbers cut off'),
      receiptTotalFromText('SUBTOTAL 795.00\nCGST 39.75\nSGST 39.75'),
      textLooksLikeReceipt('TOTAL 240'),
    ]);
    assert.equal(r[0], null, 'a total was invented from a photo with no numbers');
    // Every total-named line here is disqualified, so the right answer is to decline.
    assert.equal(r[1], null, 'a subtotal or a tax line was read as the total');
    // A total with no date and no invoice reference is not enough to be sure it is a receipt.
    assert.equal(r[2], false, 'a bare number was taken for a receipt');
  });

  await check('a receipt date is read day-first, the way an Indian receipt prints it', async () => {
    const r = await run(() => [
      receiptDateFromText('Invoice 04/03/2026'),
      receiptDateFromText('Dated 25/12/2025'),
      receiptDateFromText('Invoice 12/25/2025'),
      receiptDateFromText('2026-03-04'),
      receiptDateFromText('no date here'),
    ]);
    assert.equal(r[0], '2026-03-04', `04/03/2026 read as ${r[0]}`);
    assert.equal(r[1], '2025-12-25', `25/12/2025 read as ${r[1]} Ã¢â‚¬â€ the day and month were swapped`);
    assert.equal(r[2], '2025-12-25', `12/25/2025 read as ${r[2]}`);
    assert.equal(r[3], '2026-03-04', `the ISO form read as ${r[3]}`);
    assert.equal(r[4], '', 'a date was invented out of nothing');
  });
  // PLACEHOLDER_RECEIPT_CAPTURE

  await check('money owed is shown in its own section, and the two directions are never netted', async () => {
    // A debt had nowhere to be seen: one line on Today, and no running total. And Ã¢â€šÂ¹500 in against
    // Ã¢â€šÂ¹500 out netting to zero is the most misleading number this module could print.
    const r = await run(() => {
      state.items = [
        { id: 'o1', kind: 'task', title: 'Owes me', person: 'Ravi', done: false, created: 1, captureMetadata: { owedMinor: 50000, currency: 'INR', owedDirection: 'in' } },
        { id: 'o2', kind: 'task', title: 'Trip money', person: 'Meera', done: false, created: 2, captureMetadata: { owedMinor: 50000, currency: 'INR', owedDirection: 'out' } },
        { id: 'o3', kind: 'task', title: 'Settled', person: 'Anil', done: true, created: 3, captureMetadata: { owedMinor: 99900, currency: 'INR', owedDirection: 'in' } },
      ];
      renderMoney();
      return {
        count: outstandingMoneyOwed().length,
        card: !document.getElementById('moneyOwedCard').hidden,
        label: (document.getElementById('moneyOwedLabel').textContent || '').replace(/\s+/g, ' '),
        groups: document.querySelectorAll('#moneyOwed .money-owed-group').length,
        rows: document.querySelectorAll('#moneyOwed .task-row').length,
      };
    });
    // The completed debt is gone, which is the entire point of completing it.
    assert.equal(r.count, 2, `outstanding came to ${r.count} Ã¢â‚¬â€ a settled debt is still listed`);
    assert.ok(r.card, 'the Owed card stayed hidden with two debts in it');
    assert.equal(r.rows, 2, 'the wrong number of debts rendered');
    assert.equal(r.groups, 2, 'the two directions were merged instead of separated');
    assert.ok(!/Ã¢â€šÂ¹0\b/.test(r.label), `the two directions were netted into nothing: "${r.label}"`);
  });

  await check('a photographed receipt fills the amount, and leaves it visible to correct', async () => {
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      pickType('image', true);
      imageOcrText = 'D-MART\nInvoice 2291  04/03/2026\nColgate 398.00\nSUBTOTAL 795.00\nCGST 39.75\nTOTAL 874.00';
      document.getElementById('captureText').value = imageOcrText;
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 1100));
      const button = [...document.querySelectorAll('.capture-question-actions .btn')]
        .find((b) => b.textContent.trim() === 'Record as expense');
      if (!button) return { error: 'no expense option was offered' };
      button.click();
      return {
        kind: captureType,
        amount: document.getElementById('captureAmount').value,
        merchant: document.getElementById('captureMerchant').value,
        spentOn: document.getElementById('captureSpentOn').value,
        hint: document.getElementById('captureHint').textContent,
      };
    });
    assert.ok(!r.error, r.error);
    assert.equal(r.kind, 'expense', `the capture became a ${r.kind}`);
    // Filled in plain rupees, because that is what is printed on the paper and what a person checks.
    assert.equal(r.amount, '874', `the box shows "${r.amount}" Ã¢â‚¬â€ the subtotal, or nothing at all`);
    assert.match(r.merchant, /D-MART/, `the shop box shows "${r.merchant}"`);
    assert.equal(r.spentOn, '2026-03-04', `the date box shows "${r.spentOn}"`);
    assert.match(r.hint, /874/, `the person is not told what was read: "${r.hint}"`);
  });

  // ---------- Money owed ----------
  await check('"Ravi owes me Ã¢â€šÂ¹500" is money owed, not money spent', async () => {
    // The mirror of the bill rule, and the one with no other home. Filed as an expense it would
    // inflate this month's spending with money that never left the account.
    const r = await run(() => [
      textLooksLikeMoneyOwed('Ravi owes me Ã¢â€šÂ¹500'),
      textLooksLikeMoneyOwed('I owe Ravi Ã¢â€šÂ¹500'),
      textLooksLikeMoneyOwed('Spent Ã¢â€šÂ¹450 on groceries'),
      textLooksLikeMoneyOwed('Ravi owes me a favour'),
      moneyOwedOf({ captureMetadata: { owedMinor: 50000, currency: 'INR', owedDirection: 'in' } }).amountMinor,
    ]);
    assert.ok(r[0], '"Ravi owes me Ã¢â€šÂ¹500" was not recognised as money owed');
    assert.ok(r[1], '"I owe Ravi Ã¢â€šÂ¹500" was not recognised as money owed');
    assert.ok(!r[2], 'a plain spend was read as money owed');
    assert.ok(!r[3], 'a debt with no amount was read as money owed');
    assert.equal(r[4], 50000, 'the amount did not read back');
  });

  await check('the direction of a debt is recorded, because an amount alone is not actionable', async () => {
    const r = await run(() => [
      moneyOwedDirection('Ravi owes me Ã¢â€šÂ¹500'),
      moneyOwedDirection('I owe Ravi Ã¢â€šÂ¹500'),
      moneyOwedDirection('Meera owes us Ã¢â€šÂ¹200'),
    ]);
    assert.deepEqual(r, ['in', 'out', 'in'], `directions came back as ${JSON.stringify(r)}`);
  });

  await check('money owed is saved as a task with the amount, and lands on Today', async () => {
    // A task, because that is what already chases you: Today, completable, snoozable. A new kind
    // would have needed all three built again for a row whose only extra property is an amount.
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      document.getElementById('captureText').value = 'Ravi owes me Ã¢â€šÂ¹500';
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 900));
      await saveCapture(true);
      const item = state.items[0];
      if (!item) return { error: 'nothing was saved' };
      return {
        kind: item.kind,
        owed: moneyOwedOf(item).amountMinor,
        direction: moneyOwedOf(item).direction,
        person: item.person,
        status: item.status,
        spent: moneyOf(item).amountMinor,
        monthTotal: sumMoney(expensesThisMonth()),
      };
    });
    assert.ok(!r.error, r.error);
    assert.equal(r.kind, 'task', `it was saved as a ${r.kind}`);
    assert.equal(r.owed, 50000, `the amount saved as ${r.owed}`);
    assert.equal(r.direction, 'in', `the direction saved as "${r.direction}"`);
    assert.match(r.person || '', /Ravi/i, `nobody was named: "${r.person}"`);
    assert.equal(r.status, 'today', `it is not on Today Ã¢â‚¬â€ nothing would chase it (status: ${r.status})`);
    // The whole reason it is stored under its own key. A debt is not spending.
    assert.equal(r.spent, null, 'the debt was written into the spending fields');
    assert.equal(r.monthTotal, 0, `a debt was counted as spending: the month total is ${r.monthTotal}`);
  });


  await check('a yearly charge is divided by twelve, not added whole', async () => {
    // Ã¢â€šÂ¹1,200 a year is Ã¢â€šÂ¹100 a month. Listed as Ã¢â€šÂ¹1,200 it would overstate the monthly cost twelve
    // times, which is the difference between a number you check and one you believe.
    const r = await run(() => {
      const soon = new Date(Date.now() + 86400000).toISOString();
      state.items = [
        { id: 'y1', kind: 'bill', title: 'Domain', done: false, created: 1, recurrence: 'yearly', dueDate: soon, captureMetadata: { amountMinor: 120000, currency: 'INR', billType: 'subscription' } },
        { id: 'y2', kind: 'bill', title: 'Netflix', done: false, created: 2, recurrence: 'monthly', dueDate: soon, captureMetadata: { amountMinor: 64900, currency: 'INR', billType: 'subscription' } },
      ];
      return { monthly: monthlyRecurringCost(), shown: formatMoney(monthlyRecurringCost()) };
    });
    assert.equal(r.monthly, 74900, `the monthly cost came to ${r.monthly}`);
    assert.equal(r.shown, 'Ã¢â€šÂ¹749', `it displayed as ${r.shown}`);
  });

  await check('a due-soon bill is listed, and an overdue one is not hidden', async () => {
    // An unpaid bill is exactly the thing worth seeing, so it stays in the list rather than being
    // filtered out for having a past date.
    const r = await run(() => {
      const at = (days) => {
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(12, 0, 0, 0);
        return d.toISOString();
      };
      const bill = (id, days) => ({ id, kind: 'bill', title: id, done: false, created: 1, dueDate: at(days), recurrence: 'monthly', captureMetadata: { amountMinor: 10000, currency: 'INR' } });
      state.items = [bill('overdue', -3), bill('soon', 2), bill('later', 40)];
      renderMoney();
      return {
        due: billsDueSoon().map((i) => i.id).sort(),
        card: !document.getElementById('moneyBillsCard').hidden,
        rows: document.querySelectorAll('#moneyBills .task-row').length,
        sub: (document.querySelector('#moneyBills .task-sub') || {}).textContent || '',
      };
    });
    assert.deepEqual(r.due, ['overdue', 'soon'], `due soon came back as ${JSON.stringify(r.due)}`);
    assert.ok(r.card, 'the Due soon card stayed hidden with two bills in it');
    assert.equal(r.rows, 2, 'the wrong number of bills rendered');
    assert.match(r.sub, /overdue|Due/i, `the row says nothing about urgency: "${r.sub}"`);
  });

  await check('a bill keeps its due date and does remind', async () => {
    // The mirror of the expense rule. An expense is money gone and is reminded about never; a bill is
    // money owed, and the reminder is the entire feature.
    const r = await run(() => {
      const bill = {
        id: 'n1', kind: 'bill', title: 'Rent', done: false, created: 1,
        dueDate: new Date(Date.now() + 3600000).toISOString(), snoozedUntil: '', notified: false,
        captureMetadata: { amountMinor: 1500000, currency: 'INR' },
      };
      return { reminder: itemReminderTime(bill) };
    });
    assert.ok(r.reminder, 'a bill due in an hour did not set a reminder');
  });

  await check('"Pay Ã¢â€šÂ¹899 internet on the 10th" is captured as a repeating bill', async () => {
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      document.getElementById('captureText').value = 'Pay Ã¢â€šÂ¹899 for internet on the 10th';
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 900));
      await saveCapture(true);
      const item = state.items[0];
      if (!item) return { error: 'nothing was saved' };
      return {
        kind: item.kind,
        amount: moneyOf(item).amountMinor,
        recurrence: item.recurrence,
        isSub: isSubscription(item),
        hasDue: Boolean(item.dueDate),
      };
    });
    assert.ok(!r.error, r.error);
    assert.equal(r.kind, 'bill', `it was saved as a ${r.kind}`);
    assert.equal(r.amount, 89900, `the amount saved as ${r.amount}`);
    assert.equal(r.recurrence, 'monthly', `it repeats as "${r.recurrence}" Ã¢â‚¬â€ next month would never arrive`);
    assert.ok(r.hasDue, 'no due date, so it would never remind');
    assert.ok(!r.isSub, 'an internet bill was filed as a subscription');
  });

  await check('Netflix is captured as a subscription and counted monthly', async () => {
    const r = await run(async () => {
      state.items = [];
      openCapture();
      await new Promise((res) => setTimeout(res, 150));
      pickType('bill', true);
      document.getElementById('captureText').value = 'Netflix Ã¢â€šÂ¹649 every month';
      document.getElementById('captureBillType').value = 'subscription';
      await saveCapture(true);
      const item = state.items[0];
      return item
        ? { isSub: isSubscription(item), subs: subscriptions().length, total: monthlyRecurringCost() }
        : { error: 'nothing was saved' };
    });
    assert.ok(!r.error, r.error);
    assert.ok(r.isSub, 'Netflix was not filed as a subscription');
    assert.equal(r.subs, 1, 'the subscriptions list is empty');
    assert.equal(r.total, 64900, `the monthly cost came to ${r.total}`);
  });

  await check('a yearly bill rolls a year, and a monthly one clamps instead of overflowing', async () => {
    // Fixed dates, so this cannot pass or fail depending on what month it happens to be. 31 January
    // is also the overflow case: Date#setMonth would send it to 3 March.
    const r = await run(() => {
      const jan31 = new Date(2027, 0, 31, 9, 0, 0).toISOString();
      const feb28 = new Date(2027, 1, 28, 9, 0, 0);
      return {
        yearly: nextOccurrence(jan31, 'yearly'),
        monthly: nextOccurrence(jan31, 'monthly'),
        expected: feb28.toISOString(),
      };
    });
    const yearly = new Date(r.yearly);
    assert.equal(yearly.getFullYear(), 2028, `a yearly bill advanced to ${yearly.getFullYear()}`);
    assert.equal(yearly.getMonth(), 0, 'a yearly bill landed in the wrong month');
    assert.equal(r.monthly, r.expected,
      `31 January + 1 month gave ${r.monthly}, expected ${r.expected} Ã¢â‚¬â€ it overflowed into March`);
  });

  // ---------- Editing a saved amount ----------
  await check('a saved expense can have its amount corrected', async () => {
    // The gap that made the receipt feature unsafe: it invites you to check the number before
    // saving, and then gave you no way to change it afterwards. A misread total was permanent.
    const r = await run(async () => {
      state.items = [{
        id: 'e1', kind: 'expense', title: 'D-Mart', done: false, created: 1,
        captureMetadata: { amountMinor: 87400, currency: 'INR', category: 'Groceries', merchant: 'D-Mart', spentOn: '2026-03-04' },
      }];
      currentItemId = 'e1';
      openEditModal();
      return {
        shown: document.getElementById('editMoneyFields').style.display !== 'none',
        amount: document.getElementById('editAmount').value,
        category: document.getElementById('editCategory').value,
        spentOn: document.getElementById('editSpentOn').value,
        // A bill row must not appear on an expense.
        billRow: document.getElementById('editBillTypeRow').hidden,
        owedRow: document.getElementById('editOwedRow').hidden,
      };
    });
    assert.ok(r.shown, 'the money fields are hidden on a saved expense');
    assert.equal(r.amount, '874', `the amount box shows "${r.amount}" Ã¢â‚¬â€ paise leaked into a rupee box`);
    assert.equal(r.category, 'Groceries', 'the category was not shown');
    assert.equal(r.spentOn, '2026-03-04', 'the spent-on date was not shown');
    assert.ok(r.billRow, 'a bill type picker was offered on an expense');
    assert.ok(r.owedRow, 'a debt direction was offered on an expense');
  });

  await check('a corrected amount reaches the month total', async () => {
    const r = await run(async () => {
      state.items = [{
        id: 'e1', kind: 'expense', title: 'D-Mart', done: false, created: 1,
        captureMetadata: { amountMinor: 87400, currency: 'INR', spentOn: isoDateString(new Date()) },
      }];
      const before = sumMoney(expensesThisMonth());
      currentItemId = 'e1';
      openEditModal();
      document.getElementById('editAmount').value = '499';
      await saveEdit();
      renderMoney();
      return { before, after: sumMoney(expensesThisMonth()), stored: moneyOf(state.items[0]).amountMinor };
    });
    assert.equal(r.before, 87400, 'the total did not start at the saved amount');
    assert.equal(r.stored, 49900, `the corrected amount stored as ${r.stored}`);
    assert.equal(r.after, 49900, `the month total reads ${r.after} Ã¢â‚¬â€ the correction did not reach it`);
  });
  // PLACEHOLDER_EDIT_DEBT

  await check('a debt shows its amount and its direction, and can be turned around', async () => {
    // A debt is a task, so the kind says nothing Ã¢â‚¬â€ only owedMinor does. Getting the direction wrong
    // turns "they owe me" into "I owe them", which is the worst possible inversion of a number.
    const r = await run(async () => {
      state.items = [{
        id: 'o1', kind: 'task', title: 'Owes me', person: 'Ravi', done: false, created: 1,
        captureMetadata: { owedMinor: 50000, currency: 'INR', owedDirection: 'in' },
      }];
      currentItemId = 'o1';
      openEditModal();
      const opened = {
        amount: document.getElementById('editAmount').value,
        direction: document.getElementById('editOwedDirection').value,
        shown: document.getElementById('editMoneyFields').style.display !== 'none',
        owedRow: !document.getElementById('editOwedRow').hidden,
        spentRow: document.getElementById('editSpentOnRow').hidden,
      };
      document.getElementById('editAmount').value = '750';
      document.getElementById('editOwedDirection').value = 'out';
      await saveEdit();
      return { opened, after: moneyOwedOf(state.items[0]), spent: moneyOf(state.items[0]).amountMinor };
    });
    assert.ok(r.opened.shown, 'a debt showed no amount at all');
    assert.equal(r.opened.amount, '500', `the debt box shows "${r.opened.amount}"`);
    assert.equal(r.opened.direction, 'in', 'the direction did not open on "they owe me"');
    assert.ok(r.opened.owedRow, 'the direction picker is missing');
    assert.ok(r.opened.spentRow, 'a spent-on date was offered on a debt');
    assert.equal(r.after.amountMinor, 75000, `the corrected debt stored as ${r.after.amountMinor}`);
    assert.equal(r.after.direction, 'out', `the direction is "${r.after.direction}"`);
    // Turning a debt around must not make it an expense.
    assert.equal(r.spent, null, 'editing a debt wrote into the spending fields');
  });

  await check('an item with no money shows no money fields', async () => {
    const r = await run(() => {
      state.items = [{ id: 'p1', kind: 'task', title: 'Call Ravi', done: false, created: 1 }];
      currentItemId = 'p1';
      openEditModal();
      return { shown: document.getElementById('editMoneyFields').style.display !== 'none' };
    });
    assert.ok(!r.shown, 'an ordinary task was shown an amount box');
  });

  await check('a cleared amount is honoured, and the row drops out of the total', async () => {
    // Capture refuses an amountless expense, because "I spent money" with no number is a question
    // it should have asked. Here the person is deliberately emptying the box, which has to work Ã¢â‚¬â€
    // otherwise a note filed as an expense by mistake can never be freed.
    const r = await run(async () => {
      state.items = [{
        id: 'e1', kind: 'expense', title: 'Something', done: false, created: 1,
        captureMetadata: { amountMinor: 87400, currency: 'INR', spentOn: isoDateString(new Date()) },
      }];
      const before = sumMoney(expensesThisMonth());
      currentItemId = 'e1';
      openEditModal();
      document.getElementById('editAmount').value = '';
      await saveEdit();
      return { before, after: sumMoney(expensesThisMonth()), stored: moneyOf(state.items[0]).amountMinor, kept: state.items.length };
    });
    assert.equal(r.before, 87400, 'the total did not start at the saved amount');
    assert.equal(r.stored, null, `the amount is still ${r.stored} Ã¢â‚¬â€ the box could not be cleared`);
    assert.equal(r.after, 0, `the month total is ${r.after} Ã¢â‚¬â€ a cleared row is still being counted`);
    assert.equal(r.kept, 1, 'clearing the amount deleted the item');
  });

} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
if (!failed) console.log(`\nALL ${results.length} MONEY CHECKS PASSED`);
else console.log(`\n${failed} of ${results.length} money checks FAILED`);
