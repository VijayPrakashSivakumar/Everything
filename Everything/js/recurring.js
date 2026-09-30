/* ---------- Recurring series ----------
   A series is the set of items sharing one recurrenceKey: the original plus every occurrence
   spawned from it. Recurrence used to advance only when a task was *completed*, so a series whose
   date simply passed — the appointment that came and went, the bill never ticked off that morning —
   stopped existing and nothing brought it back. That is the common case, because most occurrences
   are not consciously completed, they just expire.

   So a series advances two ways now: completing one advances it (createRecurringOccurrence) and
   time passing advances it (rollForwardRecurringSeries). Both build the row through
   createOccurrenceRow, so an occurrence looks the same however it came to exist. */

/* A series ignored for a year would otherwise write 365 rows on one sync. Chasing to the next
   future occurrence and leaving the gap behind is both cheaper and truer: the missed days did not
   happen. The guard is a backstop against a rule that never advances, not a real limit. */
const RECURRENCE_ROLLFORWARD_MAX_STEPS = 400;

function isRecurring(item) {
  return Boolean(
    item && item.recurrence && item.recurrence !== "none" && item.dueDate && !isArchived(item),
  );
}

/* The date this series should next occupy, or "" when there is nothing to do. Advancing from the
   item's own due date is what skips the missed days rather than replaying them. */
function nextFutureOccurrence(item, now) {
  if (!isRecurring(item)) return "";
  let due = item.dueDate;
  let steps = 0;
  while (new Date(due).getTime() <= now && steps < RECURRENCE_ROLLFORWARD_MAX_STEPS) {
    const step = nextOccurrence(due, item.recurrence);
    if (!step) return "";
    due = step;
    steps += 1;
  }
  return new Date(due).getTime() > now ? due : "";
}

/* True when this series already holds an occurrence on or after `iso`. The roll-forward stops as
   soon as it finds one, which is what stops two devices rolling the same series twice. The row being
   rolled *from* is excluded, so its own stale due date cannot count as forward progress. */
function seriesHasOccurrenceOnOrAfter(seriesKey, iso, exceptId) {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return false;
  return state.items.some(
    (candidate) =>
      candidate &&
      candidate.id !== exceptId &&
      taskRecurrenceKey(candidate) === seriesKey &&
      candidate.dueDate &&
      new Date(candidate.dueDate).getTime() >= target,
  );
}

/* One row of a series. Every field the series does not redefine is inherited from the row it came
   from, so a recurring task keeps its project, person, priority and notes for ever. */
function createOccurrenceRow(item, seriesKey, due) {
  const isTask = item.kind === "task";
  return {
    ...item,
    id: recurringOccurrenceId(seriesKey, due),
    recurrenceKey: seriesKey,
    ownerId: sbUser || currentUserId || item.ownerId || null,
    backendEntryId: null,
    backendTaskId: null,
    done: false,
    completedAt: "",
    // Steps belong to one run of the task. Carrying them over as "done" would show a fresh week's
    // chores as already finished, so every step resets.
    checklist: normaliseChecklist(item.checklist).map((step) => ({ ...step, done: false })),
    notified: false,
    notifiedAt: "",
    snoozedUntil: "",
    archivedAt: 0,
    dueDate: due,
    due: formatDueDisplay(due),
    created: Date.now(),
    // Only a task moves between Planned and Today. For an event the status is whatever the capture
    // chose, and forcing it to "planned" would rewrite the person's own filing.
    status: isTask ? (isToday(due) ? "today" : "planned") : item.status,
  };
}

async function createRecurringOccurrence(item) {
  if (!item.done || !isRecurring(item)) return;
  const nextDue = nextOccurrence(item.dueDate, item.recurrence);
  if (!nextDue) return;
  const seriesKey = taskRecurrenceKey(item);
  // Occurrence ids are deterministic, so a retry or a second device converges
  // on the same row instead of creating another copy.
  const alreadyQueued = state.items.some(
    (candidate) =>
      candidate.id === recurringOccurrenceId(seriesKey, nextDue) ||
      (taskRecurrenceKey(candidate) === seriesKey && candidate.dueDate === nextDue),
  );
  if (alreadyQueued) return;
  const next = createOccurrenceRow(item, seriesKey, nextDue);
  state.items.unshift(next);
  await dbSaveItem(next);
}

/* Moves a series whose date has passed on to its next future occurrence, and reports whether it
   wrote anything. The three guards are what make this safe to call on a timer: the sweep only
   considers overdue series, the deterministic id absorbs a retry, and the forward-looking check
   stops a series another device already advanced. */
