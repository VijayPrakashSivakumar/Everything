/* ---------- Reorderable lists ----------

   One implementation, used by both the dashboard cards and the task lists.

   The dashboard already had a working drag: HTML5 drag for a mouse, plus a 350ms press-and-hold
   pointer path because HTML5 drag does not fire on touch. That second path is the reason this is
   shared rather than copied — a "task list dragging" that only worked with a mouse would pass
   every desktop test and be dead on the phone, which is where this app is actually used.

   `orderKey` names where the order is kept. The order is stored rather than re-derived from the
   view's own sort, because a manual order over a date-sorted list has to survive a re-sort: the
   person put a thing where they wanted it, and tomorrow's list must not quietly undo that. */
/* ---------- Command palette ----------

   One key that reaches anything. With thirteen pages in the nav and a separate Ask overlay and a
   search dropdown, the app had three ways to find things and no way to jump to a record — every
   one of them needed the mouse.

   The item matching deliberately goes through searchMatches() rather than a filter of its own, so
   the palette and the header search cannot disagree about what "grocery" means. The existing test
   that allows exactly one matcher is the reason this is a call and not a copy. */

const COMMAND_LIMIT = 8;
let commandRows = [];
let commandIndex = 0;

function commandGroups() {
  const actions = [
    { id: "capture", label: "Capture something new", hint: "C", icon: "plus", run: () => openCapture() },
    { id: "ask", label: "Ask a question", hint: "Ctrl+K", icon: "sparkles", run: () => openAsk() },
    { id: "select", label: "Select multiple tasks", hint: "Tasks", icon: "list-checks", run: () => { switchView("tasks"); toggleSelectMode(true); } },
    { id: "review", label: "Review what is stuck", hint: "Weekly", icon: "clipboard-check", run: () => switchView("review") },
    { id: "person", label: "Add a person", hint: "People", icon: "user-plus", run: () => { switchView("people"); document.getElementById("newPersonInput")?.focus(); } },
    { id: "project", label: "Add a project", hint: "Projects", icon: "folder-plus", run: () => { switchView("projects"); document.getElementById("newProjectInput")?.focus(); } },
    { id: "goal", label: "Add a goal", hint: "Goals", icon: "target", run: () => { switchView("goals"); document.getElementById("newGoalInput")?.focus(); } },
  ];
  const pages = NAV.filter((item) => item.id !== "logout").map((item) => ({
    id: `view-${item.id}`,
    label: item.label,
    hint: "Page",
    icon: item.icon,
    run: () => switchView(item.id),
  }));
  // Actions come first: someone who types "new" wants a button, not a page called "new".
  return [
    { name: "Actions", rows: actions },
    { name: "Pages", rows: pages },
  ];
}

/* People, projects and goals are matched on their own text, not through searchMatches: that
   matcher scores items, and it has no notion of a person's phone number. Both lists are small, so
   a substring test is the right cost here. */
function commandRecordRows(query) {
  if (!query) return [];
  const needle = query.toLowerCase();
  const out = [];
  const people = [
    ...state.people.map((p) => ({ name: p.name, id: p.id, sub: p.phone || p.email || "" })),
    ...[...new Set(state.items.map((i) => i.person).filter(Boolean))]
      .filter((n) => !state.people.some((p) => sameName(p.name, n)))
      .map((n) => ({ name: n, id: null, sub: "from a task" })),
  ];
  people
    .filter((p) => `${p.name} ${p.sub}`.toLowerCase().includes(needle))
    .slice(0, COMMAND_LIMIT)
    .forEach((p) => out.push({
      id: `person-${p.id || p.name}`,
      label: p.name,
      sub: p.sub,
      icon: "user",
      group: "People",
      run: () => { switchView("people"); openPersonModal(p.id, p.name); },
    }));

  state.projects
    .filter((p) => String(p.name || "").toLowerCase().includes(needle))
    .slice(0, COMMAND_LIMIT)
    .forEach((p) => out.push({
      id: `project-${p.id}`,
      label: p.name,
      sub: "Project",
      icon: "folder-kanban",
      run: () => { switchView("projects"); startRenameProject(p.id, p.name); },
    }));

  state.goals
    .filter((g) => String(g.title || "").toLowerCase().includes(needle))
    .slice(0, COMMAND_LIMIT)
    .forEach((g) => out.push({
      id: `goal-${g.id}`,
      label: g.title,
      sub: "Goal",
      icon: "target",
      run: () => { switchView("goals"); startRenameGoal(g.id, g.title); },
    }));

  // The one shared matcher, so the palette and the header search can never disagree about a typo.
  searchMatches(query)
    .slice(0, COMMAND_LIMIT)
    .forEach((item) => out.push({
      id: `item-${item.id}`,
      label: item.title,
      sub: [item.kind, item.person, item.project].filter(Boolean).join(" · "),
      icon: item.done ? "check-circle" : "circle",
      group: "Tasks & notes",
      run: () => openPanel(item.id),
    }));

  return out;
}

