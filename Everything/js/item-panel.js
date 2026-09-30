/* ---------- Task detail panel ---------- */
function renderChecklist(item) {
  const container = document.getElementById("panelChecklist");
  const progressEl = document.getElementById("checklistProgress");
  if (!container || !progressEl) return;
  const archived = isArchived(item);
  document.getElementById("checklistInput").disabled = archived;
  document.getElementById("checklistAddBtn").disabled = archived;
  const checklist = normaliseChecklist(item?.checklist);
  const progress = checklistProgress(item);
  progressEl.textContent = progress.total ? `${progress.completed}/${progress.total}` : "0/0";
  container.innerHTML = "";
  if (!checklist.length) {
    const empty = document.createElement("p");
    empty.className = "empty checklist-empty";
    empty.textContent = "No steps yet. Add the first one below.";
    container.appendChild(empty);
    return;
  }
  checklist.forEach((step, index) => {
    const row = document.createElement("div");
    row.className = "checklist-row" + (step.done ? " done" : "");
    const check = document.createElement("button");
    check.type = "button";
    check.className = "checklist-toggle" + (step.done ? " checked" : "");
    check.setAttribute("aria-label", step.done ? "Mark step incomplete" : "Mark step complete");
    check.disabled = archived;
    check.innerHTML = step.done ? icon("check") : "";
    check.onclick = () => toggleChecklistItem(item.id, index);
    const text = document.createElement("span");
    text.className = "checklist-text";
    text.textContent = step.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "checklist-remove";
    remove.setAttribute("aria-label", `Remove ${step.text}`);
    remove.disabled = archived;
    remove.innerHTML = icon("x");
    remove.onclick = () => removeChecklistItem(item.id, index);
    row.append(check, text, remove);
    container.appendChild(row);
  });
}

function refreshTaskPanel(item) {
  if (!item) return;
  renderChecklist(item);
  const statusSelect = document.getElementById("panelStatusSelect");
  if (statusSelect) statusSelect.value = taskStatusFromItem(item);
}

async function addChecklistItem() {
  const item = state.items.find((i) => i.id === currentItemId);
  const input = document.getElementById("checklistInput");
  if (!item || item.kind !== "task" || isArchived(item) || !input) return;
  if (taskMutationInFlight.has(item.id)) return;
  const text = input.value.trim();
  if (!text) return;
  const checklist = normaliseChecklist(item.checklist);
  if (checklist.length >= 100) return;
  taskMutationInFlight.add(item.id);
  try {
    checklist.push({
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text,
      done: false,
    });
    item.checklist = checklist;
    input.value = "";
    await dbSaveItem(item);
    refreshTaskPanel(item);
    input.focus();
  } finally {
    taskMutationInFlight.delete(item.id);
  }
}

async function toggleChecklistItem(itemId, index) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || item.kind !== "task" || isArchived(item) || taskMutationInFlight.has(itemId)) return;
  const checklist = normaliseChecklist(item.checklist);
  if (!checklist[index]) return;
  taskMutationInFlight.add(itemId);
  try {
    checklist[index].done = !checklist[index].done;
    item.checklist = checklist;
    await dbSaveItem(item);
    refreshTaskPanel(item);
  } finally {
    taskMutationInFlight.delete(itemId);
  }
}

async function removeChecklistItem(itemId, index) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || item.kind !== "task" || isArchived(item) || taskMutationInFlight.has(itemId)) return;
  const checklist = normaliseChecklist(item.checklist);
  if (!checklist[index]) return;
  taskMutationInFlight.add(itemId);
  try {
    checklist.splice(index, 1);
    item.checklist = checklist;
    await dbSaveItem(item);
    refreshTaskPanel(item);
  } finally {
    taskMutationInFlight.delete(itemId);
  }
}