async function rollForwardRecurring(item) {
  if (item.done || !isRecurring(item)) return false;
  if (new Date(item.dueDate).getTime() > Date.now()) return false;

  const seriesKey = taskRecurrenceKey(item);
  const target = nextFutureOccurrence(item, Date.now());
  if (!target) return false;
  if (seriesHasOccurrenceOnOrAfter(seriesKey, target, item.id)) return false;

  const next = createOccurrenceRow(item, seriesKey, target);
  state.items.unshift(next);
  await dbSaveItem(next);
  return true;
}

let recurringSweepInFlight = false;

/* The sweep, run from the same beats as the reminder check. Debounced to once an hour because
   after the first pass there is nothing left to write, and this rides a check that fires every 30
   seconds. The stamp is per device and survives a reload, so reopening the app does not re-arm it. */
async function rollForwardRecurringSeries() {
  if (recurringSweepInFlight || !state) return;
  const stamp = Date.now();
  let last = 0;
  try {
    last = Number(localStorage.getItem("everything_recurring_sweep_v1") || 0);
  } catch (e) {
    last = 0;
  }
  if (Number.isFinite(last) && stamp - last < 3600000) return;

  const overdue = state.items.filter(
    (item) =>
      item &&
      !item.done &&
      isRecurring(item) &&
      new Date(item.dueDate).getTime() <= Date.now(),
  );
  if (!overdue.length) {
    try {
      localStorage.setItem("everything_recurring_sweep_v1", String(stamp));
    } catch (e) {}
    return;
  }

  recurringSweepInFlight = true;
  let wrote = false;
  try {
    // Sequential on purpose: each roll-forward reads state.items, and the row the previous one just
    // added is what stops the next from rolling the same series again in this same pass.
    for (const item of overdue) {
      if (await rollForwardRecurring(item)) wrote = true;
    }
    if (wrote) {
      save();
      refreshReminderSchedule();
      renderToday();
      renderTasks(activeTaskFilter);
      renderInbox(activeInboxFilter);
    }
  } finally {
    recurringSweepInFlight = false;
    try {
      localStorage.setItem("everything_recurring_sweep_v1", String(stamp));
    } catch (e) {}
  }
}

async function completeTask(item) {
  if (!item || item.done) return;
  item.done = true;
  item.completedAt = Date.now();
  item.status = "completed";
  logCompletion(item.id, true);
  await dbSaveItem(item);
  await createRecurringOccurrence(item);
}

async function reopenTask(item) {
  if (!item || !item.done) return;
  item.done = false;
  item.completedAt = "";
  item.status = isTaskToday(item) ? "today" : "in_progress";
  item.notified = false;
  item.notifiedAt = "";
  item.snoozedUntil = "";
  forgetNotified(item.id);
  logCompletion(item.id, false);
  await dbSaveItem(item);
}

async function setTaskStatus(id, value) {
  if (taskMutationInFlight.has(id)) return;
  const item = state.items.find((i) => i.id === id);
  if (!item || item.kind !== "task" || isArchived(item)) return;
  taskMutationInFlight.add(id);
  try {
    const nextStatus = normalizeTaskStatus(value, taskStatusFromItem(item));
    if (nextStatus === "completed") {
      await completeTask(item);
    } else {
      if (item.done) {
        item.done = false;
        item.completedAt = "";
        item.notified = false;
        item.notifiedAt = "";
        item.snoozedUntil = "";
        forgetNotified(item.id);
        logCompletion(item.id, false);
      }
      item.status = nextStatus;
      await dbSaveItem(item);
    }
  } finally {
    taskMutationInFlight.delete(id);
  }
  if (currentItemId === id && document.getElementById("panel")?.classList.contains("open")) openPanel(id);
}

async function toggleDone(id) {
  if (taskMutationInFlight.has(id)) return;
  const item = state.items.find((i) => i.id === id);
  if (!item || isArchived(item)) return;
  taskMutationInFlight.add(id);
  try {
    if (item.kind === "task") {
      if (item.done) await reopenTask(item);
      else await completeTask(item);
    } else {
      item.done = !item.done;
      item.completedAt = item.done ? Date.now() : "";
      item.status = item.done ? "completed" : item.status || "inbox";
      logCompletion(item.id, item.done);
      await dbSaveItem(item);
    }
  } finally {
    taskMutationInFlight.delete(id);
  }
  if (currentItemId === id && document.getElementById("panel")?.classList.contains("open")) openPanel(id);
}

let activeInboxFilter = "all";