/* Binds the row gestures. Called by every list that renders rows, whichever gestures it wants,
   because the Inbox swipes and the Tasks list reorders and neither should depend on the other's
   list setup. Gesture binding used to live inside enableListReordering, which meant the Inbox —
   which never calls it — had swipeable rows and no way to swipe them. */
function bindRowGestures(list, itemSelector, startTracking) {
  [...list.querySelectorAll(itemSelector)].forEach((el) => {
    let holdTimer = null;
    el.addEventListener("pointerdown", (event) => {
      /* A swipeable row decides for itself. It cannot be judged by the control check below,
         because the revealed action buttons sit on top of the row's own box until the row is
         slid aside — a press anywhere near the right edge lands on an invisible `.swipe-action`
         button, that check sees "a control", and the swipe never starts. startSwipe() hit-tests
         the row body itself and treats a press on a visible action as a tap. */
      if (el.classList.contains("swipeable")) {
        startSwipe(el, event);
        return;
      }
      // A press that starts on a control belongs to the control. Without this, tapping a checkbox
      // on a phone would begin a gesture and the checkbox would never fire.
      if (event.target.closest("button, input, a, select, textarea")) return;
      if (!startTracking) return;
      holdTimer = setTimeout(() => startTracking(el), 350);
    });
    el.addEventListener("pointerup", () => {
      // A press that ended before the hold elapsed was a tap, not a drag. Clearing the timer is
      // what stops a tap from becoming a reorder a second later.
      clearTimeout(holdTimer);
      holdTimer = null;
    });
    el.addEventListener("pointercancel", () => {
      clearTimeout(holdTimer);
      holdTimer = null;
    });
  });
}

function enableListReordering(container, options = {}) {
  const {
    itemSelector = "[data-reorder-id]",
    orderKey = null,
    onReorder = null,
    holdDelay = 350,
  } = options;
  if (!container) return null;

  let dragged = null;
  let holdTimer = null;
  let pointerDragging = false;
  // Set only once a drag is actually under way, so a stray pointerup after a plain tap does not
  // commit an order the person never chose.
  let tracking = null;

  const items = () => [...container.querySelectorAll(itemSelector)];
  const order = () => items().map((el) => el.dataset.reorderId);

  /* `place` moves within the target's own parent rather than the shared container. The dashboard's
     three cards live in different parents, so "insert into the container" would be wrong there and
     correct for a task list — one rule, applied to whichever list the row actually sits in. */
  const place = (el, target, clientY) => {
    const box = target.getBoundingClientRect();
    const before = clientY < box.top + box.height / 2;
    target.parentElement.insertBefore(el, before ? target : target.nextElementSibling);
  };

  /* The move and release listeners live on the document, not on the row. This is the whole reason
     press-and-hold can work at all: the instant the drag starts the pointer leaves the row it
     started on, so a listener bound to that row would receive exactly one move and then nothing.
     The dashboard's original drag had this same flaw and simply never showed it, because a
     dashboard card is large enough that the first move usually landed on a card it also handled. */
  const startTracking = (el) => {
    pointerDragging = true;
    dragged = el;
    el.classList.add("reorder-dragging");
    container.classList.add("reorder-active");

    const onMove = (event) => {
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
      if (!target || target === el || !container.contains(target)) return;
      place(el, target, event.clientY);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      tracking = null;
      commit();
    };
    const onCancel = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      tracking = null;
      abort();
    };
    tracking = { onMove, onUp, onCancel };
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  };

  const abort = () => {
    // No timer to clear: bindRowGestures owns it and clears it on pointerup, which is the only
    // event that can reach here with a hold still pending.
    if (dragged) dragged.classList.remove("reorder-dragging");
    container.classList.remove("reorder-active");
    dragged = null;
    pointerDragging = false;
  };

  const commit = () => {
    const wasDragging = Boolean(dragged);
    const el = dragged;
    abort();
    if (!wasDragging) return;
    const next = order();
    if (orderKey) {
      try {
        localStorage.setItem(orderKey, JSON.stringify(next));
      } catch (err) {
        /* Private mode: the reorder still applies, it just will not be remembered. */
      }
    }
    if (onReorder) onReorder(next, el);
  };

  items().forEach((el) => {
    /* No `draggable = true` here, deliberately.

       Setting it starts a native HTML5 drag as soon as the mouse moves, and that drag *cancels the
       pointer event stream* — so the press-and-hold path below received exactly one move and then
       went silent. It looked like a mouse drag and a touch drag were two features; they are one
       drag, and the native one was getting in its own way. A dashboard card is large enough to
       hide this, which is why it survived; a task row is not.

       The pointer path covers mouse and touch identically, so there is nothing left to delegate. */
    el.addEventListener("dragstart", (event) => {
      // Still refused: if anything else in the page makes the row draggable, a native drag would
      // break the reorder again, and swallowing it here fails loudly instead of silently.
      event.preventDefault();
    });
  });

  // The press-and-hold gesture is bound here rather than inline above, so the same binder serves
  // the swipe-only lists that never call this function.
  bindRowGestures(container, itemSelector, startTracking);

  return { order, items };
}

