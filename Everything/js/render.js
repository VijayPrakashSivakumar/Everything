/* ---------- Nav & routing ---------- */
function renderNav() {
  const nav = document.getElementById("navList");
  nav.innerHTML = "";
  NAV.forEach((item) => {
    if (item.divider) {
      const hr = document.createElement("div");
      hr.style.cssText =
        "height:1px;background:var(--sidebar-hover);margin:10px 4px;";
      nav.appendChild(hr);
    }
    const el = document.createElement("div");
    el.className = "nav-item" + (item.id === activeView ? " active" : "");
    let badge = "";
    if (item.id === "inbox") badge = state.items.filter((i) => !isArchived(i)).length;
    if (item.id === "tasks")
      badge = state.items.filter((i) => i.kind === "task" && !i.done && !isArchived(i)).length;
    el.innerHTML = `<div class="left"><span class="nav-icon"><i data-lucide="${item.icon}"></i></span><span class="nav-label">${item.label}</span></div>${badge ? `<span class="nav-badge">${badge}</span>` : ""}`;
    el.onclick = () => switchView(item.id, { history: "push" });
    nav.appendChild(el);
  });
  refreshIcons();
}

let activeView = "today";

/* ---------- Nav & routing ----------
   `history` controls the browser-history entry: "push" for a move the person made from the
   navigation, "replace" for every other caller (boot, login, a jump from a panel). Defaulting to
   "replace" is what keeps the history from filling up with entries nobody can go back through,
   while still letting the nav and the back gesture agree about where you are. */
function switchView(id, options = {}) {
  const mode = options.history === "push" ? "push" : "replace";
  if (!document.getElementById("view-" + id)) return;
  const changed = activeView !== id;
  if (changed && mode === "push") navPushView(id);
  activeView = id;
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + id).classList.add("active");
  renderNav();
  closeSidebar();
  if (id === "schedule") renderCalendar();
  if (id === "reports") renderReports();
  if (id === "review") renderReview();
  if (id === "projects") renderProjects();
  if (id === "goals") renderGoals();
  if (id === "tasks") renderTasks();
  if (id === "inbox") renderInbox();
  if (id === "memory") renderMemory();
  if (id === "documents") renderDocuments();
  if (id === "money") renderMoney();
  if (id === "people") renderPeople();
  if (id === "insights") renderInsights();
  if (id === "settings") renderSettings();

  // Keep the current entry truthful even when no new one was added, so a back press arriving
  // from outside (a restored tab, a hardware back) still knows which view to show.
  if (changed && mode === "replace") navReplaceView(id);

  const content = document.querySelector(".content");
  if (content) content.scrollTo({ top: 0, left: 0, behavior: "auto" });

  /* Mark the view as one the person navigated to, so the stylesheet can play the arrival animation
     only for that case.

     `changed` is the honest signal and already computed above: it is false when switchView is called
     for the view already showing, which is what boot and every re-render look like. Without this
     gate the animation would restart every time the list re-rendered — so tapping a checkbox in the
     middle of a fade made the whole page pulse again, which reads as a glitch rather than as motion.
     Putting the class here rather than in CSS means the decision is made once, in the function that
     knows why the view is being shown, instead of inferred from the DOM. */
  const view = document.getElementById("view-" + id);
  if (view && changed) {
    view.classList.remove("entering");
    // Reflow between the two class writes, or removing and re-adding in the same frame collapses to
    // no change and the animation does not replay.
    void view.offsetWidth;
    view.classList.add("entering");
  }
}

function syncSidebarMode() {
  const sidebar = document.getElementById("sidebar");
  const btn = document.querySelector(".sidebar-collapse");
  if (!sidebar || !btn) return;
  const isMobile = sidebarMedia.matches;
  const collapsed = sidebar.classList.contains("collapsed");
  const name = isMobile ? "x" : collapsed ? "chevron-right" : "chevron-left";
  const label = isMobile
    ? "Close menu"
    : collapsed
      ? "Expand sidebar"
      : "Collapse sidebar";
  btn.innerHTML = icon(name);
  btn.title = label;
  btn.setAttribute("aria-label", label);
  const hamburger = document.getElementById("hamburger");
  if (hamburger) {
    hamburger.style.display = isMobile ? "flex" : "none";
    hamburger.setAttribute("aria-expanded", String(sidebar.classList.contains("open")));
  }
  if (isMobile) {
    sidebar.setAttribute("aria-hidden", String(!sidebar.classList.contains("open")));
  } else {
    sidebar.removeAttribute("aria-hidden");
  }
  refreshIcons();
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle("open");
  if (sidebarMedia.matches) {
    sidebar.setAttribute("aria-hidden", String(!isOpen));
  } else {
    sidebar.removeAttribute("aria-hidden");
  }
  if (backdrop) backdrop.classList.toggle("visible", isOpen);
  lockPageScroll(isOpen);
  syncSidebarMode();
}

function closeSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.classList.remove("open");
  if (sidebarMedia.matches) sidebar.setAttribute("aria-hidden", "true");
  const backdrop = document.getElementById("sidebarBackdrop");
  if (backdrop) backdrop.classList.remove("visible");
  lockPageScroll(false);
  syncSidebarMode();
}

function toggleSidebarCollapse() {
  const sidebar = document.getElementById("sidebar");
  // The rail is always the full drawer on phones, so there the same
  // button means "close" instead of "collapse".
  if (sidebarMedia.matches) {
    closeSidebar();
    return;
  }
  const collapsed = sidebar.classList.toggle("collapsed");
  localStorage.setItem(
    "everything_sidebar_collapsed",
    collapsed ? "1" : "0",
  );
  syncSidebarMode();
}

function restoreSidebarCollapse() {
  if (localStorage.getItem("everything_sidebar_collapsed") === "1")
    document.getElementById("sidebar").classList.add("collapsed");
}

const sidebarMedia = window.matchMedia("(max-width:900px)");
if (typeof sidebarMedia.addEventListener === "function")
  sidebarMedia.addEventListener("change", syncSidebarMode);

/* The search placeholder is prose, and prose is the first thing to break when the field is narrow.

   Restoring the theme toggle cost the topbar 42px, which left the field at 128px and the
   "Search anything or ask a question..." placeholder truncated to "Search an". A placeholder that
   reads as a broken word is worse than a short one, so the text swaps at the same breakpoint the
   layout uses. The accessible name does not change: aria-label keeps the full description, and the
   field is a real input rather than a click target, so a short placeholder loses nothing.

   The long and short forms are both written out here rather than truncated at runtime, so the
   narrow string is chosen deliberately rather than cut off at whatever character index happens to
   fit. "Search..." is 64px against 77px of usable input at 390px, measured; "Search or ask..." was
   the first attempt and is 112px, so it truncated just as badly. */
const searchPlaceholderMedia = window.matchMedia("(max-width:900px)");
function syncSearchPlaceholder() {
  const input = document.getElementById("searchInput");
  if (!input) return;
  input.placeholder = searchPlaceholderMedia.matches
    ? "Search..."
    : "Search anything or ask a question…";
}
if (typeof searchPlaceholderMedia.addEventListener === "function")
  searchPlaceholderMedia.addEventListener("change", syncSearchPlaceholder);
syncSearchPlaceholder();

/* ---------- Rendering ---------- */
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return m + " minute" + (m > 1 ? "s" : "") + " ago";
  const h = Math.floor(diff / 3600000);
  if (h < 24) return h + " hour" + (h > 1 ? "s" : "") + " ago";
  const d = Math.floor(h / 24);
  if (d === 1) return "Yesterday";
  return d + " days ago";
}

function kindIcon(kind) {
  return icon(
    {
      task: "check-square-2",
      event: "calendar-days",
      waiting: "hourglass",
      memory: "brain",
      project: "folder-kanban",
      openloop: "circle-alert",
      file: "file-text",
      note: "sticky-note",
      voice: "mic",
      image: "image",
      link: "link",
    }[kind] || "circle",
  );
}
function kindColor(kind) {
  return (
    {
      task: ["var(--blue-bg)", "var(--blue-fg)"],
      event: ["var(--purple-bg)", "var(--purple-fg)"],
      waiting: ["var(--amber-bg)", "var(--amber-fg)"],
      memory: ["var(--green-bg)", "var(--green-fg)"],
      project: ["var(--blue-bg)", "var(--blue-fg)"],
      openloop: ["var(--red-bg)", "var(--red-fg)"],
      file: ["var(--purple-bg)", "var(--purple-fg)"],
      voice: ["var(--red-bg)", "var(--red-fg)"],
      image: ["var(--green-bg)", "var(--green-fg)"],
      link: ["var(--blue-bg)", "var(--blue-fg)"],
      document: ["var(--blue-bg)", "var(--blue-fg)"],
      expense: ["var(--green-bg)", "var(--green-fg)"],
      bill: ["var(--amber-bg)", "var(--amber-fg)"],
    }[kind] || ["var(--bg)", "var(--text)"]
  );
}