function renderInbox(filter) {
  filter = filter || activeInboxFilter || "all";
  activeInboxFilter = filter;
  // A selection made in the Tasks list must not follow the person into the Inbox, where the rows
  // look the same and a bulk action would hit records they never saw.
  if (bulkScope !== "inbox" && (selectMode || bulkSelection.size)) {
    bulkSelection = new Set();
    selectMode = false;
  }
  const tabs = [
    ["all", "All"],
    ["text", "Text"],
    ["voice", "Voice"],
    ["image", "Images"],
    ["file", "Files"],
    ["link", "Links"],
    ["waiting", "Waiting"],
    ["openloop", "Open loops"],
  ];
  const tabRow = document.getElementById("inboxTabs");
  tabRow.innerHTML = tabs
    .map(
      ([id, label]) =>
        `<div class="tab ${id === filter ? "active" : ""}" onclick="renderInbox(${jsStr(id)})">${label}</div>`,
    )
    .join("");
  const searchInput = document.getElementById("inboxSearchInput");
  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const list = document.getElementById("inboxList");
  list.innerHTML = "";
  const textKinds = ["task", "event", "memory", "waiting", "openloop"];
  const items = [...state.items]
    .filter((i) => !isArchived(i))
    .sort((a, b) => b.created - a.created)
    .filter((i) => {
      if (filter === "text") {
        if (!textKinds.includes(i.kind)) return false;
      } else if (filter !== "all" && i.kind !== filter) return false;
      if (!query) return true;
      return (
        i.title +
        " " +
        (i.sub || "") +
        " " +
        (i.person || "") +
        " " +
        (i.project || "")
      )
        .toLowerCase()
        .includes(query);
    });
  if (!items.length) {
    list.innerHTML = query
      ? '<p class="empty">Nothing matches that filter.</p>'
      : '<p class="empty">Nothing here yet.</p>';
    mountInboxBulkBar();
    renderBulkBar();
    return;
  }
  mountInboxBulkBar();
  // The Inbox is swipeable and the Tasks list is reorderable — never both on the same row. The
  // split is by list, not by device, so the two never compete even on a desktop with a mouse.
  items.forEach((item) => list.appendChild(taskRow(item, { swipeable: true })));
  // The Inbox swipes and never reorders, so it binds the swipe gesture directly rather than
  // calling enableListReordering — which it does not want, and which is what left swipeable rows
  // with no handler at all when the gesture binder lived inside it.
  bindRowGestures(list, ".task-row.swipeable", null);
  renderBulkBar();
}

let activeTaskFilter = "all";