/* ---------- Swipe to act on a row ----------

   A horizontal drag across a row slides it aside to reveal Archive and Delete. It is the gesture a
   phone user already expects, and it is the only way to act on a single row without opening it.

   It shares this module with press-and-hold reordering, and the two must never fight. They are
   kept apart by *which branch the row takes* in bindRowGestures: a swipeable row returns before
   the hold timer is ever set, and a reorderable row never reaches the swipe branch. So no row is
   ever half in both, and there is no timer to race against.

   A vertical move is always a scroll, never a swipe, which is what keeps a long list scrollable
   when rows are swipeable. */
const SWIPE_TRIGGER = 56;
const SWIPE_MAX_WIDTH = 168;

function startSwipe(el, event) {
  /* A press on a *revealed* action button belongs to the button. Without this, setPointerCapture
     below would retarget the following pointerup and click onto the row itself, so the button's
     own handler never ran and a revealed action did nothing at all.

     The test is a hit-test, not `event.target.closest(...)`, because which element is under the
     finger is not the question — the revealed buttons sit over the row's own box, so the target
     can be either. The question is whether the row is currently showing them. */
  if (el.classList.contains("swiped-open") && event.target.closest(".swipe-action")) {
    swipeOpenRow = null;
    return;
  }
  /* What slides is the strip, not the row. The actions are positioned against the row, so
     transforming the row carried them left along with it and left them stranded in the middle of
     the list instead of pinned to the edge the finger pulled from. */
  const body = el.querySelector(".swipe-row-body");
  if (!body) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let decided = null;
  let offset = 0;
  // Pointer capture keeps receiving moves even once the finger leaves the row, which on a phone is
  // most of the gesture.
  try {
    el.setPointerCapture(event.pointerId);
  } catch (err) {
    /* Older browsers without pointer capture: the move listener below still works while the
       pointer is over the row, which is enough to recognise a short swipe. */
  }

  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (decided === null) {
      // A small wobble is not a decision; waiting for it stops a tap being read as a swipe.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        decided = "scroll";
        return;
      }
      decided = dx < 0 ? "swipe" : "ignore";
      if (decided === "swipe") {
        /* No drag can begin on a swipeable row — bindRowGestures returns before setting the hold
           timer for these — so there is no pending timer to cancel here. The two gestures are
           separated by which branch the row takes, not by racing them. */
        el.classList.add("swiping");
      }
    }
    if (decided !== "swipe") return;
    moveEvent.preventDefault();
    // Rubber-banding to the left only: swiping right would fight the back gesture.
    offset = Math.max(-SWIPE_MAX_WIDTH, Math.min(0, dx));
    body.style.transform = `translateX(${offset}px)`;
  };

  const finish = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", finish);
    el.removeEventListener("pointercancel", finish);
    el.classList.remove("swiping");
    const committed = decided === "swipe" && -offset >= SWIPE_TRIGGER;
    /* Only ever one open row. `swipeOpenRow` is a single slot, so opening a second row only
       overwrote the pointer to the first — which stayed slid aside with nothing left able to close
       it, its buttons sitting on top of the row below. Closing first is what makes the slot mean
       "the open row" rather than "the most recently swiped row". */
    if (committed) closeOpenSwipe();
    /* Every one of the lines below is guarded on a swipe having actually been decided, and that
       guard is load-bearing rather than tidiness. `finish` runs on every pointerup, and a tap is
       not a swipe: `decided` is still null, so there is nothing to snap and no row to reopen. The
       click handler is what decides "close this open row" instead of "open the item behind it",
       and it reads `swiped-open` when the click arrives. Toggling the class here on a tap closed
       the row a moment too early, and the click then found nothing to match and opened the item —
       so tapping a swiped-open row did the one thing it is not supposed to do. */
    if (decided === "swipe") {
      /* Both outcomes land the body back at 0: it moves only during the gesture, so the resting
         state is neutral. Parking it at -SWIPE_MAX_WIDTH when committed slid the row's own content
         out of view, leaving the opened row showing only buttons. */
      body.style.transform = "";
      el.classList.toggle("swiped-open", committed);
      // Same guard: on a tap the row is untouched, so the slot has to keep pointing at it too.
      // Nulling it here meant the click that closes the row found nothing to close.
      swipeOpenRow = committed ? el : null;
    }
    offset = 0;
    /* A gesture that moved is not a tap. The browser still fires a click on pointerup after a
       swipe — the row was dragged, not pressed — and that click fell through to openPanel(), so a
       swipe opened the very item the person was trying to swipe.

       Scoped to this row's own handler, and only for this one gesture: the click lands on the
       element under the finger, so the row is the only handler that can read it. A module-level
       flag had to expire on a timer, and that timer then swallowed the *next* real tap — including
       a deliberate press on a revealed action button, which is how a swipe became unusable. */
    el.swallowNextClick = decided === "swipe" ? true : el.swallowNextClick;
  };

  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
}