function renderToday() {
  document.getElementById("todayDate").textContent =
    new Date().toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  const todays = state.items
    .filter(
      (i) =>
        !i.done &&
        !isArchived(i) &&
        ((i.kind === "task" && isTaskToday(i)) ||
          (i.kind === "event" && i.dueDate) ||
          i.kind === "waiting"),
    )
    .sort((a, b) => {
      if (a.dueDate && b.dueDate)
        return new Date(a.dueDate) - new Date(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return b.created - a.created;
    })
    .slice(0, 8);
  document.getElementById("statTasks").textContent = state.items.filter(
    (i) => i.kind === "task" && !i.done && !isArchived(i),
  ).length;
  document.getElementById("statEvents").textContent = state.items.filter(
    (i) => i.kind === "event",
  ).length;
  document.getElementById("statWaiting").textContent = state.items.filter(
    (i) => i.kind === "waiting",
  ).length;
  document.getElementById("statOpen").textContent = state.items.filter(
    (i) => i.kind === "openloop",
  ).length;

  const list = document.getElementById("todayList");
  list.innerHTML = "";
  todays.forEach((item) => {
    list.appendChild(taskRow(item));
  });

  const recent = document.getElementById("recentList");
  recent.innerHTML = "";
  [...state.items]
    .filter((item) => !isArchived(item))
    .sort((a, b) => b.created - a.created)
    .slice(0, 4)
    .forEach((item) => {
      // Every other normaliser defaults the kind (see itemToRow and the Supabase row builders), and
      // a backup that predates it, or one edited by hand, can still arrive without one. kindColor and
      // kindIcon already tolerate that; this line did not, so a single kindless item threw and left
      // the Today view half-rendered.
      const kind = item.kind || "text";
      const [bg, fg] = kindColor(kind);
      const el = document.createElement("div");
      el.className = "recent-item";
      el.onclick = () => openPanel(item.id);
      el.innerHTML = `<div class="recent-dot" style="background:${bg};color:${fg};">${kindIcon(kind)}</div>
      <div><div class="recent-text">${escapeHtml(item.title)}</div><div class="recent-tag">${escapeHtml(kind.charAt(0).toUpperCase() + kind.slice(1))}</div></div>
      <div class="recent-time">${timeAgo(item.created)}</div>`;
      recent.appendChild(el);
    });

  // The compact strip on Today, and the full Insights view, are the same data.
  // Both escape the text: getInsights() interpolates user titles, project and person names.
  const insights = document.getElementById("insightsList");
  const insightData = getInsights();
  insights.innerHTML = insightData
    .map(
      (i) =>
        `<div class="insight-item"><span>${icon(i.icon)}</span><div><div class="insight-title">${escapeHtml(i.title)}</div><div class="insight-sub">${escapeHtml(i.sub)}</div></div></div>`,
    )
    .join("");

  renderUpcomingDates();
  renderExpiringDocuments();
}

/* Renders the Insights view. This was the tail of renderToday(), so Insights was only ever populated
   as a side effect of visiting Today, and showed an empty page when opened first. */
function renderInsights() {
  const insightData = getInsights();
  const full = document.getElementById("insightsFull");
  if (full) {
    full.innerHTML = insightData.length
      ? insightData
          .map(
            (i) =>
              `<div class="insight-item"><span>${icon(i.icon)}</span><div><div class="insight-title">${escapeHtml(i.title)}</div><div class="insight-sub">${escapeHtml(i.sub)}</div></div></div>`,
          )
          .join("")
      : emptyStateHTML({
          /* The rule this copy follows: name the state in the person's words, then say what will
             happen — in the same breath. A title that describes the app ("Nothing to show yet") is
             about the database. What someone recognises is the state itself — a clear board — so that
             is the title, and the body carries the explanation.

             The body also does the reassuring part: "you don't have to" is what stops a dashboard
             from reading as homework. It works the patterns out by itself. */
          title: "A clear board",
          body: "Anything overdue, waiting on someone, or due today would land here. Right now there's none of that — so capture something, and this fills itself in.",
          action: "openCapture()",
          actionLabel: "Capture something",
        });
  }

  const activeItems = state.items.filter((i) => !isArchived(i));
  const totalItems = activeItems.length;
  const completedCount = activeItems.filter((i) => i.done).length;
  const activeDays = new Set(
    activeItems.map((i) => new Date(i.created).toDateString()),
  ).size;

  const statsEl = document.getElementById("insightsStats");
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);"><i data-lucide="inbox"></i></div><div><div class="stat-num">${totalItems}</div><div class="stat-label">Total captured</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);"><i data-lucide="circle-check"></i></div><div><div class="stat-num">${completedCount}</div><div class="stat-label">Completed</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);"><i data-lucide="calendar-days"></i></div><div><div class="stat-num">${activeDays}</div><div class="stat-label">Active days</div></div></div>
    `;
  }
  refreshIcons();
}

function getInsights() {
  const arr = [];
  const openLoops = state.items.filter(
    (i) => !isArchived(i) && (i.kind === "openloop" || i.kind === "waiting"),
  );
  if (openLoops.length)
    arr.push({
      icon: "sparkles",
      title: `You have ${openLoops.length} open loop${openLoops.length > 1 ? "s" : ""}`,
      sub: openLoops
        .map((o) => o.title)
        .slice(0, 3)
        .join(", "),
    });

  // Most active project
  const projectCounts = {};
  state.items.forEach((i) => {
    if (!isArchived(i) && i.project)
      projectCounts[i.project] = (projectCounts[i.project] || 0) + 1;
  });
  const topProject = Object.entries(projectCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];
  if (topProject)
    arr.push({
      icon: "folder-kanban",
      title: `Most active project: ${topProject[0]}`,
      sub: `${topProject[1]} item${topProject[1] > 1 ? "s" : ""} linked`,
    });

  // Most mentioned person
  const personCounts = {};
  state.items.forEach((i) => {
    if (!isArchived(i) && i.person) personCounts[i.person] = (personCounts[i.person] || 0) + 1;
  });
  const topPerson = Object.entries(personCounts).sort((a, b) => b[1] - a[1])[0];
  if (topPerson)
    arr.push({
      icon: "user",
      title: `You mention ${topPerson[0]} most often`,
      sub: `${topPerson[1]} linked item${topPerson[1] > 1 ? "s" : ""}`,
    });

  // Busiest day of week (by creation)
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  state.items.forEach((i) => {
    if (!isArchived(i)) dayCounts[new Date(i.created).getDay()]++;
  });
  const maxDay = dayCounts.indexOf(Math.max(...dayCounts));
  if (Math.max(...dayCounts) > 0) {
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    arr.push({
      icon: "trending-up",
      title: `You capture the most on ${dayNames[maxDay]}s`,
      sub: `${dayCounts[maxDay]} item${dayCounts[maxDay] > 1 ? "s" : ""} total`,
    });
  }

  // Overdue warning
  const overdue = state.items.filter((i) => isOverdue(i));
  if (overdue.length)
    arr.push({
      icon: "triangle-alert",
      title: `${overdue.length} task${overdue.length > 1 ? "s are" : " is"} overdue`,
      sub: overdue
        .slice(0, 3)
        .map((o) => o.title)
        .join(", "),
    });

  // Stale open loops (open for 7+ days)
  const stale = openLoops.filter((i) => Date.now() - i.created > 7 * 86400000);
  if (stale.length)
    arr.push({
      icon: "history",
      title: `${stale.length} open loop${stale.length > 1 ? "s have" : " has"} sat for a week+`,
      sub: stale
        .slice(0, 3)
        .map((s) => s.title)
        .join(", "),
    });

  if (!arr.length)
    arr.push({
      icon: "sprout",
      title: "Not enough activity yet",
      sub: "Capture more to start seeing patterns.",
    });
  return arr;
}

function taskPriorityRank(item) {
  const priority = String(item?.priority || "").trim().toLowerCase();
  return { urgent: 0, high: 1, medium: 2, normal: 2, low: 3 }[priority] ?? 4;
}

function taskStatusBadge(item) {
  const status = taskStatusFromItem(item);
  const badge = document.createElement("span");
  badge.className = `badge task-status-badge ${taskStatusClass(status)}`;
  badge.textContent = taskStatusLabel(status);
  return badge;
}

/* ---------- Bulk actions and manual task order ----------

   Both of these are per-device conveniences, and both were kept out of the sync layer on purpose.
   A selection is meaningless on another device, and a hand-picked order that synced would fight
   every other device's sort on every load. So neither is an item field: the selection is a Set
   that lives until the tab closes, and the order is one localStorage key. */

const TASK_ORDER_KEY = "everything_task_order_v1";
let bulkSelection = new Set();
let selectMode = false;
/* Which list the selection belongs to. The bar and the actions are shared, but a selection made in
   Tasks has to be cleared when the Inbox is opened — otherwise "complete 3 selected" would
   silently reach across into rows the person never looked at, from a bar they did not open. */
let bulkScope = "tasks";

function bulkListConfig() {
  return bulkScope === "inbox"
    ? { listId: "inboxList", toggleId: "inboxBulkToggle", reRender: () => renderInbox(activeInboxFilter) }
    : { listId: "tasksList", toggleId: "bulkToggle", reRender: () => renderTasks(activeTaskFilter) };
}

/* The bar and its toggle exist in two views, so they are both updated from here rather than
   whichever view happened to be rendered. Duplicating the markup per view is how the two drift. */
/* One template for the bulk bar, used by both views.

   Written once because a second copy of this markup is a second thing to remember to update, and
   the failure is quiet: the Inbox ends up with no Delete button and nobody notices until someone
   needs it. The labels and the id are the only differences between the two bars. */
function bulkBarMarkup({ barId, countId }) {
  return `<div
      id="${barId}"
      class="bulk-bar"
      hidden
      style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;border:1px solid var(--border);border-radius:10px;background:var(--card);position:sticky;top:0;z-index:5"
    >
      <span id="${countId}" style="font-size:13px;font-weight:600;color:var(--text)">0 selected</span>
      <button class="btn" data-bulk-needs-selection onclick="bulkComplete()">
        <i data-lucide="check" aria-hidden="true"></i><span>Complete</span>
      </button>
      <button class="btn" data-bulk-needs-selection onclick="bulkArchive()">
        <i data-lucide="archive" aria-hidden="true"></i><span>Archive</span>
      </button>
      <button class="btn danger" data-bulk-needs-selection onclick="bulkDelete()">
        <i data-lucide="trash-2" aria-hidden="true"></i><span>Delete</span>
      </button>
      <button class="btn" onclick="selectAllVisible()">
        <i data-lucide="list-checks" aria-hidden="true"></i><span>Select all</span>
      </button>
      <button class="btn" onclick="toggleSelectMode(false)">
        <i data-lucide="x" aria-hidden="true"></i><span>Done</span>
      </button>
    </div>`;
}

/* The scope is a fixed literal from this module, never anything a person typed, so it is passed as
   a data attribute and read by one delegated handler rather than interpolated into a quoted
   inline handler. The repo's rule is that no `${...}` lands inside quotes in an on* attribute —
   an apostrophe in the value would be a SyntaxError and the control would silently do nothing. A
   scope would never contain one, but the rule is there to stop the next value from being
   free text, and this way the next value cannot break it either. */
function bulkToggleMarkup(toggleId, scope) {
  if (scope !== "inbox" && scope !== "tasks") return "";
  return `<button class="btn" id="${toggleId}" data-bulk-scope="${scope}" style="margin-top:12px">
      <i data-lucide="list-checks" aria-hidden="true"></i><span>Select multiple</span>
    </button>`;
}

/* Mounts the Inbox's bar and toggle. Idempotent, because it runs on every render and re-writing
   innerHTML would throw away the bar's open state and its button states on each pass. */
function mountInboxBulkBar() {
  const barMount = document.getElementById("inboxBulkMount");
  if (barMount && !document.getElementById("inboxBulkBar")) {
    barMount.innerHTML = bulkBarMarkup({ barId: "inboxBulkBar", countId: "inboxBulkCount" });
  }
  const toggleMount = document.getElementById("inboxBulkToggleMount");
  if (toggleMount && !document.getElementById("inboxBulkToggle")) {
    toggleMount.innerHTML = bulkToggleMarkup("inboxBulkToggle", "inbox");
    refreshIcons();
  }
}

/* Entering select mode from a view's own toggle has to say which list it is for, or the Inbox
   would act on a selection the person made in Tasks. */
/* One delegated listener for both toggles, so neither is written as an inline handler and the
   scope never has to be interpolated into a quoted attribute. */
function initBulkToggles() {
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest?.("[data-bulk-scope]");
    if (!toggle) return;
    enterBulkScope(toggle.dataset.bulkScope);
  });
}

function enterBulkScope(scope) {
  if (bulkScope !== scope) {
    bulkSelection = new Set();
    selectMode = false;
  }
  bulkScope = scope;
  toggleSelectMode(true);
}

function bulkBarElements() {
  return {
    bar: document.getElementById("bulkBar"),
    toggle: document.getElementById("bulkToggle"),
    inboxBar: document.getElementById("inboxBulkBar"),
    inboxToggle: document.getElementById("inboxBulkToggle"),
  };
}

/* Reorder is only offered on "All" and "Today". On Overdue or Completed the list is already
   ordered by a rule, and a manual order that silently outranks "3 days late" would make the tab
   lie about what it is showing. */
function taskListReorderable(filter) {
  return filter === "all" || filter === "today";
}

/* Applies a saved order to a freshly sorted list. Called after the list's own sort, so a manual
   order wins on "All" and "Today" while Overdue and Completed keep their rule-based sort. */
function sortTasksByStoredOrder(tasks) {
  const stored = readStoredOrder(TASK_ORDER_KEY);
  // Nothing saved, or nothing that still resolves: leave the list's own order alone rather than
  // sorting every row to the same rank and letting the original sort survive by accident.
  if (!stored.some((id) => tasks.some((t) => t.id === id))) return tasks;
  const rank = (id) => {
    const index = stored.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...tasks].sort((a, b) => rank(a.id) - rank(b.id));
}

function isSelected(id) {
  return bulkSelection.has(id);
}

function toggleSelectMode(force) {
  selectMode = force === undefined ? !selectMode : Boolean(force);
  if (!selectMode) bulkSelection = new Set();
  bulkListConfig().reRender();
}

function toggleSelected(id) {
  if (!selectMode) return;
  if (bulkSelection.has(id)) bulkSelection.delete(id);
  else bulkSelection.add(id);
  bulkListConfig().reRender();
}

function selectAllVisible() {
  const { listId } = bulkListConfig();
  const ids = [...document.querySelectorAll(`#${listId} .task-row`)]
    .map((row) => row.dataset.reorderId)
    .filter(Boolean);
  if (!ids.length) return;
  const everySelected = ids.every((id) => bulkSelection.has(id));
  ids.forEach((id) => (everySelected ? bulkSelection.delete(id) : bulkSelection.add(id)));
  bulkListConfig().reRender();
}