function renderTasks(filter) {
  const tabs = [
    ["all", "All"],
    ["today", "Today"],
    ["planned", "Planned"],
    ["in_progress", "In progress"],
    ["waiting", "Waiting"],
    ["someday", "Someday"],
    ["priority", "Priority"],
    ["overdue", "Overdue"],
    ["upcoming", "Upcoming"],
    ["completed", "Completed"],
    ["archived", "Archived"],
  ];
  const requestedFilter = filter || activeTaskFilter || "all";
  filter = tabs.some(([id]) => id === requestedFilter) ? requestedFilter : "all";
  activeTaskFilter = filter;
  const tabRow = document.getElementById("taskTabs");
  if (tabRow) {
    tabRow.innerHTML = tabs
      .map(
        ([id, label]) =>
          `<div class="tab ${id === filter ? "active" : ""}" onclick="renderTasks(${jsStr(id)})">${label}</div>`,
      )
      .join("");
  }

  const list = document.getElementById("tasksList");
  let tasks = state.items.filter((i) => i.kind === "task");

  if (filter === "archived") tasks = tasks.filter((i) => isArchived(i));
  else tasks = tasks.filter((i) => !isArchived(i));
  if (filter === "archived") {
    // Keep both open and completed tasks visible in the archive.
  } else if (filter === "today")
    tasks = tasks.filter((i) => isTaskToday(i));
  else if (filter === "planned")
    tasks = tasks.filter((i) => !i.done && taskStatusFromItem(i) === "planned");
  else if (filter === "in_progress")
    tasks = tasks.filter((i) => !i.done && taskStatusFromItem(i) === "in_progress");
  else if (filter === "waiting")
    tasks = tasks.filter((i) => !i.done && taskStatusFromItem(i) === "waiting");
  else if (filter === "someday")
    tasks = tasks.filter((i) => !i.done && taskStatusFromItem(i) === "someday");
  else if (filter === "priority")
    tasks = tasks.filter((i) => !i.done && taskPriorityRank(i) < 4);
  else if (filter === "overdue") tasks = tasks.filter((i) => isOverdue(i));
  else if (filter === "upcoming")
    tasks = tasks.filter(
      (i) => !i.done && i.dueDate && !isToday(i.dueDate) && !isOverdue(i),
    );
  else if (filter === "completed") tasks = tasks.filter((i) => i.done);
  else tasks = tasks.filter((i) => !i.done);

  tasks.sort((a, b) => {
    if (filter === "archived") return (b.archivedAt || 0) - (a.archivedAt || 0);
    if (filter === "priority") {
      const priorityDiff = taskPriorityRank(a) - taskPriorityRank(b);
      if (priorityDiff) return priorityDiff;
    }
    if (a.dueDate && b.dueDate)
      return new Date(a.dueDate) - new Date(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    const priorityDiff = taskPriorityRank(a) - taskPriorityRank(b);
    if (priorityDiff) return priorityDiff;
    return b.created - a.created;
  });

  list.innerHTML = "";
  if (!tasks.length) {
    const emptyMsgs = {
      all: "No open tasks — nice work.",
      today: "Nothing due today.",
      planned: "No planned tasks yet.",
      in_progress: "Nothing in progress.",
      waiting: "Nothing is waiting.",
      someday: "Nothing on the someday list.",
      priority: "No prioritised tasks yet.",
      overdue: "Nothing overdue.",
      upcoming: "No upcoming tasks scheduled.",
      completed: "Nothing completed yet.",
      archived: "No archived tasks.",
    };
    list.innerHTML = `<p class="empty">${emptyMsgs[filter] || "No tasks yet. Capture one!"}</p>`;
    return;
  }
  if (taskListReorderable(filter)) {
    const ordered = sortTasksByStoredOrder(tasks);
    if (ordered !== tasks) tasks = ordered;
    tasks.forEach((t) => list.appendChild(taskRow(t, { reorderable: true })));
    // The stored order is applied as the final sort rather than a DOM shuffle: a shuffle is undone
    // by the next render, and two different filters would disagree about where a row belongs.
    enableListReordering(list, { itemSelector: ".task-row.reorderable", orderKey: TASK_ORDER_KEY });
  } else {
    tasks.forEach((t) => list.appendChild(taskRow(t)));
  }
  renderBulkBar();
}

/* The same row shape Memory uses, so a document is recognisable as a saved thing rather than as a
   special case. `doc-chip` carries the bucket so the styling can colour it without a second lookup. */
function documentRow(item) {
  const meta = [documentTypeLabel(item), item.issuer, item.docNumber].filter(Boolean).join(" · ");
  return `<div class="task-row" onclick="openPanel(${jsStr(item.id)})">
    <div class="task-meta">
      <div class="task-title">${item.scope === "private" ? icon("lock") + " " : ""}${escapeHtml(item.title)}</div>
      <div class="task-sub">${escapeHtml(meta)}${item.person ? " · " + icon("user") + " " + escapeHtml(item.person) : ""}</div>
    </div>
    <span class="doc-chip ${documentBucketClass(item)}">${escapeHtml(documentLabel(item))}</span>
  </div>`;
}

/* Grouped by how soon the expiry bites, not by when it was captured. A person opening Documents is
   asking "what is about to lapse?", and answering that with a reverse-chronological list of things
   filed six months ago is the one ordering that cannot answer it. */
function expenseRow(item) {
  const money = moneyOf(item);
  const when = expenseSpentOn(item);
  const category = moneyCategoryLabel(money.category);
  return `<div class="task-row" onclick="openPanel(${jsStr(item.id)})">
    <div class="task-meta">
      <div class="task-title">${escapeHtml(item.title || category || "Expense")}</div>
      <div class="task-sub">${escapeHtml([category, money.merchant, fmtDate(when)].filter(Boolean).join(" · "))}</div>
    </div>
    <span class="money-amount">${escapeHtml(formatMoney(money.amountMinor) || "—")}</span>
  </div>`;
}

/* The Money view. Phase 1 is deliberately read-only — a total, a category breakdown and the list.

   There is no editing and no charts here, and that is the point: the part that is easy to get
   subtly wrong (an amount, a currency, a month boundary) is done and tested before anything is
   built on top of it. */
function billRow(item) {
  const money = moneyOf(item);
  return `<div class="task-row" onclick="openPanel(${jsStr(item.id)})">
    <div class="task-meta">
      <div class="task-title">${escapeHtml(item.title || billLabel(item))}</div>
      <div class="task-sub">${escapeHtml([billLabel(item), money.merchant, billLabelFor(item)].filter(Boolean).join(" · "))}</div>
    </div>
    <span class="money-amount">${escapeHtml(formatMoney(money.amountMinor) || "—")}</span>
  </div>`;
}

function renderMoney() {
  const listEl = document.getElementById("moneyList");
  if (!listEl) return;
  const thisMonth = expensesThisMonth();
  const total = sumMoney(thisMonth);
  const byCategory = expensesByCategory();

  const monthLabel = document.getElementById("moneyMonthLabel");
  if (monthLabel) {
    monthLabel.textContent = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  const statsEl = document.getElementById("moneyStats");
  if (statsEl) {
    statsEl.innerHTML = [
      { label: "Spent this month", value: formatMoney(total) || `${MONEY_SYMBOL}0` },
      { label: "Every month", value: formatMoney(monthlyRecurringCost()) || `${MONEY_SYMBOL}0` },
      { label: "Due soon", value: String(billsDueSoon().length) },
    ]
      .map(
        (stat) =>
          `<div class="stat"><div class="stat-value">${escapeHtml(stat.value)}</div><div class="stat-label">${escapeHtml(stat.label)}</div></div>`,
      )
      .join("");
  }

  // Due soon. Hidden rather than empty, for the same reason the birthdays card is: a permanently
  // empty "nothing is due" box teaches nothing and takes the room a real one needs.
  const billsCard = document.getElementById("moneyBillsCard");
  const billsHost = document.getElementById("moneyBills");
  const dueSoon = billsDueSoon();
  if (billsCard && billsHost) {
    billsCard.hidden = !dueSoon.length;
    if (dueSoon.length) {
      const label = document.getElementById("moneyBillsLabel");
      if (label) label.textContent = `next ${BILL_DUE_SOON_DAYS} days`;
      billsHost.innerHTML = dueSoon.map(billRow).join("");
    }
  }

  // Subscriptions, each with what it costs per month rather than what it was billed at, so a yearly
  // charge sits next to a monthly one on the same footing.
  const subsCard = document.getElementById("moneySubsCard");
  const subsHost = document.getElementById("moneySubs");
  const subs = subscriptions();
  if (subsCard && subsHost) {
    subsCard.hidden = !subs.length;
    if (subs.length) {
      const label = document.getElementById("moneySubsLabel");
      if (label) label.textContent = `${formatMoney(monthlyRecurringCost())} a month`;
      subsHost.innerHTML = subs
        .map((item) => {
          const money = moneyOf(item);
          const perMonth =
            item.recurrence === "yearly" ? Math.round((money.amountMinor || 0) / 12) : money.amountMinor;
          return `<div class="task-row" onclick="openPanel(${jsStr(item.id)})">
            <div class="task-meta">
              <div class="task-title">${escapeHtml(item.title || "Subscription")}</div>
              <div class="task-sub">${escapeHtml(
                [money.merchant, billLabelFor(item), item.recurrence === "yearly" ? "yearly" : "monthly"]
                  .filter(Boolean)
                  .join(" · "),
              )}</div>
            </div>
            <span class="money-amount">${escapeHtml(formatMoney(perMonth) || "—")}<span class="money-per">/mo</span></span>
          </div>`;
        })
        .join("");
    }
  }

  const categoriesEl = document.getElementById("moneyCategories");
  if (categoriesEl) {
    // A bar scaled against the biggest category, so the shape of the month is readable at a glance
    // without a chart library. `width` is a number this module computed, never a captured value.
    const max = byCategory.reduce((peak, bucket) => Math.max(peak, bucket.total), 0);
    categoriesEl.innerHTML = byCategory.length
      ? byCategory
          .map(
            (bucket) => `<div class="money-cat-row">
              <div class="money-cat-head">
                <span>${escapeHtml(moneyCategoryLabel(bucket.id) || bucket.id)}</span>
                <span>${escapeHtml(formatMoney(bucket.total))}</span>
              </div>
              <div class="money-cat-bar"><div class="money-cat-fill" style="width:${max ? Math.round((bucket.total / max) * 100) : 0}%"></div></div>
            </div>`,
          )
          .join("")
      : `<p class="empty">Nothing recorded this month yet.</p>`;
  }

  // Money owed. A debt is neither spending nor a bill, so without its own section the only trace of
  // "Ravi owes me ₹500" is one line on Today and a running total nobody can build.
  const owedCard = document.getElementById("moneyOwedCard");
  const owedHost = document.getElementById("moneyOwed");
  const owed = outstandingMoneyOwed();
  if (owedCard && owedHost) {
    owedCard.hidden = !owed.length;
    if (owed.length) {
      const incoming = owed.filter((e) => e.owed.direction === "in");
      const outgoing = owed.filter((e) => e.owed.direction !== "in");
      const sumOf = (list) => list.reduce((total, entry) => total + entry.owed.amountMinor, 0);
      const label = document.getElementById("moneyOwedLabel");
      if (label) {
        const parts = [];
        if (incoming.length) parts.push(`${formatMoney(sumOf(incoming))} owed to you`);
        if (outgoing.length) parts.push(`${formatMoney(sumOf(outgoing))} you owe`);
        label.textContent = parts.join(" · ");
      }
      // The two directions are separated by a heading and never added together: ₹500 coming back and
      // ₹500 going out are two facts, and a single net figure would hide both.
      owedHost.innerHTML = ["in", "out"]
        .map((direction) => {
          const list = owed.filter((e) => (e.owed.direction === "in") === (direction === "in"));
          if (!list.length) return "";
          return `<div class="money-owed-group">
            <p class="money-owed-head">${direction === "in" ? "Owed to you" : "You owe"}</p>
            ${list
              .map(
                ({ item, owed: money }) => `<div class="task-row" onclick="openPanel(${jsStr(item.id)})">
                <div class="task-meta">
                  <div class="task-title">${escapeHtml(item.person || item.title || "Someone")}</div>
                  <div class="task-sub">${escapeHtml(item.title && item.person ? item.title : "")}</div>
                </div>
                <span class="money-amount">${escapeHtml(formatMoney(money.amountMinor))}</span>
              </div>`,
              )
              .join("")}
          </div>`;
        })
        .join("");
    }
  }

  const searchInput = document.getElementById("moneySearchInput");
  const query = searchInput ? searchInput.value.trim() : "";
  const all = expenseItems();
  const matched = query ? searchMatches(query).filter((i) => isExpense(i) && !isArchived(i)) : all;
  const sorted = [...matched].sort((a, b) => String(expenseSpentOn(b)).localeCompare(String(expenseSpentOn(a))) || (b.created || 0) - (a.created || 0));

  listEl.innerHTML = sorted.length
    ? sorted.slice(0, 50).map(expenseRow).join("")
    : `<p class="empty">${
        query ? "No expenses match that search." : "No expenses yet. Capture one to start tracking."
      }</p>`;
}

function renderDocuments() {
  const container = document.getElementById("documentsList");
  if (!container) return;
  const searchInput = document.getElementById("documentsSearchInput");
  const query = searchInput ? searchInput.value.trim() : "";

  const all = documentItems();
  // searchMatches is the shared matcher, so a document is found the same way in the header search,
  // in Ask, and here. Searching "warranty" has to reach a document whose title is "Sony TV".
  const matched = query ? searchMatches(query).filter((i) => isDocument(i) && !isArchived(i)) : all;

  if (!matched.length) {
    container.innerHTML = `<div class="card"><p class="empty">${
      query ? "No documents match that search." : "No documents yet. Capture one to keep track of it."
    }</p></div>`;
    return;
  }

  const groups = new Map();
  DOCUMENT_BUCKETS.forEach((bucket) => groups.set(bucket.id, []));
  matched.forEach((item) => {
    const bucket = documentBucket(item);
    groups.get(bucket).push(item);
  });

  container.innerHTML = DOCUMENT_BUCKETS.map((bucket) => {
    const items = groups.get(bucket.id);
    // An empty group is left out entirely rather than shown as an empty heading.
    if (!items.length) return "";
    // Within a bucket, soonest expiry first, and then newest first — the two orders a person
    // actually wants, and the tie-break has to be stable or rows would shuffle on every render.
    items.sort((a, b) => {
      const byExpiry = String(a.expiresOn || "9999").localeCompare(String(b.expiresOn || "9999"));
      if (byExpiry) return byExpiry;
      return (b.created || 0) - (a.created || 0);
    });
    return `<div class="card">
      <div class="card-head"><h3>${icon(bucket.icon)} ${escapeHtml(bucket.label)} <span class="count">${items.length}</span></h3></div>
      <div>${items.map(documentRow).join("")}</div>
    </div>`;
  }).join("");
}

function renderMemory() {
  const container = document.getElementById("memoryGrouped");
  if (!container) return;
  const searchInput = document.getElementById("memorySearchInput");
  // Uses the shared search engine so Memory matches the same way as the header search and Ask.
  // It used to carry its own copy of the old title+sub+person substring test, which is why
  // searching for part of a word or a person's name found nothing here.
  const query = searchInput ? searchInput.value.trim() : "";
  const ranked = query ? searchMatches(query) : [];
  const mem = (query
    ? ranked.filter((i) => i.kind === "memory")
    : state.items.filter((i) => i.kind === "memory" && !isArchived(i))
  ).sort((a, b) => b.created - a.created);

  if (!mem.length) {
    container.innerHTML = `<div class="card"><p class="empty">${query ? "No memories match that search." : "No memories captured yet."}</p></div>`;
    return;
  }

  const groups = {};
  const now = new Date();
  mem.forEach((item) => {
    const d = new Date(item.created);
    let label;
    if (d.toDateString() === now.toDateString()) label = "Today";
    else {
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) label = "Yesterday";
      else
        label = d.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        });
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  });

  container.innerHTML = Object.entries(groups)
    .map(
      ([label, items]) => `
    <div class="card">
      <div class="card-head"><h3>${label}</h3></div>
      <div>${items
        .map(
          (i) => `<div class="task-row" onclick="openPanel(${jsStr(i.id)})">
        <div class="task-meta"><div class="task-title">${i.scope === "private" ? icon("lock") + " " : ""}${escapeHtml(i.title)}</div>
        <div class="task-sub">${timeAgo(i.created)}${i.person ? " · " + icon("user") + " " + escapeHtml(i.person) : ""}</div></div>
      </div>`,
        )
        .join("")}</div>
    </div>`,
    )
    .join("");
}