let swipeOpenRow = null;

/* Tapping anywhere else closes a row left open by a swipe. Without this, a row stays slid aside
   and covers the content beside it with no visible way back. */
function closeOpenSwipe() {
  if (!swipeOpenRow) return;
  // The transform lives on the strip, so that is the copy that has to be cleared. The row's own is
  // cleared too, defensively: nothing sets it any more, and a stray one would slide the buttons off
  // the edge they are pinned to.
  const body = swipeOpenRow.querySelector(".swipe-row-body");
  if (body) body.style.transform = "";
  swipeOpenRow.style.transform = "";
  swipeOpenRow.classList.remove("swiped-open");
  swipeOpenRow = null;
}

/* The revealed actions. Built with the DOM API because a task title is free text and goes into a
   label — the same reason fillMergeTargets does not build options by string concatenation. */
function attachSwipeActions(row, item) {
  if (row.querySelector(".swipe-actions")) return;
  const actions = document.createElement("div");
  actions.className = "swipe-actions";

  const add = (labelText, className, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `swipe-action ${className}`;
    button.textContent = labelText;
    button.onclick = (e) => {
      e.stopPropagation();
      closeOpenSwipe();
      handler();
    };
    actions.appendChild(button);
  };

  add("Done", "swipe-done", () => toggleDone(item.id));
  add("Archive", "swipe-archive", () => {
    if (isArchived(item)) return;
    item.archivedAt = Date.now();
    cancelReminderFor(item.id);
    dbSaveItem(item).then(() => {
      renderAll();
      showUndoAction("Archived 1 item", () => unarchiveItems([{ ...item }]));
    });
  });

  const strip = document.createElement("div");
  strip.className = "swipe-row-body";
  strip.append(...Array.from(row.childNodes));
  row.append(actions);
  row.append(strip);
}