/* Re-renders whichever list the selection belongs to. Every bulk action ends here rather than
   calling renderTasks() directly, so completing an Inbox selection cannot refresh Tasks and leave
   the Inbox showing rows that are already done. */
function renderBulkView() {
  bulkListConfig().reRender();
}

function renderBulkBar() {
  const { bar, inboxBar, toggle, inboxToggle } = bulkBarElements();
  const target = bulkScope === "inbox" ? inboxBar : bar;
  if (!target) return;
  const count = bulkSelection.size;
  target.hidden = !selectMode;
  if (!selectMode) {
    // The other view's bar must go too, or a stale bar sits on a page whose rows it cannot select.
    const other = bulkScope === "inbox" ? bar : inboxBar;
    if (other) other.hidden = true;
    return;
  }
  const label = document.getElementById(bulkScope === "inbox" ? "inboxBulkCount" : "bulkCount");
  if (label) label.textContent = count === 1 ? "1 selected" : `${count} selected`;
  target.querySelectorAll("[data-bulk-needs-selection]")
    .forEach((btn) => (btn.disabled = count === 0));
  // The toggle has to follow the bar, or the way out of select mode disappears with it.
  if (toggle) toggle.hidden = selectMode;
  if (inboxToggle) inboxToggle.hidden = selectMode;
}