function openPanel(id) {
  currentItemId = id;
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const isTask = item.kind === "task";
  const status = isTask ? taskStatusFromItem(item) : "";
  lockPageScroll(true);
  document.getElementById("panelTitle").textContent = item.title;
  document.getElementById("panelDesc").textContent = item.sub || "";
  document.getElementById("panelType").textContent =
    item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
  document.getElementById("panelDue").textContent = item.due || "—";
  document.getElementById("panelPerson").textContent = item.person || "—";
  document.getElementById("panelProject").textContent = item.project || "—";
  document.getElementById("panelGoal").textContent = item.goal || "—";
  document.getElementById("panelPriority").textContent = item.priority
    ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1)
    : "—";
  if (isArchived(item)) {
    document.getElementById("panelStatus").textContent = "Archived";
  } else {
    document.getElementById("panelStatus").textContent = item.done
      ? "Complete" +
        (completedWhen(item) ? " · " + timeAgo(completedWhen(item)) : "")
      : isTask
        ? taskStatusLabel(status)
        : item.status || "Open";
  }
  document.getElementById("panelVisibility").innerHTML =
    item.scope === "private"
      ? icon("lock") + " Private (only you)"
      : icon("globe") + " Shared";
  document.getElementById("panelCreated").textContent = new Date(
    item.created,
  ).toLocaleString();

  const taskStatusRow = document.getElementById("panelTaskStatusRow");
  const taskWorkflow = document.getElementById("panelTaskWorkflow");
  const statusSelect = document.getElementById("panelStatusSelect");
  taskStatusRow.hidden = !isTask;
  taskWorkflow.hidden = !isTask;
  if (isTask) {
    statusSelect.value = status;
    renderChecklist(item);
  } else {
    const checklist = document.getElementById("panelChecklist");
    const progress = document.getElementById("checklistProgress");
    const input = document.getElementById("checklistInput");
    if (checklist) checklist.innerHTML = "";
    if (progress) progress.textContent = "0/0";
    if (input) input.value = "";
  }

  document.getElementById("panelConvertBtn").hidden = isTask;
  document.getElementById("panelDuplicateBtn").hidden = !isTask;
  const archiveBtn = document.getElementById("panelArchiveBtn");
  const completeBtn = document.getElementById("panelCompleteBtn");
  const snoozePanel = document.getElementById("panelSnooze");
  const archived = isArchived(item);
  archiveBtn.hidden = !isTask;
  archiveBtn.innerHTML = `${icon(archived ? "archive-restore" : "archive")}<span id="panelArchiveLabel">${archived ? "Restore" : "Archive"}</span>`;
  document.getElementById("panelEditBtn").hidden = archived;
  completeBtn.hidden = archived;
  snoozePanel.hidden = archived;
  statusSelect.disabled = archived || !isTask;
  const completeLabel = document.getElementById("panelCompleteLabel");
  if (completeLabel) completeLabel.textContent = item.done ? "Reopen" : "Mark complete";

  const badge = document.getElementById("panelBadge");
  badge.textContent = archived
    ? "Archived"
    : item.priority
      ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1)
      : isTask
        ? taskStatusLabel(status)
        : item.kind;
  badge.className = archived
    ? "badge archived"
    : "badge " + (item.priority || (isTask ? `task-status-badge ${taskStatusClass(status)}` : item.kind));

  renderRelatedChips(item);
  // After the related chips, because it reads as the app's own voice about the item rather than as
  // another piece of the item — and it hides itself the moment nothing applies.
  renderNextAction(item);

  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
  refreshIcons();
}

function renderRelatedChips(item) {
  const container = document.getElementById("panelRelated");
  const chips = [];

  if (item.person) {
    chips.push({
      label: `${icon("user")} ${escapeHtml(item.person)}`,
      tag: "Person",
      onclick: `closePanel();openPersonModal(null,${jsStr(item.person)})`,
    });
  }
  if (item.project) {
    chips.push({
      label: `${icon("folder-kanban")} ${escapeHtml(item.project)}`,
      tag: "Project",
      onclick: `closePanel();switchView('projects')`,
    });
  }

  if (item.goal) {
    chips.push({
      label: `${icon("target")} ${escapeHtml(item.goal)}`,
      tag: "Goal",
      onclick: `closePanel();switchView('goals')`,
    });
  }

  const related = state.items
    .filter(
      (i) =>
        i.id !== item.id &&
        !isArchived(i) &&
        ((item.person && sameName(i.person, item.person)) ||
          (item.project && sameName(i.project, item.project)) ||
          (item.goal && sameName(i.goal, item.goal))),
    )
    .slice(0, 5);

  related.forEach((r) => {
    // Same default as renderToday: a hand-edited or older backup can carry an item with no kind, and
    // reading the first letter off an undefined one threw a TypeError that killed the whole panel
    // before it could open. The live probe caught that; the suite had missed it.
    const kind = r.kind || "text";
    chips.push({
      label: `${kindIcon(kind)} ${escapeHtml(r.title)}`,
      tag: escapeHtml(kind.charAt(0).toUpperCase() + kind.slice(1)),
      onclick: `closePanel();openPanel(${jsStr(r.id)})`,
    });
  });

  container.innerHTML = chips.length
    ? chips
        .map(
          (
            c,
          ) => `<div onclick="${c.onclick}" style="display:flex;flex-direction:column;gap:2px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg);">
        <span style="font-size:13px;font-weight:600;">${c.label}</span>
        <span style="font-size:10.5px;color:var(--muted);">${c.tag}</span>
      </div>`,
        )
        .join("")
    : '<p class="empty" style="padding:0;">Nothing related yet.</p>';
}