function readStoredOrder(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function commandRowHtml(row, index) {
  return `<div class="command-row" data-index="${index}" role="option" aria-selected="false"
    onclick="runCommand(${index})" onmouseenter="highlightCommand(${index})"
    style="display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:8px;cursor:pointer">
    <span style="color:var(--accent);display:flex">${icon(row.icon || "circle")}</span>
    <span style="flex:1;min-width:0">
      <span style="display:block;color:var(--text);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.label)}</span>
      ${row.sub ? `<span style="display:block;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.sub)}</span>` : ""}
    </span>
    ${row.hint ? `<span style="font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:5px;padding:2px 6px;white-space:nowrap">${escapeHtml(row.hint)}</span>` : ""}
  </div>`;
}

function renderCommands() {
  const input = document.getElementById("commandInput");
  const list = document.getElementById("commandList");
  if (!input || !list) return;
  const query = input.value.trim();
  const needle = query.toLowerCase();

  const groups = [];
  for (const group of commandGroups()) {
    const matching = group.rows.filter(
      (row) => !needle || row.label.toLowerCase().includes(needle) || (row.hint || "").toLowerCase().includes(needle),
    );
    if (matching.length) groups.push({ group: group.name, rows: matching.slice(0, COMMAND_LIMIT) });
  }
  if (query) {
    const records = commandRecordRows(query);
    if (records.length) groups.push({ group: "Your stuff", rows: records });
  }

  commandRows = groups.flatMap((group) => group.rows);
  commandIndex = 0;

  if (!commandRows.length) {
    list.innerHTML = '<p class="empty" style="padding:14px 4px">Nothing matches that.</p>';
    return;
  }

  list.innerHTML = groups
    .map((group) => `
      <div style="padding:10px 4px 4px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700">${escapeHtml(group.group)}</div>
      ${group.rows.map((row) => commandRowHtml(row, commandRows.indexOf(row))).join("")}`)
    .join("");
  highlightCommand(0);
  refreshIcons();
}

function highlightCommand(index) {
  const rows = [...document.querySelectorAll("#commandList .command-row")];
  if (!rows.length) return;
  commandIndex = (index + rows.length) % rows.length;
  rows.forEach((row, i) => {
    const on = i === commandIndex;
    row.setAttribute("aria-selected", String(on));
    row.style.background = on ? "var(--sidebar-hover)" : "transparent";
  });
  rows[commandIndex]?.scrollIntoView({ block: "nearest" });
}

function commandKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlightCommand(commandIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightCommand(commandIndex - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    runCommand(commandIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
}

function runCommand(index) {
  const row = commandRows[index];
  closeCommandPalette();
  // Deferred by a tick: every run() opens a panel, a modal or another view, and doing that
  // synchronously from inside a keydown leaves the palette's input still holding focus.
  if (row) setTimeout(() => row.run(), 0);
}

function openCommandPalette() {
  const overlay = document.getElementById("commandPalette");
  const input = document.getElementById("commandInput");
  if (!overlay || !input) return;
  overlay.classList.add("open");
  input.value = "";
  renderCommands();
  lockPageScroll(true);
  // Focus after the class lands, or the scroll lock and the caret fight each other.
  setTimeout(() => input.focus(), 0);
}

function closeCommandPalette() {
  const overlay = document.getElementById("commandPalette");
  if (!overlay) return;
  overlay.classList.remove("open");
  if (!document.querySelector(".modal-overlay.open, .ask-overlay.open, #panel.open")) lockPageScroll(false);
}

function saveDashboardLayout() {
  const layout = [...document.querySelectorAll("[data-dashboard-section]")].map(
    (section) => ({
      id: section.dataset.dashboardSection,
      parent: section.parentElement.id,
      index: [...section.parentElement.children].indexOf(section),
    }),
  );
  localStorage.setItem("everything_dashboard_layout", JSON.stringify(layout));
}

function restoreDashboardLayout() {
  let layout = [];
  try {
    layout = JSON.parse(localStorage.getItem("everything_dashboard_layout") || "[]");
  } catch (error) {
    layout = [];
  }
  layout.forEach((entry) => {
    const section = document.querySelector(`[data-dashboard-section="${entry.id}"]`);
    const parent = document.getElementById(entry.parent);
    if (!section || !parent) return;
    const siblings = [...parent.children].filter(
      (child) => child !== section && child.dataset.dashboardSection,
    );
    parent.insertBefore(section, siblings[entry.index] || null);
  });
}

function enableDashboardDragging() {
  /* Delegates to the shared reorder engine. This used to be its own ~55-line copy of the same
     dragstart/dragover/press-and-hold logic, which is exactly how two implementations of one
     behaviour end up disagreeing — the task lists got the pointer path, the dashboard would have
     kept its own, and a fix to one would leave the other broken.

     The container is a class selector rather than document.body: the engine binds a listener to
     every element matching `itemSelector` inside it, and the body already holds the nav, the task
     list and the whole app. */
  return enableListReordering(document.querySelector(".view.active") || document.body, {
    itemSelector: "[data-dashboard-section]",
    onReorder: saveDashboardLayout,
  });
}
