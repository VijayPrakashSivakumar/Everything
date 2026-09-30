/* ---------- Data model ---------- */
const NAV = [
  { id: "today", icon: "layout-dashboard", label: "Dashboard" },
  { id: "inbox", icon: "inbox", label: "Inbox", badgeKey: "inboxCount" },
  { id: "tasks", icon: "check-square-2", label: "Tasks", badgeKey: "taskCount" },
  { id: "schedule", icon: "calendar-days", label: "Schedule" },
  { id: "memory", icon: "brain", label: "Memory" },
  { id: "documents", icon: "file-badge", label: "Documents" },
  { id: "money", icon: "wallet", label: "Money" },
  { id: "people", icon: "users", label: "People" },
  { id: "projects", icon: "folder-kanban", label: "Projects" },
  { id: "goals", icon: "target", label: "Goals" },
  { id: "review", icon: "clipboard-check", label: "Review" },
  { id: "reports", icon: "chart-no-axes-combined", label: "Reports" },
  { id: "insights", icon: "sparkles", label: "Insights" },
  { id: "logout", icon: "log-out", label: "Logout", divider: true },
];

/* ---------- Icons ----------
   One place to build icon markup, so any HTML string can use icon("bell").
   The observer below upgrades newly inserted <i data-lucide> placeholders.

   Two guards keep this from thrashing the page: lucide's createIcons() copies
   data-lucide onto the <svg> it generates, so a naive observer + createIcons
   pair re-replaces every icon forever (each swap is another mutation).
   So we (1) ignore mutations caused by lucide itself, (2) only look for
   placeholders that are still <i>, and (3) skip the scan when none exist. */