/* Person and project names are free text, so "Ravi", "ravi" and "RAVI" are the same person. These
   were matched with ===, so a case difference looked like a different person: the People list showed
   0 linked items while the duplicate check — already case-insensitive — refused the name again.
   Empty never matches, including empty against empty. */
const sameName = (a, b) => {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  return x !== "" && x === y;
};

/* Inbox and Memory both filter through searchMatches so all three search the same way. People
   needs its own match because a contact is found by phone number or email as often as by name,
   and searchMatches scores items — it has no notion of a person's number.

   The list also mixes two different kinds of person: real records, and names inferred from tasks
   that merely mention someone. They were visually identical, which made the inferred ones look
   like contacts you could edit — but they have no record, so a phone number typed against one
   went nowhere. They are now labelled, and the inferred ones can be promoted into a real record. */
function personMatchesQuery(person, needle) {
  return [person.name, person.phone, person.email, person.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function renderPeople() {
  const el = document.getElementById("peopleList");
  if (!el) return;
  // The Coming up card is derived from people, so a birthday typed here has to be able to appear
  // there without a reload. Cheap: it re-reads a handful of records.
  renderUpcomingDates();
  const searchInput = document.getElementById("peopleSearchInput");
  const query = (searchInput ? searchInput.value : "").trim().toLowerCase();
  const namesFromItems = [
    ...new Set(state.items.filter((i) => i.person && !isArchived(i)).map((i) => i.person)),
  ];
  const knownNames = state.people.map((p) => p.name);
  const inferredOnly = namesFromItems.filter((n) => !knownNames.some((k) => sameName(k, n)));

  let rows = [
    ...state.people.map((p) => ({
      id: p.id,
      name: p.name,
      notes: p.notes || "",
      contact: [p.phone, p.email, p.birthday].some(Boolean),
      real: true,
      phone: p.phone || "",
      email: p.email || "",
    })),
    ...inferredOnly.map((n) => ({ id: null, name: n, notes: "", contact: false, real: false, phone: "", email: "" })),
  ];

  if (query) {
    const before = rows.length;
    rows = rows.filter((p) => personMatchesQuery(p, query));
    const note = document.getElementById("peopleSearchNote");
    if (note) {
      note.innerHTML = rows.length
        ? `<p style="font-size:12.5px;color:var(--muted);margin:0 0 10px">${rows.length} of ${before} shown</p>`
        : '<p class="empty" style="margin:0 0 10px">Nobody matches that.</p>';
    }
  } else {
    const note = document.getElementById("peopleSearchNote");
    if (note) note.innerHTML = "";
  }

  if (!rows.length) {
    el.innerHTML = query
      ? '<p class="empty">Nobody matches that.</p>'
      : '<p class="empty">No people yet — add one above or tag someone on a task.</p>';
    return;
  }

  el.innerHTML = rows
    .map((p) => {
      const count = state.items.filter((i) => sameName(i.person, p.name) && !isArchived(i)).length;
      const detail = [
        `${count} linked item${count !== 1 ? "s" : ""}`,
        p.notes ? "has notes" : "",
        p.contact ? "has contact details" : "",
      ].filter(Boolean).join(" · ");
      return `<div class="task-row" onclick="openPersonModal(${p.id ? jsStr(p.id) : "null"}, ${jsStr(p.name)})">
      <div class="avatar" style="width:32px;height:32px;font-size:12px;">${escapeHtml(p.name.charAt(0).toUpperCase())}</div>
      <div class="task-meta"><div class="task-title">${escapeHtml(p.name)}</div><div class="task-sub">${escapeHtml(detail)}</div></div>
      ${p.real ? "" : `<span class="badge medium" style="white-space:nowrap">From a task</span>`}
      <button
        class="btn"
        style="padding:4px 10px;font-size:12px;white-space:nowrap"
        title="Save their number and notes"
        onclick="event.stopPropagation();promotePerson(${jsStr(p.name)})"
      >Save contact</button>
    </div>`;
    })
    .join("");
}

/* An inferred name becomes a real record, so the notes and phone number typed into the profile
   have somewhere to live. Without this, "Priya" could be tagged on twenty tasks and still never
   become a contact you could look up. */
async function promotePerson(name) {
  if (state.people.some((p) => sameName(p.name, name))) {
    openPersonModal(null, name);
    return;
  }
  const person = { id: cid(), name, notes: "", created: Date.now() };
  state.people.unshift(person);
  await dbSavePerson(person);
  renderAll();
  openPersonModal(person.id, person.name);
}
let currentPersonName = null;
function openPersonModal(id, name) {
  currentPersonName = name;
  const person = state.people.find((p) => sameName(p.name, name));
  document.getElementById("personModalName").textContent = name;
  fillPersonProfile(person);
  fillMergeTargets(name);
  document.getElementById("personNotes").value = person
    ? person.notes || ""
    : "";
  const items = state.items.filter((i) => sameName(i.person, name) && !isArchived(i));
  const list = document.getElementById("personItemsList");
  list.innerHTML = items.length
    ? items
        .map(
          (i) =>
            `<div class="task-row" onclick="closePersonModal();openPanel(${jsStr(i.id)})"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? icon("check") : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`,
        )
        .join("")
    : '<p class="empty">No linked items yet.</p>';
  document.getElementById("personModal").classList.add("open");
  lockPageScroll(true);
}
function closePersonModal() {
  document.getElementById("personModal").classList.remove("open");
  currentPersonName = null;
  if (!document.querySelector(".modal-overlay.open, .ask-overlay.open, #panel.open"))
    lockPageScroll(false);
}
/* Contact details are extra fields on the person record. The people table has only name/notes, so
   they travel inside its metadata column (already jsonb) — see buildStructuredRecordPayload. */
function readPersonProfile() {
  const read = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  };
  return { phone: read("personPhone"), email: read("personEmail"), birthday: read("personBirthday") };
}

function fillPersonProfile(person) {
  ["phone", "email", "birthday"].forEach((field) => {
    const el = document.getElementById(`person${field.charAt(0).toUpperCase()}${field.slice(1)}`);
    if (el) el.value = person && person[field] ? person[field] : "";
  });
}

/* A name is free text, so the list can hold two rows for one human. Offer every other person as a
   merge target. Built with the DOM API so a name containing a quote cannot break the option. */
function fillMergeTargets(name) {
  const select = document.getElementById("personMergeTarget");
  if (!select) return;
  const option = (value, label) => {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    return el;
  };
  const others = state.people.filter((p) => !sameName(p.name, name));
  select.textContent = "";
  if (others.length) others.forEach((p) => select.append(option(p.name, p.name)));
  else select.append(option("", "No other people yet"));
}

async function savePersonNotes() {
  if (!currentPersonName) return;
  let person = state.people.find((p) => sameName(p.name, currentPersonName));
  const notes = document.getElementById("personNotes").value.trim();
  const profile = readPersonProfile();
  if (!person) {
    person = { id: cid(), name: currentPersonName, notes, created: Date.now(), ...profile };
    state.people.unshift(person);
  } else {
    person.notes = notes;
    Object.assign(person, profile);
  }
  await dbSavePerson(person);
  closePersonModal();
}

async function addPersonManual() {
  const input = document.getElementById("newPersonInput");
  const name = input.value.trim();
  if (!name) return;
  if (state.people.some((p) => sameName(p.name, name))) {
    input.value = "";
    return;
  }
  const p = { id: cid(), name, notes: "", created: Date.now() };
  state.people.unshift(p);
  input.value = "";
  await dbSavePerson(p);
}