/* One place decides what a bulk action means, so Complete and Archive cannot disagree about
   whether a recurring task spawns the next occurrence. */
async function bulkComplete() {
  const items = bulkSelectedItems();
  if (!items.length) return;
  for (const item of items) {
    if (item.done) continue;
    if (item.kind === "task") await completeTask(item);
    else {
      item.done = true;
      item.completedAt = Date.now();
      item.status = "completed";
      await dbSaveItem(item);
    }
  }
  bulkSelection = new Set();
  renderAll();
  renderBulkView();
}

async function bulkArchive() {
  const items = bulkSelectedItems();
  if (!items.length) return;
  const archived = [];
  for (const item of items) {
    if (isArchived(item)) continue;
    item.archivedAt = Date.now();
    cancelReminderFor(item.id);
    await dbSaveItem(item);
    archived.push({ ...item });
  }
  bulkSelection = new Set();
  renderAll();
  // Undo rather than a confirm(): archiving is reversible in a way that deleting is not, and the
  // capture flow already established that a tap beats a dialog.
  if (archived.length) showUndoAction(`Archived ${archived.length} item${archived.length === 1 ? "" : "s"}`, () => unarchiveItems(archived));
  renderBulkView();
}

async function unarchiveItems(items) {
  for (const saved of items) {
    const item = state.items.find((i) => i.id === saved.id);
    if (!item) continue;
    item.archivedAt = 0;
    await dbSaveItem(item);
  }
  renderAll();
  renderBulkView();
}