function icon(name, cls) {
  return `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ""} aria-hidden="true"></i>`;
}
let iconRefreshQueued = false;
let iconUpgradeRunning = false;
function refreshIcons() {
  if (iconRefreshQueued) return;
  iconRefreshQueued = true;
  setTimeout(() => {
    iconRefreshQueued = false;
    if (!window.lucide || !window.lucide.createIcons) return;
    // Nothing pending: already-rendered <svg> icons are left untouched.
    if (!document.querySelector("i[data-lucide]")) return;
    iconUpgradeRunning = true;
    try {
      window.lucide.createIcons();
    } finally {
      iconUpgradeRunning = false;
    }
  }, 0);
}
if (typeof MutationObserver === "function")
  new MutationObserver((records) => {
    if (iconUpgradeRunning) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.matches("i[data-lucide]") ||
          (typeof node.querySelector === "function" &&
            node.querySelector("i[data-lucide]"))
        ) {
          refreshIcons();
          return;
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
if (document.readyState !== "loading") refreshIcons();
else window.addEventListener("load", refreshIcons, { once: true });

let state = null;
let currentItemId = null;
let captureType = "text";

/* How the capture arrived, as opposed to what it turned out to be.

   These used to be one variable, which is why a voice note could never become a task. `captureType`
   was holding "voice" — the channel — so the smart-capture rules all had to skip every media
   capture, and an auto-create could never fire for one. A recorded "call Ravi tomorrow" stayed a
   voice note forever.

   The two are now separate: the channel decides how the media is handled, and the kind decides what
   the item *is*. Recording a voice note and then having it understood as a task is exactly the case
   this split exists for. */
let captureChannel = "text";
/* Channels that carry real language, so their content can be read the same way a typed sentence is:
   a transcript, or text recognised out of a picture. A file has no text at all, and a link's "text"
   is a URL, so asking a model to interpret either would be guessing — those two are left alone. */
const CAPTURE_CHANNELS_WITH_TEXT = new Set(["voice", "image"]);

/* ---------- Money ----------
   An expense is a *kind of item*, the same way a document is. That is the whole design: the sync,
   the offline queue, realtime, RLS, backup, search and household sharing are all built around
   `items`, so money inherits all of them instead of needing a second implementation of each.

   THE AMOUNT IS NEVER A FLOAT. `capture_metadata` is jsonb, so `{"amount": 1200.50}` would be
   stored as an IEEE double and 0.1 + 0.2 problems would make "spent this month" drift by a paisa —
   and a total that is off by a paisa makes a person stop trusting every number in the app. So the
   amount is an integer count of minor units: 450 rupees is 45000 paise, and 450.50 is 45050. Sum
   those and the answer is exact, forever. Formatting is the display's job, done at the last moment. */

const MONEY_CURRENCY = "INR";
const MONEY_SYMBOL = "₹";
/* Paise in a rupee. Named rather than written inline because every amount in the app is divided or
   multiplied by it, and a bare 100 in three places is three chances to be wrong. */
const PAISE_PER_RUPEE = 100;

/* Categories are free text in the database, so a household can add its own ("School fees", "Pet").
   These are only the starting set offered in the picker. "Groceries" and "Food" are deliberately
   separate: buying vegetables and eating out are different decisions, and merging them is the
   single most common way a spending report becomes useless. */
const MONEY_CATEGORIES = [
  { id: "groceries", label: "Groceries" },
  { id: "food", label: "Food" },
  { id: "transport", label: "Transport" },
  { id: "shopping", label: "Shopping" },
  { id: "utilities", label: "Utilities" },
  { id: "health", label: "Health" },
  { id: "education", label: "Education" },
  { id: "entertainment", label: "Entertainment" },
  { id: "rent", label: "Rent" },
  { id: "bills", label: "Bills" },
  { id: "other", label: "Other" },
];

/* Words that name a category. Matched against the whole sentence, first hit wins, so the order is
   the priority order: "grocery shopping" must be Groceries, not Shopping. */
const MONEY_CATEGORY_HINTS = [
  { id: "groceries", re: /\b(grocer(y|ies)|sabzi|vegetable|kirana|supermarket|bigbasket|d-mart|dmart|reliance fresh|milk|provisions)\b/i },
  { id: "food", re: /\b(restaurant|food|lunch|dinner|breakfast|cafe|coffee|pizza|burger|zomato|swiggy|takeaway|take out|dining|eat out|canteen|chai|tea)\b/i },
  { id: "transport", re: /\b(uber|ola|taxi|cab|auto|rickshaw|metro|bus|train|flight|ticket|fuel|petrol|diesel|gas|parking|toll|travel)\b/i },
  { id: "rent", re: /\b(rent|maintenance|society fee|brokerage)\b/i },
  { id: "utilities", re: /\b(electricity|water|internet|wifi|broadband|phone bill|mobile recharge|dth|utility)\b/i },
  { id: "bills", re: /\b(bill|invoice|emi|loan|insurance|premium|subscription)\b/i },
  { id: "health", re: /\b(doctor|medicine|medical|hospital|pharmacy|med|dentist|test|clinic|apollo|pharm)\b/i },
  { id: "education", re: /\b(school fee|tuition|fees|course|book|stationery|university|college|admission)\b/i },
  { id: "entertainment", re: /\b(movie|film|netflix|spotify|prime video|concert|game|ott|gaming)\b/i },
  { id: "shopping", re: /\b(shopping|clothes|shoes|dress|amazon|flipkart|mall|electronics|phone|laptop|gift)\b/i },
];

function isExpense(item) {
  return item?.kind === "expense";
}

function moneyCategoryLabel(id) {
  const key = String(id || "").trim().toLowerCase();
  return MONEY_CATEGORIES.find((entry) => entry.id === key)?.label || "";
}

/* Indian digit grouping: the last three digits, then pairs. ₹120450 is 1,20,450 and not 12,0450.

   This is two steps and not one clever regex on purpose. A single lookahead pass produces
   "12,04,50" here — verified, not guessed — because it cannot see that the trailing group has to be
   three digits wide. The last three are peeled off first, and only the remainder is grouped, which
   is the one way to get it right. */
function groupIndianDigits(rupees) {
  const digits = String(rupees);
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${lastThree}`;
}

/* Paise to "₹1,20,450.50". Done at the last moment, and from the integer, so the two halves are
   computed separately and no float ever carries a rounding error into a displayed total. */
function formatMoney(amountMinor, options = {}) {
  const minor = Number(amountMinor);
  if (!Number.isFinite(minor)) return "";
  const negative = minor < 0;
  const absolute = Math.abs(Math.round(minor));
  const rupees = Math.floor(absolute / PAISE_PER_RUPEE);
  const paise = absolute % PAISE_PER_RUPEE;
  const body = options.bare ? groupIndianDigits(rupees) : `${MONEY_SYMBOL}${groupIndianDigits(rupees)}`;
  const withPaise = paise ? `${body}.${String(paise).padStart(2, "0")}` : body;
  return negative ? `-${withPaise}` : withPaise;
}

/* The only way into an amount. Text in, an integer count of paise out, or null.

   String surgery rather than parseFloat, for the obvious reason: parseFloat("450.50") is
   450.49999999999994, and every total built from those is wrong in the last digit. */
function parseMoneyToMinor(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  // Keep digits and separators, drop currency symbols and words.
  const cleaned = text.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const negative = cleaned.startsWith("-");
  const unsigned = cleaned.replace(/-/g, "");
  // Indian and western grouping both appear — 1,20,000 and 120,000 — and a comma is always grouping
  // here, never a decimal point. A decimal in this app is always a period.
  let body = unsigned.replace(/,/g, "");
  // A lone trailing separator ("450." from a half-typed amount) is not a decimal part.
  if (body.endsWith(".")) body = body.slice(0, -1);
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const [rupeesText, paiseText = ""] = body.split(".");
  const rupees = Number(rupeesText);
  if (!Number.isFinite(rupees)) return null;
  const paiseDigits = (paiseText + "00").slice(0, 2);
  // More than two decimal places is a typo, not a price. Rounded rather than truncated, so
  // 450.505 is 45051 paise instead of losing the half paisa on the floor.
  const third = paiseText.charCodeAt(2) - 48;
  let paise = Number(paiseDigits);
  if (paiseText.length > 2 && third >= 5) paise += 1;
  // Rounding can reach 100 paise, and that has to carry into the rupees — otherwise 99.999 is
  // stored as 100 paise and every total that includes it is one rupee short.
  const total = rupees * PAISE_PER_RUPEE + paise;
  return negative ? -total : total;
}

/* The amount in a sentence, and only an amount — "₹450", "Rs 1200.50", "INR 300", "450 rupees".

   Deliberately never a bare number: "paid 3 people" must not become an expense of three rupees.
   A number is money only when a currency word sits next to it. */
const MONEY_AMOUNT_RE = /(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d{1,3})?)|(\d[\d,]*(?:\.\d{1,3})?)\s*(?:rupees?|inr)\b/i;

function parseAmountFromText(text) {
  const match = MONEY_AMOUNT_RE.exec(String(text || ""));
  if (!match) return null;
  return parseMoneyToMinor(match[1] || match[2]);
}

/* ---------- Receipts ----------
   A photograph of a receipt already arrives as text: the image channel runs Tesseract and drops
   the result into the capture box. So nothing here has to read pixels. The hard part is not
   finding a number — a receipt is full of them — it is telling the *total* from the subtotal, the
   tax, and the amount of change.

   Two rules make that reliable without a model:

     * read the lines from the BOTTOM up, because the total is printed last on almost every receipt
     * and the itemised list above it is full of numbers larger than any single line;
     * refuse a line that names anything but the total — SUBTOTAL, GST, CGST, TAX, DISCOUNT and
       ROUND OFF are all present on the same paper and every one of them is the wrong answer.

   And whatever it decides, it only ever *proposes*. The amount lands in the box where the person
   can see it and change it. A receipt photo is the one capture where being confidently wrong is
   most likely, so nothing here asserts a number it did not read. */
const RECEIPT_TOTAL_RE = /(?:grand\s*)?(?:total|amount\s*(?:due|paid|payable)|net\s*payable|to\s*pay|balance)\b/i;
/* A line carrying one of these is never the total, however close it sits to the bottom. */
const RECEIPT_NOT_TOTAL_RE = /\b(sub\s*-?\s*total|subtotal|tax|gst|cgst|sgst|igst|discount|saving|offer|round\s*off|change|cash|paid\s*by|balance\s*forward|item\s*count|qty)\b/i;
const RECEIPT_ANY_AMOUNT_RE = /(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*\.\d{2})\b/i;

/* The amount a receipt says was actually paid, or null when nothing on it says so clearly.

   A bare number is accepted ONLY on a line already confirmed to be the total line, so "240" can
   stand for ₹240 on a "TOTAL 240" line and still never be read off an item row. The looser pattern
   is tried second for exactly that reason. */
function receiptTotalFromText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!RECEIPT_TOTAL_RE.test(line)) continue;
    if (RECEIPT_NOT_TOTAL_RE.test(line)) continue;
    const strict = RECEIPT_ANY_AMOUNT_RE.exec(line);
    const loose = strict ? null : /(\d[\d,]*(?:\.\d{1,2})?)\s*$/.exec(line);
    const minor = parseMoneyToMinor((strict && (strict[1] || strict[2])) || (loose && loose[1]));
    if (minor !== null && minor > 0) return { amountMinor: minor, line };
  }
  return null;
}

/* The shop is the first line that is not a phone number, a tax id, an address or a date — a receipt
   opens with its own name, and everything above it is machinery. */
const RECEIPT_NOISE_RE =
  /^(tax|invoice|inv|bill|receipt|gstin|gst|vat|tel|phone|mobile|www\.|http|date|time|cashier|bill no|order|customer|kotak|hdfc|icici|sbi|axis|upi|vpa|no\.)\b/i;

function receiptMerchantFromText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 4)) {
    if (line.length < 3 || line.length > 40) continue;
    if (RECEIPT_NOISE_RE.test(line)) continue;
    if (/\d{4,}/.test(line)) continue;              // a phone number or a GST id, not a name
    if (parseMoneyToMinor(line) !== null) continue;  // a bare number is not a shop
    return line;
  }
  return "";
}

/* A date printed on the paper, so the expense lands on the day it happened rather than the day it
   was photographed. Only the three orders an Indian receipt actually uses. */
function receiptDateFromText(text) {
  const body = String(text || "");
  const slash = body.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (slash) {
    let day = Number(slash[1]);
    let month = Number(slash[2]);
    /* A second field above 12 cannot be a month, so this is the month-first form. That test was
       written backwards at first — keying off the *first* field instead — which swapped 25/12/2025
       into a 25th month, found it impossible, and returned no date at all. Only a month can rule
       itself out; a day above 12 proves the opposite, and is the common Indian case. */
    if (month > 12 && day <= 12) {
      const swap = day;
      day = month;
      month = swap;
    }
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    const candidate = new Date(year, month - 1, day);
    if (year >= 2000 && year <= 2100 && candidate.getMonth() === month - 1 && candidate.getDate() === day) {
      return isoDateString(candidate);
    }
  }
  const iso = body.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso && parseIsoDate(`${iso[1]}-${iso[2]}-${iso[3]}`)) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return "";
}

/* Does this look like a receipt at all? A total line plus a date or an invoice reference is a much
   safer bar than "contains a number", which every photograph of a price tag also satisfies. */
function textLooksLikeReceipt(text) {
  const body = String(text || "");
  if (!receiptTotalFromText(body)) return false;
  return Boolean(
    receiptDateFromText(body) || /\b(invoice|inv|bill\s*no|receipt|gstin|order\s*(no|id))\b/i.test(body),
  );
}

/* ---------- Money owed ----------
   "Ravi owes me ₹500" is money that has not moved, in either direction. It is the one money fact
   with no home among the others: not an expense (nothing was spent, and counting it would inflate
   the month with money that never left the account), and not a bill (nobody has issued anything).

   It is saved as a TASK, because a task already chases you — it lands on Today, it can be completed
   when the money arrives, and it can be snoozed. A fourth kind would have needed all three built
   again for a row whose only special property is an amount. */
const MONEY_OWED_RE = /\b(owes?\s+me|owe\s+i|i\s+owe|lends?\s+me|borrowed)\b/i;

/* Which way the money is going. "in" is someone else's debt to you, "out" is yours. Getting this
   backwards is the whole failure: an amount with no direction is a number nobody can act on. */
const MONEY_OWED_IN_RE = /\b(owes?\s+me|owes?\s+us|borrowed\s+from|lends?\s+me)\b/i;

function textLooksLikeMoneyOwed(text) {
  const body = String(text || "");
  return MONEY_OWED_RE.test(body) && parseAmountFromText(body) !== null;
}

function moneyOwedDirection(text) {
  return MONEY_OWED_IN_RE.test(String(text || "")) ? "in" : "out";
}

/* Read off a saved item. `owedMinor`, not `amountMinor`: the two are deliberately different keys,
   so an amount belonging to an owed row can never be swept into this month's spending by a total
   that loops over every row without checking what kind it is. */
function moneyOwedOf(item) {
  const meta = normaliseCaptureMetadata(item?.captureMetadata);
  // Same rule as moneyOf: an absent debt is null, not ₹0. See there for why Number() cannot be used
  // straight on a value that is allowed to be missing.
  const minor =
    meta.owedMinor === null || meta.owedMinor === undefined || meta.owedMinor === ""
      ? NaN
      : Number(meta.owedMinor);
  return {
    amountMinor: Number.isFinite(minor) ? Math.round(minor) : null,
    currency: String(meta.currency || MONEY_CURRENCY).toUpperCase(),
    direction: String(meta.owedDirection || "in"),
  };
}

function guessMoneyCategory(text) {
  const body = String(text || "");
  for (const hint of MONEY_CATEGORY_HINTS) {
    if (hint.re.test(body)) return hint.id;
  }
  return "";
}

/* Anything that says money was spent, bought or paid for. Used to notice an expense from a plain
   sentence, and to keep "pay the bill on the 5th" from being read as money already spent. */
const MONEY_SPEND_RE =
  /\b(spent|spend|spends|paid|pay|pays|paying|bought|buy|buying|cost|costs|charged|purchased|expense|groceries|bill|fee|recharge|top ?up)\b/i;

function textLooksLikeExpense(text) {
  return MONEY_SPEND_RE.test(String(text || ""));
}

/* Everything the Money view and the reports need, off one item. Read through here so no caller
   reaches into capture_metadata directly and two places cannot disagree about what a total is. */
function moneyOf(item) {
  const meta = normaliseCaptureMetadata(item?.captureMetadata);
  // An absent amount has to read as null, not as 0. Number(null) is 0 and Number("") is 0, so the
  // naive read turned a deliberately cleared amount into a real zero — which then rendered as ₹0 in
  // a list and looked like the most confident number on the page. Absent is its own state.
  const minor =
    meta.amountMinor === null || meta.amountMinor === undefined || meta.amountMinor === ""
      ? NaN
      : Number(meta.amountMinor);
  return {
    amountMinor: Number.isFinite(minor) ? Math.round(minor) : null,
    currency: String(meta.currency || MONEY_CURRENCY).toUpperCase(),
    category: String(meta.category || ""),
    merchant: String(meta.merchant || ""),
    // The day it happened, which is not the same as when it was typed: an expense entered on the
    // 3rd for the 1st belongs to the 1st, and a monthly report that gets that wrong is a report
    // nobody trusts.
    spentOn: meta.spentOn || "",
  };
}

function expenseItems() {
  if (!state?.items) return [];
  return state.items.filter((i) => isExpense(i) && !isArchived(i));
}

/* Only same-currency amounts are ever added together. Mixing two currencies is not a rounding
   error, it is a meaningless number, and it is better to leave it out of the total than print it. */
function sumMoney(items) {
  return items.reduce((total, item) => {
    const money = moneyOf(item);
    if (money.amountMinor === null) return total;
    if (money.currency !== MONEY_CURRENCY) return total;
    return total + money.amountMinor;
  }, 0);
}

function expenseSpentOn(item) {
  return moneyOf(item).spentOn || isoDateString(new Date(Number(item?.created) || Date.now()));
}

function expensesThisMonth(reference) {
  const now = reference ? new Date(reference) : new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return expenseItems().filter((item) => {
    const date = parseIsoDate(expenseSpentOn(item));
    return Boolean(date) && date.getFullYear() === year && date.getMonth() === month;
  });
}

function expensesByCategory(reference) {
  const buckets = new Map();
  expensesThisMonth(reference).forEach((item) => {
    const money = moneyOf(item);
    if (money.amountMinor === null) return;
    const key = money.category || "other";
    if (!buckets.has(key)) buckets.set(key, { id: key, total: 0, count: 0 });
    const bucket = buckets.get(key);
    bucket.total += money.amountMinor;
    bucket.count += 1;
  });
  return [...buckets.values()].sort((a, b) => b.total - a.total);
}

/* ---------- Bills & subscriptions ----------
   A bill is money that is owed, on a date, and then owed again. That makes it the exact mirror of an
   expense: the same amount handling, the same household, the same sync — but with a due date and a
   recurrence instead of a day it already happened.

   One kind covers both a bill and a subscription, because mechanically they are identical: an
   amount, a day it is due, and a repeat. The only difference is what the row is called, so that is
   a label (`billType`) rather than a second kind with a second copy of the recurrence plumbing. */

const BILL_TYPES = [
  { id: "bill", label: "Bill" },
  { id: "subscription", label: "Subscription" },
];

/* How far ahead "due soon" reaches. A week is the point at which paying something is still a
   decision rather than a scramble. */
const BILL_DUE_SOON_DAYS = 7;

function isBill(item) {
  return item?.kind === "bill";
}

function isSubscription(item) {
  return isBill(item) && billTypeOf(item) === "subscription";
}

/* What repeats, and therefore joins a series. A task repeats because the chore does; a bill repeats
   because the charge does. An expense and a document never do — the money is spent and the document
   expires, and neither comes back. One predicate, so the two call sites above cannot disagree. */
function canRepeat(item) {
  return item?.kind === "task" || isBill(item);
}

function billTypeOf(item) {
  const meta = normaliseCaptureMetadata(item?.captureMetadata);
  const id = String(meta.billType || "").trim().toLowerCase();
  return BILL_TYPES.find((entry) => entry.id === id)?.id || "bill";
}

function billLabel(item) {
  return billTypeOf(item) === "subscription" ? "Subscription" : "Bill";
}

/* Whole days until it is due. Negative once it has passed, which is the case that matters most. */
function daysUntilBill(item) {
  if (!item?.dueDate) return null;
  const time = new Date(item.dueDate).getTime();
  if (!Number.isFinite(time)) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(time);
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endDay.getTime() - start.getTime()) / 86400000);
}

function billLabelFor(item) {
  const days = daysUntilBill(item);
  if (days === null) return "No due date";
  if (days < -1) return `${Math.abs(days)} days overdue`;
  if (days === -1) return "1 day overdue";
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days <= 30) return `Due in ${days} days`;
  return `Due ${fmtDate(item.dueDate)}`;
}

function billItems() {
  if (!state?.items) return [];
  return state.items.filter((i) => isBill(i) && !isArchived(i) && !i.done);
}

/* What is owed in the next week, most urgent first. A bill that has already passed its date stays
   in the list rather than being filtered out — an unpaid bill is exactly the thing worth seeing. */
function billsDueSoon(days = BILL_DUE_SOON_DAYS) {
  return billItems()
    .filter((item) => {
      const due = daysUntilBill(item);
      return due !== null && due <= days;
    })
    .sort((a, b) => (daysUntilBill(a) ?? 0) - (daysUntilBill(b) ?? 0));
}

/* The number a household actually wants from subscriptions: what leaves the account every month.

   A yearly charge is divided by twelve rather than added whole, because "₹1,200 a year for cloud
   storage" is ₹100 a month, and listing it as ₹1,200 would overstate the monthly cost by twelve
   times. Rounded to whole paise so the figure itself cannot drift. */
function monthlyRecurringCost() {
  return Math.round(
    billItems().reduce((total, item) => {
      const money = moneyOf(item);
      if (money.amountMinor === null || money.currency !== MONEY_CURRENCY) return total;
      if (item.recurrence === "monthly") return total + money.amountMinor;
      if (item.recurrence === "yearly") return total + money.amountMinor / 12;
      // A weekly charge is the one that has no honest monthly figure, so it is left out rather
      // than guessed at — four weeks is not a month, and the difference shows up every time.
      return total;
    }, 0),
  );
}

function subscriptions() {
  return billItems()
    .filter(isSubscription)
    .sort((a, b) => (daysUntilBill(a) ?? 9999) - (daysUntilBill(b) ?? 9999));
}

/* Money owed, either way, and still open. A debt is not spending and is not a bill, so it has
   nowhere else to be seen: without this the only place it exists is one task on Today, and the
   running total of what you are owed is a number people actually want. */
function outstandingMoneyOwed() {
  if (!state?.items) return [];
  return state.items
    .filter((i) => i && !i.done && !isArchived(i) && Number.isFinite(Number(moneyOwedOf(i).amountMinor)))
    .map((item) => ({ item, owed: moneyOwedOf(item) }))
    .filter((entry) => entry.owed.amountMinor > 0)
    // What others owe you first: that is the money you can go and collect, and it is the direction
    // most captures are in. Then yours, so the two never blur into one number.
    .sort((a, b) => {
      if (a.owed.direction !== b.owed.direction) return a.owed.direction === "in" ? -1 : 1;
      return b.owed.amountMinor - a.owed.amountMinor;
    });
}

/* A bill named in the sentence, and the words that name the recurring services. Ordered so the
   specific services win over the generic word "bill" — "netflix bill" is a subscription, and reading
   it as a utility would put it in the wrong list. */
const BILL_CATEGORY_HINTS = [
  { id: "subscription", re: /\b(netflix|spotify|youtube|prime video|disney|hotstar|icloud|google (one|storage)|dropbox|adobe|canva|notion|microsoft 365|subscription|membership)\b/i },
  { id: "bill", re: /\b(electricity|water|gas|internet|wifi|broadband|mobile|phone|recharge|dth|rent|emi|loan|insurance|tax|bill)\b/i },
];

function guessBillType(text) {
  const body = String(text || "");
  for (const hint of BILL_CATEGORY_HINTS) {
    if (hint.re.test(body)) return hint.id;
  }
  return "bill";
}

/* Money that is owed rather than spent. A date in the sentence is what makes it a bill rather than
   an expense: "spent ₹450 for groceries" is history, "pay ₹899 for internet on the 10th" is a
   future obligation, and conflating the two would put a not-yet-spent amount into this month's
   total. So both are required, and a sentence with neither is left alone entirely. */
/* "on the 5th", "by the 10th" — the canonical Indian bill phrasing, and the one no date parser
   resolves, because a bare day of the month is not a date until you supply the month.

   Resolved to this month's 5th, or next month's when that has already passed. Always forward: a
   bill said to be payable on the 1st, said on the 3rd, means the 1st of next month, not a date two
   days in the past that would be filed overdue before it was ever due. */
const DAY_OF_MONTH_RE = /\b(?:on|by|before)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;

function resolveDayOfMonth(text) {
  const match = DAY_OF_MONTH_RE.exec(String(text || ""));
  if (!match) return null;
  const day = Number(match[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(now.getFullYear(), now.getMonth(), 1);
  // Clamped, because there is no 31st in some months and a bill due then still has to land on the
  // last day that exists rather than rolling into the following one.
  target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
  if (target.getTime() < today.getTime()) target.setMonth(target.getMonth() + 1);
  return target.toISOString();
}

function textLooksLikeBill(text) {
  const body = String(text || "");
  if (!textLooksLikeExpense(body)) return false;
  if (parseAmountFromText(body) === null) return false;
  if (/\b(on the \d{1,2}(st|nd|rd|th)?|tomorrow|today|next (week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|every (month|year|week)|monthly|yearly)\b/i.test(body)) {
    return true;
  }
  if (DAY_OF_MONTH_RE.test(body)) return true;
  return Boolean(parseLocalDate(body));
}

function isArchived(item) {
  return Boolean(item?.archivedAt || item?.archived_at);
}

/* ---------- Documents ----------
   A document is an item with kind "document" and, usually, an expiry date. Warranties, insurance,
   licences and subscriptions all have one; receipts do not, and a receipt is a perfectly ordinary
   document rather than a broken one. Everything below therefore treats "no expiry date" as a real
   state rather than as missing data. */

const DOCUMENT_TYPES = [
  { id: "warranty", label: "Warranty", icon: "shield-check" },
  { id: "insurance", label: "Insurance", icon: "shield" },
  { id: "receipt", label: "Receipt", icon: "receipt" },
  { id: "licence", label: "Licence", icon: "credit-card" },
  { id: "passport", label: "Passport / ID", icon: "book-user" },
  { id: "manual", label: "Manual", icon: "book-open" },
  { id: "other", label: "Other", icon: "file" },
];

/* How far ahead an expiry starts asking to be acted on. Thirty days is the window in which renewing
   a licence or a policy is still possible; a shorter one would be too late to arrange, and a longer
   one turns every document into noise within the month. */
const DOCUMENT_EXPIRY_LEAD_DAYS = 30;
const DOCUMENT_SOON_DAYS = 7;

function isDocument(item) {
  return item?.kind === "document";
}

function documentTypeLabel(item) {
  const id = String(item?.docType || "").trim().toLowerCase();
  if (!id) return "Document";
  return DOCUMENT_TYPES.find((entry) => entry.id === id)?.label || item.docType;
}

/* The bucket a document sorts into, which is the only thing the Documents view actually cares
   about. "expired" is checked before "no expiry" on purpose: a date that cannot be read and a date
   that is absent must not both land in the same quiet bucket, where nothing would prompt a look. */
function documentBucket(item) {
  const days = daysUntil(item?.expiresOn);
  if (days === null) return "none";
  if (days < 0) return "expired";
  if (days <= DOCUMENT_SOON_DAYS) return "week";
  if (days <= DOCUMENT_EXPIRY_LEAD_DAYS) return "month";
  return "later";
}

/* `cls` is the expiry chip's modifier, declared here rather than assembled as `doc-${id}` at the
   call site. The string form is the same to a browser, but the class then exists as a literal anyone
   — or the dead-code audit — can find, which is the only reason it is written out four times. */
const DOCUMENT_BUCKETS = [
  { id: "expired", label: "Expired", icon: "alert-triangle", cls: "doc-expired" },
  { id: "week", label: `Next ${DOCUMENT_SOON_DAYS} days`, icon: "clock", cls: "doc-week" },
  { id: "month", label: `Next ${DOCUMENT_EXPIRY_LEAD_DAYS} days`, icon: "calendar-clock", cls: "doc-month" },
  { id: "later", label: "Later", icon: "calendar", cls: "doc-later" },
  { id: "none", label: "No expiry", icon: "inbox", cls: "doc-none" },
];

function documentBucketClass(item) {
  return DOCUMENT_BUCKETS.find((entry) => entry.id === documentBucket(item))?.cls || "doc-none";
}

function documentLabel(item) {
  const days = daysUntil(item?.expiresOn);
  if (days === null) return "No expiry date";
  if (days < -1) return `Expired ${Math.abs(days)} days ago`;
  if (days === -1) return "Expired yesterday";
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  if (days <= 30) return `Expires in ${days} days`;
  return `Expires ${fmtDate(item.expiresOn)}`;
}

/* When a document should be reminded, in epoch ms, or null when it should not.

   This is the whole point of storing an expiry: not "show it in a list", but "tell me before it
   lapses". An already-expired document still gets a reminder, because the thing that expired is
   usually the thing still needing attention (a lapsed policy, a licence that must be renewed) — but
   only within a grace window, or a two-year-old receipt would nag forever on every single load. */
function documentReminderTime(item) {
  if (!isDocument(item)) return null;
  const days = daysUntil(item?.expiresOn);
  if (days === null) return null;
  const expiredGraceDays = 7;
  if (days < -expiredGraceDays) return null;
  const now = new Date();
  const fire = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  fire.setDate(fire.getDate() + (days - DOCUMENT_EXPIRY_LEAD_DAYS));
  // 9am local, so an expiry notice is something you read with a coffee rather than in the dark.
  fire.setHours(9, 0, 0, 0);
  // Clamped to now. A document already inside the lead time would otherwise schedule its reminder
  // in the past, and the reminder engine treats a past time as due immediately — so it would fire
  // again on every single load, for as long as the document stayed in the window. One notice, once.
  return Math.max(fire.getTime(), now.getTime());
}

function documentItems() {
  if (!state?.items) return [];
  return state.items.filter((i) => isDocument(i) && !isArchived(i));
}

/* The ones that need something done about them, worst first. An expired document outranks one that
   expires next month regardless of the date it was captured, because that is the order a person
   would triage them in. */
function documentsNeedingAttention() {
  return documentItems()
    .filter((i) => ["expired", "week"].includes(documentBucket(i)))
    .sort((a, b) => String(a.expiresOn || "").localeCompare(String(b.expiresOn || "")));
}

const TASK_STATUS_OPTIONS = [
  { value: "planned", label: "Planned" },
  { value: "today", label: "Today" },
  { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "someday", label: "Someday" },
  { value: "completed", label: "Completed" },
];

const TASK_STATUS_ALIASES = {
  inbox: "planned",
  todo: "planned",
  open: "planned",
  doing: "in_progress",
  "in progress": "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  blocked: "waiting",
  complete: "completed",
  done: "completed",
  cancelled: "someday",
};

function normalizeTaskStatus(value, fallback = "planned") {
  const raw = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return fallback;
  if (TASK_STATUS_OPTIONS.some((option) => option.value === raw)) return raw;
  if (TASK_STATUS_ALIASES[raw]) return TASK_STATUS_ALIASES[raw];
  const underscored = raw.replace(/[ -]+/g, "_");
  if (TASK_STATUS_OPTIONS.some((option) => option.value === underscored)) return underscored;
  return fallback;
}

function taskStatusLabel(value) {
  const status = normalizeTaskStatus(value);
  return TASK_STATUS_OPTIONS.find((option) => option.value === status)?.label || "Planned";
}

function taskStatusClass(value) {
  return normalizeTaskStatus(value).replace(/_/g, "-");
}

function normaliseChecklist(value) {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch (err) {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((step, index) => {
      if (typeof step === "string") step = { text: step, done: false };
      if (!step || typeof step !== "object") return null;
      const text = String(step.text || step.title || "").trim();
      if (!text) return null;
      const done = step.done === true || step.done === 1 || String(step.done).toLowerCase() === "true";
      return {
        // Keep legacy steps stable across refreshes instead of generating a new id
        // every time an older checklist is normalised.
        id: String(step.id || `step_${index + 1}`),
        text,
        done,
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function checklistProgress(item) {
  const checklist = normaliseChecklist(item?.checklist);
  const completed = checklist.filter((step) => step.done).length;
  return { total: checklist.length, completed };
}

function isTaskToday(item) {
  if (isArchived(item)) return false;
  const due = item?.dueDate || item?.due_date;
  return !item?.done && (normalizeTaskStatus(item?.status) === "today" || isToday(due));
}

async function changePanelTaskStatus(value) {
  if (currentItemId) await setTaskStatus(currentItemId, value);
}

async function convertCurrentToTask() {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item || item.kind === "task") return;
  const id = item.id;
  item.kind = "task";
  item.status = isTaskToday(item) ? "today" : "planned";
  item.done = false;
  item.completedAt = "";
  item.checklist = normaliseChecklist(item.checklist);
  await dbSaveItem(item);
  closePanel();
  switchView("tasks");
  openPanel(id);
}

async function duplicateCurrentTask() {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item || item.kind !== "task") return;
  const copy = {
    ...item,
    id: cid(),
    ownerId: sbUser || currentUserId || item.ownerId || null,
    title: `${item.title} (copy)`,
    status: isTaskToday(item) ? "today" : "planned",
    checklist: normaliseChecklist(item.checklist).map((step) => ({ ...step, done: false })),
    done: false,
    completedAt: "",
    notified: false,
    notifiedAt: "",
    snoozedUntil: "",
    archivedAt: 0,
    backendEntryId: null,
    backendTaskId: null,
    recurrenceKey: null,
    created: Date.now(),
  };
  state.items.unshift(copy);
  await dbSaveItem(copy);
  closePanel();
  switchView("tasks");
  openPanel(copy.id);
}

function seedData() {
  return {
    items: [],
    events: [],
    projects: [],
    goals: [],
    people: [],
    theme: "light",
  };
}

function cid() {
  return "i_" + Math.random().toString(36).slice(2, 10);
}
/* ---------- Date & time preferences (Settings ▸ Appearance) ----------
   These used to be saved to the profile but nothing read them, so the two
   selects had no visible effect. Every user-facing date/time now goes through
   fmtDate()/fmtTime() so the choices actually apply. */
let dateFormatPref = "MM/DD/YYYY";
let timeFormatPref = "12h";
function applyFormatPrefs(profile) {
  if (profile && profile.date_format) dateFormatPref = profile.date_format;
  if (profile && profile.time_format) timeFormatPref = profile.time_format;
}
function toDate(value) {
  // null/undefined are "no value" (new Date(null) is 1970, which would silently
  // print a real-looking time), and anything unparseable is null too.
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(value) {
  const d = toDate(value);
  if (!d) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: timeFormatPref !== "24h",
  });
}
function fmtDate(value) {
  const d = toDate(value);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear(),
    m = pad(d.getMonth() + 1),
    day = pad(d.getDate());
  if (dateFormatPref === "YYYY-MM-DD") return `${y}-${m}-${day}`;
  if (dateFormatPref === "DD/MM/YYYY") return `${day}/${m}/${y}`;
  return `${m}/${day}/${y}`;
}
function formatDueDisplay(iso) {
  if (!iso) return "";
  const d = new Date(iso),
    now = new Date();
  const timeStr = fmtTime(d);
  if (d.toDateString() === now.toDateString()) return "Today, " + timeStr;
  const tmrw = new Date(now);
  tmrw.setDate(now.getDate() + 1);
  if (d.toDateString() === tmrw.toDateString()) return "Tomorrow, " + timeStr;
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    timeStr
  );
}
/* Steps whole months, clamping to the last valid day of the target month.

   Date#setMonth overflows: 31 January plus one month is 3 March, so a bill due on the 31st would
   quietly start landing in March. Clamping keeps it on the 28th, then the 30th, then the 31st again
   as the months allow, which is what a person means by "the 31st". Shared by monthly and yearly,
   which are the same arithmetic one and twelve times over. */
function addMonthsClamped(date, months) {
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date;
}

function nextOccurrence(iso, recurrence) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  else if (recurrence === "monthly") addMonthsClamped(d, 1);
  // Yearly, for a policy or a domain that renews annually. Without it, "yearly" was a value the
  // capture sheet could offer and the engine could not honour — the option existed and did nothing.
  else if (recurrence === "yearly") addMonthsClamped(d, 12);
  return d.toISOString();
}

function taskRecurrenceKey(item) {
  return item?.recurrenceKey || `series_${item?.id || "unknown"}`;
}

function recurringOccurrenceId(seriesKey, dueDate) {
  const safeSeries = String(seriesKey).replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = new Date(dueDate).getTime();
  return `occ_${safeSeries}_${Number.isFinite(stamp) ? stamp : Date.now()}`;
}
function isToday(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate).toDateString() === new Date().toDateString();
}
function isOverdue(item) {
  return (
    !isArchived(item) &&
    !!item.dueDate &&
    !item.done &&
    new Date(item.dueDate).getTime() < Date.now() &&
    !isToday(item.dueDate)
  );
}
function greetingText() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
const MOTIVATION_QUOTES = [
  "Progress is not about being busy, it's about making things happen.",
  "Small steps taken daily lead to big changes eventually.",
  "You don't need to see the whole staircase, just the next step.",
  "Discipline is choosing between what you want now and what you want most.",
  "Clarity comes from action, not from thinking about it more.",
  "The best time to start was earlier. The next best time is now.",
  "A little progress each day adds up to big results.",
  "Done is better than perfect.",
  "Focus on being productive instead of busy.",
  "Every task you finish makes the next one easier.",
  "What gets captured gets remembered. What gets remembered gets done.",
  "You don't have to be great to start, but you have to start to be great.",
  "Slow progress is still progress.",
  "The secret to getting ahead is getting started.",
  "One task at a time builds momentum.",
  "Consistency beats intensity over time.",
  "A clear list makes for a clear mind.",
  "Your future is built by what you do today, not what you plan for tomorrow.",
  "Action is the antidote to overwhelm.",
  "Organize your intentions and your days will organize themselves.",
];

function getDailyQuoteIndex() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const diff = Date.now() - start.getTime();
  const dayOfYear = Math.floor(diff / 86400000);
  return dayOfYear % MOTIVATION_QUOTES.length;
}

let currentQuoteIndex = null;

function renderQuote() {
  const el = document.getElementById("heroQuoteText");
  if (!el) return;
  if (currentQuoteIndex === null) currentQuoteIndex = getDailyQuoteIndex();
  el.textContent = MOTIVATION_QUOTES[currentQuoteIndex];
  el.style.animation = "none";
  requestAnimationFrame(() => {
    el.style.animation = "quote-arrive 420ms ease both";
  });
}

function shuffleQuote() {
  let next;
  do {
    next = Math.floor(Math.random() * MOTIVATION_QUOTES.length);
  } while (next === currentQuoteIndex && MOTIVATION_QUOTES.length > 1);
  currentQuoteIndex = next;
  renderQuote();
}

async function saveQuoteToMemory(btnEl) {
  const text = MOTIVATION_QUOTES[currentQuoteIndex];
  const newItem = {
    id: cid(),
    kind: "memory",
    title: text,
    sub: "Saved quote",
    priority: "",
    person: "",
    due: "",
    status: "",
    project: "",
    created: Date.now(),
    done: false,
    scope: "private",
  };
  state.items.unshift(newItem);
  await dbSaveItem(newItem);
  if (!btnEl) return;
  const original = btnEl.textContent;
  btnEl.innerHTML = icon("check") + " Saved";
  setTimeout(() => {
    btnEl.textContent = original;
  }, 1500);
}

/* ============================================================
   MULTI-USER DATA LAYER
   Everyone who opens this artifact's link (within the org) shares
   the same live data via the `db` capability. Falls back to
   localStorage (single browser only) if `db` isn't granted.
   ============================================================ */
let db = null;

let currentUserId = null;
let sharedItems = [];
let privateItems = [];

function mergeItems() {
  state.items = [...sharedItems, ...privateItems];
}

async function initMultiUser() {
  db = await window.claude?.use("db");
  const user = await window.claude?.use("user");

  if (user) {
    try {
      const me = await user.me();
      currentUserId = me.id;
      document.getElementById("greeting").textContent =
        `Good morning, ${me.name || "there"}!`;
      const av = document.getElementById("avatarInitial");
      if (av) av.textContent = (me.name || "V").charAt(0).toUpperCase();
    } catch (e) {
      /* no identity available in this view — keep defaults */
    }
  }

  if (!db) {
    // Per-account, not one shared key: readState() resolves the key from sbUser, which is set by
    // the time this runs on the signed-in path. See clearAccountState() for why it has to be.
    state = readState();
    if (!state.projects) state.projects = [];
    if (!state.goals) state.goals = [];
    if (!state.people) state.people = [];
    sharedItems = state.items;
    privateItems = [];
    if (state.theme)
      document.documentElement.setAttribute("data-theme", state.theme);
    // The concept rides in state so it syncs with the account, and in its own key so the head
    // script can apply it before first paint.
    if (state[THEME_STATE_KEY]) document.documentElement.setAttribute("data-concept", state[THEME_STATE_KEY]);
    syncThemeScheme();
    renderAll();
    return;
  }

  const itemsCol = db.collection("items");
  const projCol = db.collection("projects");
  const goalCol = db.collection("goals");
  // People were saved to the shared collection but never subscribed to, so the record reached the
  // database and never came back: not to the person who typed it, and not to anyone else.
  const peopleCol = db.collection("people");

  const existing = await itemsCol.get();
  if (existing.empty) {
    const seed = seedData();
    for (const it of seed.items) await itemsCol.doc(it.id).set(it);
    for (const p of seed.projects) await projCol.doc(p.id).set(p);
    for (const g of seed.goals) await goalCol.doc(g.id).set(g);
    for (const p of seed.people) await peopleCol.doc(p.id).set(p);
  }

  // `people` has to be in this literal, not just in seedData(). renderAll() calls renderPeople(),
  // which maps over state.people, so a state built without the key threw on the very first
  // snapshot and took the whole item render down with it.
  state = { items: [], projects: [], goals: [], people: [], theme: "light" };

  itemsCol.onSnapshot((snap) => {
    sharedItems = snap.docs.map((d) => ({ ...d.data(), scope: "shared" }));
    mergeItems();
    renderAll();
  });
  projCol.onSnapshot((snap) => {
    state.projects = snap.docs.map((d) => d.data());
    renderProjects();
    renderNav();
  });
  goalCol.onSnapshot((snap) => {
    state.goals = snap.docs.map((d) => d.data());
    renderGoals();
    renderReports();
  });
  peopleCol.onSnapshot((snap) => {
    state.people = snap.docs.map((d) => d.data());
    renderPeople();
    renderNav();
  });

  // Per-person private items — only visible to the signed-in viewer who created them
  if (currentUserId) {
    const privateItemsCol = db
      .doc(`data/users/${currentUserId}/profile`)
      .collection("items");
    privateItemsCol.onSnapshot((snap) => {
      privateItems = snap.docs.map((d) => ({ ...d.data(), scope: "private" }));
      mergeItems();
      renderAll();
    });
  }
}

/* Use these instead of save() whenever items/projects/goals are mutated.
   item.scope must be 'shared' (default) or 'private'. */
function itemCollectionFor(item) {
  if (!db) return null;
  if (item.scope === "private" && currentUserId)
    return db.doc(`data/users/${currentUserId}/profile`).collection("items");
  return db.collection("items");
}

function taskStatusFromItem(item) {
  if (!item || item.kind !== "task") return "inbox";
  if (item.done) return "completed";
  return normalizeTaskStatus(item.status, isTaskToday(item) ? "today" : "planned");
}

function buildEntryDraftFromItem(item) {
  const status = item.kind === "task"
    ? taskStatusFromItem(item)
    : item.done
      ? "completed"
      : item.status || "inbox";
  return {
    household_id: currentHouseholdId || null,
    user_id: sbUser || currentUserId || null,
    kind: item.kind || "text",
    source_type: item.sourceType || "manual",
    title: item.title || "",
    description: item.sub || "",
    raw_text: item.rawText || item.title || "",
    status,
    visibility: item.scope === "private" ? "private" : "shared",
    due_at: item.dueDate || null,
    completed_at: item.completedAt ? new Date(item.completedAt).toISOString() : null,
    client_id: item.id,
    metadata: {
      source: "prototype-sync",
      client_id: item.id,
      project: item.project || null,
      person: item.person || null,
      goal: item.goal || null,
      recurrence: item.recurrence || null,
      priority: item.priority || null,
      scope: item.scope || "shared",
      originalKind: item.kind || "text",
      originalId: item.id,
      sourceType: item.sourceType || "manual",
      rawText: item.rawText || item.title || "",
      captureMetadata: normaliseCaptureMetadata(item.captureMetadata),
      captureFingerprint: item.captureFingerprint || null,
      checklist: normaliseChecklist(item.checklist),
      recurrenceKey: item.recurrenceKey || null,
      archivedAt: item.archivedAt || null,
      backendEntryId: item.backendEntryId || null,
      backendTaskId: item.backendTaskId || null,
    },
  };
}

function buildTaskDraftFromItem(item, entryId) {
  if (!entryId || item.kind !== "task") return null;
  return {
    entry_id: entryId,
    household_id: currentHouseholdId || null,
    user_id: sbUser || currentUserId || null,
    title: item.title || "",
    description: item.sub || "",
    status: taskStatusFromItem(item),
    checklist: normaliseChecklist(item.checklist),
    recurrence_key: item.recurrenceKey || null,
    archived_at: item.archivedAt ? new Date(item.archivedAt).toISOString() : null,
    priority: item.priority || "normal",
    due_at: item.dueDate || null,
    start_at: null,
    duration_minutes: null,
    recurrence_rule: item.recurrence || null,
    project_id: null,
    person_id: null,
    // Items match a project, person or goal by name, and the name travels in metadata, so these uuid
    // columns stay null rather than guessing at a backend id.
    goal_id: null,
    completed_at: item.completedAt ? new Date(item.completedAt).toISOString() : null,
    metadata: {
      source: "prototype-sync",
      client_id: item.id,
      originalId: item.id,
      scope: item.scope || "shared",
      sourceType: item.sourceType || "manual",
      rawText: item.rawText || item.title || "",
      captureMetadata: normaliseCaptureMetadata(item.captureMetadata),
      captureFingerprint: item.captureFingerprint || null,
      checklist: normaliseChecklist(item.checklist),
      recurrenceKey: item.recurrenceKey || null,
      goal: item.goal || null,
      archivedAt: item.archivedAt || null,
    },
    client_id: item.id,
  };
}

async function dbSaveItem(item) {
  if (syncReadyPromise) await syncReadyPromise;
  if (!item.scope) item.scope = "shared";
  /* Every mutation funnels through here — create, edit, complete, snooze, recurrence — so
     this is the one place that can stamp the edit time and mark the item as an unsaved
     edit. The merge treats `dirty` as the signal that a local copy is worth protecting;
     without this stamp a good offline edit looks identical to a stale one. */
  const previous = Number(item.updatedAt) || 0;
  item.updatedAt = Math.max(Date.now(), previous + 1);
  item.dirty = true;
  /* Recurrence used to belong to tasks alone, gated on `kind === "task"` in two places, so a
     recurring bill got no series key and never rolled forward — the monthly bill would simply stop
     existing after its first date passed. Bills repeat for exactly the same reason tasks do, so the
     gate is this one predicate instead, and there is a single place that decides what repeats. */
  if (canRepeat(item) && item.recurrence && item.recurrence !== "none" && !item.recurrenceKey) {
    item.recurrenceKey = taskRecurrenceKey(item);
  } else if (canRepeat(item) && (!item.recurrence || item.recurrence === "none")) {
    item.recurrenceKey = null;
  }
  const col = itemCollectionFor(item);
  if (col) {
    await col.doc(item.id).set(item);
  } else if (sbUser) {
    const { error } = await sb.from("items").upsert(itemToRow(item));
    if (error) console.error("Supabase save failed:", error.message);
    queueStructuredItemSync(item);
  } else {
    save();
  }
  // Every mutation funnels through here (create, edit, complete, snooze, recurrence), so
  // this is the single place that keeps the reminder schedule in step with the data.
  refreshReminderSchedule();
  renderAll();
}
async function dbDeleteItem(id, deletedItem = null) {
  if (syncReadyPromise) await syncReadyPromise;
  const item = deletedItem || state.items.find((i) => i.id === id);
  const col = item
    ? itemCollectionFor(item)
    : db
      ? db.collection("items")
      : null;
  if (col) {
    await col.doc(id).delete();
  } else if (sbUser) {
    const { error } = await sb
      .from("items")
      .delete()
      .eq("id", id)
      .eq("household_id", currentHouseholdId);
    if (error) {
      console.error("Supabase delete failed:", error.message);
      return;
    }
    if (item) queueStructuredItemSync(item, "delete");
  } else {
    save();
  }
  if (!col) {
    state.items = state.items.filter((i) => i.id !== id);
    save();
  }
  renderAll();
}
async function dbSaveProject(p) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("projects").doc(p.id).set(p);
  } else if (sbUser) {
    await persistStructuredRecord("project", p);
    save();
    renderProjects();
    renderNav();
  } else {
    save();
    renderProjects();
    renderNav();
  }
}
async function dbSaveGoal(g) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("goals").doc(g.id).set(g);
  } else if (sbUser) {
    await persistStructuredRecord("goal", g);
    save();
    renderGoals();
    renderReports();
  } else {
    save();
    renderGoals();
    renderReports();
  }
}
async function dbSavePerson(p) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("people").doc(p.id).set(p);
  } else if (sbUser) {
    await persistStructuredRecord("person", p);
    save();
    renderPeople();
  } else {
    save();
    renderPeople();
  }
}

/* Per-account local state.

   This was the fixed-string key "everything_state_v1", which every account on the device shared.
   Signing out cleared the Supabase session but left that key exactly as it was, so the next person
   to sign in on a shared phone or tablet inherited the previous person's captures, goals, people
   and projects — and the merge would then push them into the new account. Keying by user id is
   what separates the accounts; wiping the slot on sign-out is what keeps the previous person's
   data off a shared device entirely.

   Both halves are needed. The per-user key alone would still leave the old data sitting in
   localStorage for anyone who later opens devtools on the family tablet. */
const STATE_KEY_PREFIX = "everything_state_v1:";
const ANONYMOUS_STATE_KEY = "everything_state_v1";

function stateStorageKey() {
  return sbUser ? `${STATE_KEY_PREFIX}${sbUser}` : ANONYMOUS_STATE_KEY;
}

function readState() {
  try {
    const raw = localStorage.getItem(stateStorageKey());
    return raw ? JSON.parse(raw) : seedData();
  } catch (e) {
    return seedData();
  }
}

/* Everything the previous account left behind, in one place. Called on sign-out only, and only
   after the sign-out itself has succeeded. */
function clearAccountState() {
  if (sbUser) {
    try {
      localStorage.removeItem(`${STRUCTURED_SYNC_QUEUE_PREFIX}${sbUser}`);
    } catch (err) {
      console.warn("Sign-out could not clear the sync queue:", err.message || err);
    }
  }
  try {
    localStorage.removeItem(stateStorageKey());
  } catch (err) {
    console.warn("Sign-out could not clear local data:", err.message || err);
  }
  // The in-memory copy matters as much as the stored one: it is what the next account would be
  // shown before any load completes, and what the load path would merge from.
  state = seedData();
  sharedItems = state.items;
  privateItems = [];
  doneLog = {};
}

function save() {
  try {
    localStorage.setItem(stateStorageKey(), JSON.stringify(state));
  } catch (e) {
    console.error("save failed", e);
  }
}
function lockPageScroll(locked) {
  if (locked) {
    document.body.classList.add("overlay-open");
    return;
  }
  const hasOpenLayer = document.querySelector(
    ".modal-overlay.open, .ask-overlay.open, #panel.open, #sidebar.open",
  );
  document.body.classList.toggle("overlay-open", !!hasOpenLayer);
}
function resetData() {
  if (db) {
    alert(
      "Reset is disabled in multi-user mode — delete items individually instead.",
    );
    return;
  }
  if (
    !confirm(
      "Reset all local Everything data to the empty demo state?\n\nThis cannot be undone.",
    )
  )
    return;
  state = seedData();

  save();
  renderAll();
}