/* ---- Next-step suggestions -----------------------------------------------

   Open an item and the app offers the obvious thing to do with it, then remembers what you turned
   down. Nothing is ever done for you: every suggestion is a button, which is the same rule the rest
   of the app already follows — "suggestions, not pressure".

   Three rules ship. Each was picked because it is right far more often than not, and because it can
   be checked against facts already in the app rather than guessed:

     set-date    an open task, or a waiting item, with no day on it at all
     link-person someone already in your data is named in the text but never linked
     recur       you have done this exact job before, and last time it repeated

   A file with no date is the one case the first rule is deliberately quiet about: people park those
   on purpose, and nagging about them teaches the app nothing useful. */

/* Turn a suggestion down twice and the app stops offering it. Twice, not once, because a single
   dismissal usually means "not right now" — the same item tomorrow may well need a date. */
const NEXT_ACTION_SKIP_LIMIT = 2;
/* …but not forever. A run of bad weeks should not silence a suggestion for the rest of the year, so
   each turn-down loses its weight after this long and the suggestion is allowed back. */
const NEXT_ACTION_MEMORY_DAYS = 45;
const NEXT_ACTION_LEARNING_KEY = "everything_next_action_learning_v1";

function readNextActionLearning() {
  try {
    const raw = JSON.parse(localStorage.getItem(NEXT_ACTION_LEARNING_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (error) {
    return {};
  }
}

function writeNextActionLearning(learning) {
  try {
    localStorage.setItem(NEXT_ACTION_LEARNING_KEY, JSON.stringify(learning));
  } catch (error) {
    /* Private mode: the suggestion still works, it just cannot remember. */
  }
}

/* Records a turn-down. Dismissals older than the memory window decay by one rather than vanishing,
   so a suggestion that was wrong three months ago gets a fair hearing again. */
function noteNextActionDismissed(id) {
  if (!id) return;
  const learning = readNextActionLearning();
  const entry = learning[id] && typeof learning[id] === "object" ? learning[id] : {};
  const lastAt = Number(entry.lastAt) || 0;
  const days = (Date.now() - lastAt) / 86400000;
  const previous = Number(entry.skips) || 0;
  const decayed = days > NEXT_ACTION_MEMORY_DAYS ? Math.max(0, previous - 1) : previous;
  learning[id] = { skips: decayed + 1, lastAt: Date.now() };
  writeNextActionLearning(learning);
}

/* Taking a suggestion is the strongest signal there is, and it clears the memory entirely: someone
   who acted on "give it a day" and then acted on it again should never be asked to stop. */
function noteNextActionAccepted(id) {
  if (!id) return;
  const learning = readNextActionLearning();
  if (!(id in learning)) return;
  delete learning[id];
  writeNextActionLearning(learning);
}

function nextActionIsSuppressed(id) {
  const entry = readNextActionLearning()[id];
  if (!entry || typeof entry !== "object") return false;
  const skips = Number(entry.skips) || 0;
  if (skips < NEXT_ACTION_SKIP_LIMIT) return false;
  const days = (Date.now() - (Number(entry.lastAt) || 0)) / 86400000;
  // Stale turn-downs decay on their own, even if nothing else is written.
  return days <= NEXT_ACTION_MEMORY_DAYS;
}

/* People you already track, mentioned by name in this item but not yet linked to it. Matching on
   whole words keeps "Ann" from firing inside "Anna-Marie" or "planning". */
function unlinkedPersonIn(item) {
  if (!item || item.person) return "";
  const haystack = `${item.title || ""} ${item.sub || ""}`.toLowerCase();
  if (!haystack.trim()) return "";
  const names = [];
  for (const other of state.items || []) {
    const name = String(other?.person || "").trim();
    if (name) names.push(name);
  }
  for (const person of state.people || []) {
    const name = String(person?.name || "").trim();
    if (name) names.push(name);
  }
  // Longest first, so "Priya Sharma" wins over "Priya".
  return [...new Set(names)].sort((a, b) => b.length - a.length)
    .find((name) => {
      const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, "iu").test(haystack);
    }) || "";
}

/* A previous version of this same job, completed, and it used to repeat. Grounded in their own
   history rather than in a guess about what "feels weekly". */
function previousRecurrenceFor(item) {
  const fingerprint = normaliseCaptureFingerprint(item?.title);
  if (!fingerprint || CAPTURE_GENERIC_TITLES.has(fingerprint)) return "";
  const match = (state.items || []).find(
    (other) =>
      other.id !== item.id &&
      other.done &&
      !isArchived(other) &&
      other.recurrence &&
      normaliseCaptureFingerprint(other.title) === fingerprint,
  );
  return match?.recurrence || "";
}

const NEXT_ACTION_RULES = [
  {
    id: "set-date",
    applies: (item) =>
      !isArchived(item) &&
      !item.done &&
      !item.dueDate &&
      !item.recurrence &&
      (item.kind === "task" || item.kind === "waiting"),
    why: (item) =>
      item.kind === "waiting"
        ? item.person
          ? `You are waiting on ${item.person}, with no day to check back.`
          : "You are waiting on this, with no day to check back."
        : "This has no day on it, so it cannot surface on its own.",
    actions: () => [
      { label: "Today", act: "date", when: "today" },
      { label: "Tomorrow", act: "date", when: "day" },
      { label: "Next week", act: "date", when: "week" },
    ],
  },
  {
    id: "link-person",
    applies: (item) => !isArchived(item) && !item.done && !!unlinkedPersonIn(item),
    why: (item) => `${unlinkedPersonIn(item)} is named here but not linked.`,
    actions: (item) => [
      { label: `Link to ${unlinkedPersonIn(item)}`, act: "person", value: unlinkedPersonIn(item) },
    ],
  },
  {
    id: "recur",
    applies: (item) => !isArchived(item) && !item.done && !!previousRecurrenceFor(item),
    why: () => "You have done this before, and last time it repeated.",
    actions: (item) => [
      { label: `Make it ${previousRecurrenceFor(item)}`, act: "recur", value: previousRecurrenceFor(item) },
    ],
  },
];

/* The first rule that both applies and has not been turned down. Rules are ordered by how often they
   are right, so a single card is enough — a stack of suggestions is just noise. */
function nextActionFor(item) {
  for (const rule of NEXT_ACTION_RULES) {
    if (!rule.applies(item)) continue;
    if (nextActionIsSuppressed(rule.id)) continue;
    return rule;
  }
  return null;
}

let currentNextAction = null;

function renderNextAction(item) {
  const host = document.getElementById("panelNextAction");
  if (!host) return;
  const rule = nextActionFor(item);
  currentNextAction = rule ? { rule, item } : null;
  if (!rule) {
    host.hidden = true;
    return;
  }
  document.getElementById("nextActionWhy").textContent = rule.why(item);
  document.getElementById("nextActionActs").innerHTML = rule
    .actions(item)
    .map(
      (a) =>
        `<button class="btn" type="button" onclick="applyNextAction(${jsStr(
          a.act,
        )},${jsStr(a.when || a.value || "")})">${escapeHtml(a.label)}</button>`,
    )
    .join("");
  host.hidden = false;
}

function dismissNextAction() {
  if (!currentNextAction) return;
  noteNextActionDismissed(currentNextAction.rule.id);
  renderNextAction(currentNextAction.item);
}

async function applyNextAction(act, value) {
  if (!currentNextAction) return;
  const { rule, item } = currentNextAction;
  const target = state.items.find((i) => i.id === item.id);
  if (!target || isArchived(target)) return renderNextAction(item);

  if (act === "date") {
    if (value === "today") applyDueToItem(target, new Date());
    else if (value === "week") applyDueToItem(target, new Date(Date.now() + 7 * 86400000));
    else applyDueToItem(target, new Date(Date.now() + 86400000));
  } else if (act === "person") {
    target.person = value;
  } else if (act === "recur") {
    target.recurrence = value;
  } else {
    return;
  }

  noteNextActionAccepted(rule.id);
  await dbSaveItem(target);
  // Re-rendered from the saved item, so the card that follows is the real next one rather than a
  // stale repeat of the one just acted on.
  openPanel(target.id);
}

function closePanel() {
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("panel").classList.remove("open");
  currentItemId = null;
  if (!document.querySelector(".modal-overlay.open, .ask-overlay.open"))
    lockPageScroll(false);
}
function openEditModal() {
  if (!currentItemId) return;
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item || isArchived(item)) return;
  const editStatusRow = document.getElementById("editTaskStatusRow");
  const editStatus = document.getElementById("editStatus");
  editStatusRow.hidden = item.kind !== "task";
  if (item.kind === "task") editStatus.value = taskStatusFromItem(item);
  document.getElementById("editTitle").value = item.title || "";
  document.getElementById("editSub").value = item.sub || "";
  document.getElementById("editPriority").value = item.priority || "";
  document.getElementById("editDueDate").value = item.dueDate
    ? item.dueDate.slice(0, 16)
    : "";
  document.getElementById("editRecurrence").value = item.recurrence || "none";
  document.getElementById("editPerson").value = item.person || "";
  const projSel = document.getElementById("editProject");
  projSel.innerHTML =
    '<option value="">No project</option>' +
    state.projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`,
      )
      .join("");
  projSel.value = item.project || "";
  const goalSel = document.getElementById("editGoal");
  goalSel.innerHTML =
    '<option value="">No goal</option>' +
    state.goals
      .map(
        (g) =>
          `<option value="${escapeHtml(g.title)}">${escapeHtml(g.title)}</option>`,
      )
      .join("");
  goalSel.value = item.goal || "";
  fillEditMoneyFields(item);
  const modal = document.getElementById("editModal");
  modal.classList.add("open");
  lockPageScroll(true);
  // This dialog used to take no focus at all, so opening it with a keyboard left the caret behind on
  // the row that opened it — inside the page the dialog is sitting on top of.
  enterDialog(modal, "editTitle");
}

/* The money half of the item dialog. Three kinds carry an amount — an expense, a bill, and a debt —
   and each gets a different subset of the same block, because a bill has no "spent on" day and a
   debt has no category. A debt is detected by its amount rather than its kind: it is saved as a
   task, so kind tells you nothing and only owedMinor does. */
function fillEditMoneyFields(item) {
  const block = document.getElementById("editMoneyFields");
  if (!block) return;
  const money = moneyOf(item);
  const owed = moneyOwedOf(item);
  const isExpenseRow = isExpense(item);
  const isBillRow = isBill(item);
  const isOwedRow = owed.amountMinor !== null && owed.amountMinor > 0;
  const anyMoney = isExpenseRow || isBillRow || isOwedRow;
  block.style.display = anyMoney ? "block" : "none";

  const row = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  };
  row("editSpentOnRow", isExpenseRow);
  row("editCategoryRow", isExpenseRow);
  row("editBillTypeRow", isBillRow);
  row("editOwedRow", isOwedRow);
  if (!anyMoney) return;

  // The amount field takes plain rupees, not paise, because that is what a person edits and what is
  // printed on the paper. A debt with paise is divided out and shown whole: a debt is rounded money.
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  const minor = isOwedRow ? owed.amountMinor : money.amountMinor;
  set("editAmount", minor === null ? "" : String(Math.floor(minor / PAISE_PER_RUPEE)));
  set("editSpentOn", money.spentOn || "");
  set("editCategory", money.category || "");
  set("editMerchant", money.merchant || "");
  set("editBillType", billTypeOf(item));
  set("editOwedDirection", owed.direction);
}

/* Write the money fields back. A cleared box is honoured rather than refused: capture refuses an
   amountless expense because "I spent money" with no number is a question it should have asked, but
   here the person is deliberately emptying a field, and someone who filed a note as an expense by
   mistake has to be able to take the amount back out. The item survives with no amount, and the
   month total drops the row instead of counting it as zero. */
function applyEditMoneyFields(item) {
  const block = document.getElementById("editMoneyFields");
  if (!block || block.style.display === "none") return;
  const owed = moneyOwedOf(item);
  const isOwedRow = owed.amountMinor !== null && owed.amountMinor > 0;
  const raw = (document.getElementById("editAmount")?.value || "").trim();
  const minor = raw === "" ? null : parseMoneyToMinor(raw);
  if (minor !== null && !(minor > 0)) return; // unparseable text: leave the amount as it was
  // Spread onto the existing object, never replaced, so imageText and the receipt line stay on it.
  const meta = { ...normaliseCaptureMetadata(item.captureMetadata) };
  const value = (id) => (document.getElementById(id)?.value || "").trim();

  if (isOwedRow) {
    meta.currency = MONEY_CURRENCY;
    meta.owedMinor = minor;
    meta.owedDirection = value("editOwedDirection") === "out" ? "out" : "in";
  } else {
    meta.currency = MONEY_CURRENCY;
    meta.amountMinor = minor;
    if (isExpense(item)) {
      meta.spentOn = value("editSpentOn");
      meta.category = value("editCategory");
    }
    meta.merchant = value("editMerchant");
    if (isBill(item)) {
      meta.billType = value("editBillType") === "subscription" ? "subscription" : "bill";
    }
  }
  item.captureMetadata = meta;
  // The sub-line shows the amount on a bill row, so it must follow the correction rather than keep
  // repeating a number the person has just changed.
  if (isBill(item)) item.sub = minor === null ? "" : formatMoney(minor);
}
function closeEditModal() {
  const modal = document.getElementById("editModal");
  modal.classList.remove("open");
  if (!document.querySelector(".modal-overlay.open, .ask-overlay.open, #panel.open"))
    lockPageScroll(false);
  leaveDialog(modal);
}
async function saveEdit() {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item) return closeEditModal();
  if (isArchived(item)) return closeEditModal();
  const selectedStatus = item.kind === "task"
    ? normalizeTaskStatus(document.getElementById("editStatus").value, taskStatusFromItem(item))
    : "";
  const statusChanged = item.kind === "task" && selectedStatus !== taskStatusFromItem(item);
  item.title = document.getElementById("editTitle").value.trim() || item.title;
  item.sub = document.getElementById("editSub").value.trim();
  item.priority = document.getElementById("editPriority").value;
  item.person = document.getElementById("editPerson").value.trim();
  item.project = document.getElementById("editProject").value;
  item.goal = document.getElementById("editGoal").value;

  const editDueVal = document.getElementById("editDueDate").value;
  const newDueDate = editDueVal ? new Date(editDueVal).toISOString() : "";
  if (newDueDate !== item.dueDate) {
    // Re-dating re-arms the reminder on this device as well as on the server.
    item.notified = false;
    item.snoozedUntil = "";
    forgetNotified(item.id);
  }
  item.dueDate = newDueDate;
  item.recurrence = document.getElementById("editRecurrence").value;
  if (item.dueDate) item.due = formatDueDisplay(item.dueDate);
  applyEditMoneyFields(item);

  closeEditModal();
  closePanel();
  if (statusChanged) await setTaskStatus(item.id, selectedStatus);
  else await dbSaveItem(item);
}
async function toggleCurrentTaskArchive() {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item || item.kind !== "task" || taskMutationInFlight.has(item.id)) return;
  taskMutationInFlight.add(item.id);
  try {
    if (isArchived(item)) {
      item.archivedAt = 0;
      await dbSaveItem(item);
      closePanel();
      renderTasks("all");
    } else {
      item.archivedAt = Date.now();
      cancelReminderFor(item.id);
      await dbSaveItem(item);
      closePanel();
      renderTasks("archived");
    }
  } finally {
    taskMutationInFlight.delete(item.id);
  }
}

async function completeCurrent() {
  if (!currentItemId) return;
  const item = state.items.find((i) => i.id === currentItemId);
  if (isArchived(item)) return;
  await toggleDone(currentItemId);
  closePanel();
}
async function deleteCurrent() {
  if (!currentItemId) return;
  const id = currentItemId;
  const item = state.items.find((i) => i.id === id);
  closePanel();
  await dbDeleteItem(id, item);
}

/* ---------- Quick reschedule ("snooze") ---------- */
function applyDueToItem(item, date) {
  item.dueDate = date ? date.toISOString() : "";
  item.due = date ? formatDueDisplay(item.dueDate) : "";
  item.notified = false;
  item.snoozedUntil = "";
  forgetNotified(item.id);
  return item;
}

function nextNineAm(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d;
}

async function snoozeCurrent(mode) {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item || isArchived(item)) return;

  if (mode === "tomorrow9") applyDueToItem(item, nextNineAm(1));
  else if (mode === "day")
    applyDueToItem(item, new Date(Date.now() + 86400000));
  else if (mode === "week")
    applyDueToItem(item, new Date(Date.now() + 7 * 86400000));
  else if (mode === "clear") applyDueToItem(item, null);

  await dbSaveItem(item);
  openPanel(item.id);
}
async function dbDeleteProject(id) {
  if (syncReadyPromise) await syncReadyPromise;
  const project = state.projects.find((p) => p.id === id);
  if (db) {
    await db.collection("projects").doc(id).delete();
  } else if (sbUser) {
    await deleteStructuredRecord("project", project);
  } else {
    state.projects = state.projects.filter((p) => p.id !== id);
    save();
  }
  state.projects = state.projects.filter((p) => p.id !== id);
  save();
  renderProjects();
  renderNav();
}

// People had no delete path at all before this, so a mistyped or unwanted name was permanent.
async function dbDeletePerson(id) {
  if (syncReadyPromise) await syncReadyPromise;
  const person = state.people.find((p) => p.id === id);
  if (db) {
    await db.collection("people").doc(id).delete();
  } else if (sbUser) {
    await deleteStructuredRecord("person", person);
  } else {
    state.people = state.people.filter((p) => p.id !== id);
    save();
  }
  state.people = state.people.filter((p) => p.id !== id);
  save();
  renderPeople();
  renderNav();
}
async function dbDeleteGoal(id) {
  if (syncReadyPromise) await syncReadyPromise;
  const goal = state.goals.find((g) => g.id === id);
  if (db) {
    await db.collection("goals").doc(id).delete();
  } else if (sbUser) {
    await deleteStructuredRecord("goal", goal);
  } else {
    state.goals = state.goals.filter((g) => g.id !== id);
    save();
  }
  state.goals = state.goals.filter((g) => g.id !== id);
  save();
  renderGoals();
  renderReports();
}
async function deleteGoal(id) {
  const goal = state.goals.find((g) => g.id === id);
  const linked = goal
    ? state.items.filter((i) => sameName(i.goal, goal.title) && !isArchived(i)).length
    : 0;
  const ok = await confirmDialog({
    title: goal ? `Delete "${goal.title}"?` : "Delete this goal?",
    // The count is the whole reason to confirm. "Delete this goal?" reads as tidying up; "4 tasks will
    // lose their link" reads as a decision, which is the only thing a confirmation is for.
    body: linked
      ? `${linked} task${linked === 1 ? "" : "s"} will lose their link to it. The tasks themselves are kept.`
      : "Nothing is linked to it yet.",
    confirmLabel: "Delete goal",
    danger: true,
  });
  if (!ok) return;
  await dbDeleteGoal(id);
}

async function deleteProject(id, name) {
  const linked = state.items.filter((i) => sameName(i.project, name) && !isArchived(i)).length;
  const ok = await confirmDialog({
    title: `Delete "${name}"?`,
    body: linked
      ? `${linked} task${linked === 1 ? "" : "s"} will keep the project name but lose the link. The tasks themselves are kept.`
      : "Nothing is linked to it yet.",
    confirmLabel: "Delete project",
    danger: true,
  });
  if (!ok) return;
  await dbDeleteProject(id);
}