/* Delete asks first, then offers undo as well. The confirm covers the accidental bulk tap, which
   is the case that actually loses work; the undo covers the case where the person saw the dialog,
   agreed with it, and changed their mind thirty seconds later — which a dialog cannot help with. */
async function bulkDelete() {
  const items = bulkSelectedItems();
  if (!items.length) return;
  if (!confirm(`Delete ${items.length} item${items.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
  const removed = items.map((item) => ({ ...item }));
  for (const item of items) {
    state.items = state.items.filter((i) => i.id !== item.id);
    await dbDeleteItem(item.id, item);
  }
  bulkSelection = new Set();
  renderAll();
  showUndoAction(`Deleted ${removed.length} item${removed.length === 1 ? "" : "s"}`, () => restoreItems(removed));
  renderBulkView();
}

/* Restoring puts the items back at the end rather than their original position, and does not
   resurrect a recurring occurrence. Both are honest: the series key is a generated id, so
   silently recreating a scheduled future task would be a surprise, not an undo. */
async function restoreItems(items) {
  for (const saved of items) {
    if (state.items.some((i) => i.id === saved.id)) continue;
    const restored = { ...saved, archivedAt: 0, done: false, completedAt: "" };
    state.items.unshift(restored);
    await dbSaveItem(restored);
  }
  renderAll();
  renderBulkView();
}

/* A generic undo bar, sharing the capture flow's element, styling and 8-second life. The
   alternative was a second near-identical bar, and two undo bars would drift — which is how one
   of them ends up with a shorter timeout and no way to tell which is showing. */
function showUndoAction(message, onUndo) {
  const bar = document.getElementById("captureUndo");
  if (!bar) return;
  pendingUndoAction = onUndo;
  clearTimeout(captureUndoTimer);
  bar.innerHTML = `${icon("check")} <span>${escapeHtml(message)}</span> <button type="button" class="capture-undo-btn">Undo</button>`;
  bar.querySelector(".capture-undo-btn").onclick = () => {
    const action = pendingUndoAction;
    dismissCaptureUndo();
    if (action) action();
  };
  bar.hidden = false;
  refreshIcons();
  captureUndoTimer = setTimeout(dismissCaptureUndo, 8000);
}

function bulkSelectedItems() {
  return [...bulkSelection]
    .map((id) => state.items.find((i) => i.id === id))
    .filter(Boolean);
}

function taskRow(item, options = {}) {
  const row = document.createElement("div");
  row.className = "task-row" + (item.done ? " done" : "") + (isArchived(item) ? " archived" : "");
  // Carried as data, not as a closure lookup, because the bulk bar and select-all both read the
  // ids back out of the DOM to find what is on screen.
  row.dataset.reorderId = item.id;
  if (isSelected(item.id)) row.classList.add("selected");
  if (options.reorderable) row.classList.add("reorderable");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.onclick = (e) => {
    if (e.target.closest(".checkbox, button")) return;
    // A swipe ends with a click. Without this the row opened the very item being swiped, which
    // defeats the gesture completely. Scoped to this row and read once, so a deliberate press on a
    // revealed action button is never swallowed.
    if (row.swallowNextClick) {
      row.swallowNextClick = false;
      return;
    }
    // A row left slid open by a swipe swallows the first tap meant for something else, so a tap
    // anywhere closes it instead of opening the item behind it.
    if (row.classList.contains("swiped-open")) {
      closeOpenSwipe();
      return;
    }
    // In select mode a tap anywhere on the row toggles it. Making people aim at a small circle
    // for a fifty-item selection is how bulk features get abandoned.
    if (selectMode) {
      toggleSelected(item.id);
      return;
    }
    openPanel(item.id);
  };
  row.onkeydown = (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selectMode) toggleSelected(item.id);
      else openPanel(item.id);
    }
  };
  const check = document.createElement("button");
  check.type = "button";
  check.className = "checkbox" + (item.done ? " checked" : "");
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", String(Boolean(item.done)));
  check.setAttribute("aria-label", item.done ? "Reopen task" : "Complete task");
  check.innerHTML = item.done ? icon("check") : "";
  check.onclick = () => {
    if (!isArchived(item)) toggleDone(item.id);
  };
  if (isArchived(item)) {
    check.disabled = true;
    check.setAttribute("aria-label", "Archived task");
  }
  row.appendChild(check);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  let mediaHtml = "";
  if (item.kind === "voice" && item.mediaUrl)
    mediaHtml = `<audio controls src="${escapeHtml(item.mediaUrl)}" style="height:28px;margin-top:4px;"></audio>`;
  if (item.kind === "image" && item.mediaUrl)
    mediaHtml = `<img src="${escapeHtml(item.mediaUrl)}" style="max-width:120px;border-radius:6px;margin-top:4px;display:block;">`;
  if (item.kind === "file" && item.mediaUrl)
    mediaHtml = `<a href="${escapeHtml(item.mediaUrl)}" target="_blank" rel="noreferrer" style="font-size:12.5px;color:var(--accent);">Open file</a>`;
  if (item.kind === "link")
    mediaHtml = `<a href="${escapeHtml(item.title)}" target="_blank" rel="noreferrer" style="font-size:12.5px;color:var(--accent);">${escapeHtml(item.title)}</a>`;
  const progress = checklistProgress(item);
  const progressHtml = progress.total
    ? `<div class="task-progress">${icon("list-checks")} ${progress.completed}/${progress.total} steps</div>`
    : "";
  meta.innerHTML = `<div class="task-title">${item.scope === "private" ? icon("lock") + " " : ""}${escapeHtml(item.kind === "link" ? "Link" : item.title)}</div><div class="task-sub">${escapeHtml(item.sub || "")}${item.person ? ` · <span>${icon("user")} ${escapeHtml(item.person)}</span>` : ""}</div>${progressHtml}${mediaHtml}`;
  row.appendChild(meta);

  if (item.due) {
    const t = document.createElement("div");
    t.className = "task-time";
    t.innerHTML =
      (item.recurrence && item.recurrence !== "none" ? icon("repeat") + " " : "") +
      escapeHtml(item.due);
    row.appendChild(t);
  }
  if (item.kind === "task") {
    row.appendChild(taskStatusBadge(item));
    if (isArchived(item)) {
      const archived = document.createElement("span");
      archived.className = "badge archived";
      archived.textContent = "Archived";
      row.appendChild(archived);
    } else if (item.priority) {
      const priority = document.createElement("span");
      const priorityClass = ["low", "medium", "high", "urgent"].includes(String(item.priority).toLowerCase())
        ? String(item.priority).toLowerCase()
        : "task";
      priority.className = `badge ${priorityClass}`;
      priority.textContent = String(item.priority).charAt(0).toUpperCase() + String(item.priority).slice(1);
      row.appendChild(priority);
    }
  } else {
    const badge = document.createElement("span");
    badge.className = "badge " + (item.priority || item.kind);
    badge.textContent = item.priority
      ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1)
      : item.status || item.kind;
    row.appendChild(badge);
  }
  /* Swipe is opt-in per list, and never on a list that is also reorderable. Reordering and swiping
     on one row would be two competing horizontal gestures, and the person would get whichever one
     the browser happened to recognise first. */
  if (options.swipeable) {
    row.classList.add("swipeable");
    attachSwipeActions(row, item);
  }
  return row;
}

const taskMutationInFlight = new Set();
