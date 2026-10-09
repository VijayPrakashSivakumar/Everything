/* ---------- Rename and remove people and projects ----------
   Items link to a person or a project by name, not by id. That is why a name is the identity, and it
   is why there was no way out of a typo: "Hom" stranded every item tagged with it, and the only fix
   was opening each item by hand. Renaming now carries the items along in one step.

   Untagging is the other half. Deleting a person must clear the tag, because renderPeople() infers
   people from the items that mention them — leaving the tag would re-infer the person immediately
   and make Delete look like it had done nothing. */
function retagItems(field, oldName, newName) {
  const changed = [];
  state.items.forEach((i) => {
    if (!sameName(i[field], oldName)) return;
    i[field] = newName;
    changed.push(i);
  });
  return changed;
}

async function persistRetagged(items) {
  for (const i of items) await dbSaveItem(i);
}

function personNameTaken(name, exceptName) {
  return state.people.some((p) => !sameName(p.name, exceptName) && sameName(p.name, name));
}

async function renamePerson(oldName, newName) {
  const next = String(newName == null ? "" : newName).trim();
  if (!next) {
    await alertDialog({ title: "A name is required", body: "A person needs a name before anything can be tagged with them." });
    return;
  }
  if (personNameTaken(next, oldName)) {
    await alertDialog({ title: "That name is taken", body: `"${next}" is already in your people list. Pick another, or merge the two.` });
    return;
  }
  const person = state.people.find((p) => sameName(p.name, oldName));
  if (person) {
    person.name = next;
    await dbSavePerson(person);
  }
  // A case-only rename ("ravi" to "Ravi") has no visual effect here but still has to be written
  // through, so every item ends up carrying the corrected spelling.
  await persistRetagged(retagItems("person", oldName, next));
  closePersonModal();
  renderAll();
}

function startRenamePerson() {
  if (!currentPersonName) return;
  const typed = prompt(
    "Rename this person. Everything linked to them follows the new name.",
    currentPersonName,
  );
  if (typed === null) return;
  renamePerson(currentPersonName, typed);
}

async function deletePerson(name) {
  const linked = state.items.filter((i) => sameName(i.person, name) && !isArchived(i));
  const many = linked.length !== 1;
  const ok = await confirmDialog({
    title: "Remove this person?",
    body: `${linked.length} item${many ? "s" : ""} will no longer be tagged with "${name}". The items themselves are kept.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  closePersonModal();
  const person = state.people.find((p) => sameName(p.name, name));
  if (person) await dbDeletePerson(person.id);
  await persistRetagged(retagItems("person", name, ""));
  renderAll();
}

/* ---------- Merging duplicate people ----------
   A person is identified by their name string, and names arrive from typing, from imports and from
   item tags — so one human easily becomes two rows ("Ravi" and "Ravi Kumar"). Merging keeps the
   person you pick, folds the other's notes and contact details into it, retags every item, and
   deletes the duplicate record. That is why this lives beside rename and remove: all three exist
   because the name is the identity. */
async function mergePerson(sourceName, targetName) {
  const from = String(sourceName == null ? "" : sourceName).trim();
  const into = String(targetName == null ? "" : targetName).trim();
  if (!from || !into) return;
  if (sameName(from, into)) {
    await alertDialog({ title: "Pick a different person", body: `"${from}" and "${into}" are the same person, so there is nothing to merge them into.` });
    return;
  }
  const target = state.people.find((p) => sameName(p.name, into));
  if (!target) {
    await alertDialog({ title: "Not in your people list", body: `"${into}" does not exist yet. Add them first, then merge.` });
    return;
  }
  const source = state.people.find((p) => sameName(p.name, from));
  const linked = state.items.filter((i) => sameName(i.person, from) && !isArchived(i));
  const many = linked.length !== 1;
  const ok = await confirmDialog({
    title: `Merge "${from}" into "${into}"?`,
    body: `${linked.length} item${many ? "s" : ""} will move onto "${into}", and the "${from}" record is deleted. Their notes are combined.`,
    confirmLabel: "Merge",
    danger: true,
  });
  if (!ok) return;
  closePersonModal();
  // Notes are kept from both sides, de-duplicated so merging twice cannot duplicate the text.
  const notes = [...new Set([target.notes, source?.notes].map((n) => (n || "").trim()).filter(Boolean))];
  target.notes = notes.join("\n\n");
  ["phone", "email", "birthday"].forEach((field) => {
    if (!target[field] && source && source[field]) target[field] = source[field];
  });
  // The flag follows the record that carried it, but only one person is "me", so it is taken from
  // either side rather than added: merging your own record into a duplicate would otherwise leave
  // the survivor showing nobody's age.
  target.ownBirthday = Boolean(target.ownBirthday || (source && source.ownBirthday));
  await dbSavePerson(target);
  // An inferred-only source has no record of its own, so only its tags need moving.
  if (source) await dbDeletePerson(source.id);
  await persistRetagged(retagItems("person", from, into));
  renderAll();
}

function startMergePerson() {
  if (!currentPersonName) return;
  const select = document.getElementById("personMergeTarget");
  mergePerson(currentPersonName, select ? select.value : "");
}

/* ---------- Projects ---------- */
async function addProject() {
  const input = document.getElementById("newProjectInput");
  const name = input.value.trim();
  if (!name) return;
  // Same guard as addPersonManual. Without it, "Home" and "home" both get created, and because
  // items are matched to projects by name each card then shows the same items — the counts double.
  if (state.projects.some((p) => sameName(p.name, name))) {
    input.value = "";
    return;
  }
  const p = { id: cid(), name, created: Date.now() };
  state.projects.unshift(p);
  input.value = "";
  await dbSaveProject(p);
}

async function renameProject(id, newName) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  const next = String(newName == null ? "" : newName).trim();
  if (!next) {
    await alertDialog({ title: "A name is required", body: "A project needs a name before tasks can be grouped under it." });
    return;
  }
  if (state.projects.some((p) => p.id !== id && sameName(p.name, next))) {
    await alertDialog({ title: "That name is taken", body: `"${next}" is already a project. Pick another, or merge the two.` });
    return;
  }
  const previous = project.name;
  project.name = next;
  await dbSaveProject(project);
  await persistRetagged(retagItems("project", previous, next));
  renderProjects();
}

function startRenameProject(id, name) {
  const typed = prompt(
    "Rename this project. Everything linked to it follows the new name.",
    name,
  );
  if (typed === null) return;
  renameProject(id, typed);
}
function renderProjects() {
  const el = document.getElementById("projectsList");
  if (!el) return;
  if (!state.projects.length) {
    el.innerHTML = emptyStateHTML({
      title: "Anything worth grouping",
      body: "A project is something with more than one step to it. Start one, put the tasks under it, and watch it move instead of hunting through a list.",
      action: "document.getElementById('newProjectInput')?.focus()",
      actionLabel: "Start a project",
    });
    return;
  }
  el.innerHTML = state.projects
    .map((p) => {
      const items = state.items.filter((i) => sameName(i.project, p.name) && !isArchived(i));
      const done = items.filter((i) => i.done).length;
      const total = items.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `<div class="card">
      <div class="card-head">
        <h3>${escapeHtml(p.name)}</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge task">${total - done} open</span>
          <button class="btn" style="padding:4px 10px;font-size:12px;" onclick="startRenameProject(${jsStr(p.id)}, ${jsStr(p.name)})">Rename</button>
          <button class="btn danger" style="padding:4px 10px;font-size:12px;" onclick="deleteProject(${jsStr(p.id)}, ${jsStr(p.name)})">Delete</button>
        </div>
      </div>
      ${
        total
          ? `<div style="background:var(--bg);border-radius:6px;height:6px;margin-bottom:12px;overflow:hidden;">
        <div style="background:var(--green-fg);height:100%;width:${pct}%;transition:width .3s;"></div>
      </div><p style="font-size:12px;color:var(--muted);margin:-6px 0 12px;">${pct}% complete (${done}/${total})</p>`
          : ""
      }
      ${items.length ? items.map((i) => `<div class="task-row" onclick="openPanel(${jsStr(i.id)})"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? icon("check") : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`).join("") : '<p class="empty">No items here yet.</p>'}
    </div>`;
    })
    .join("");
}

/* ---------- Goals ---------- */
async function addGoal() {
  const input = document.getElementById("newGoalInput");
  const title = input.value.trim();
  if (!title) return;
  // Same guard as addProject: items link to a goal by title, so two goals sharing one title would
  // each claim the other's items and report the same progress twice.
  if (state.goals.some((g) => sameName(g.title, title))) {
    input.value = "";
    return;
  }
  const dateInput = document.getElementById("newGoalDate");
  const g = {
    id: cid(),
    title,
    done: false,
    status: "active",
    created: Date.now(),
    targetDate: dateInput ? dateInput.value.trim() : "",
  };
  // A stable id is required so the backend can dedupe this record on the next sync ("originalId" is
  // what the server borrows when rebuilding the client key). Without it, the prototype path above
  // floated the record in localStorage only, and a refresh silently dropped it.
  g.client_id = g.id;
  g.originalId = g.id;
  state.goals.unshift(g);
  input.value = "";
  if (dateInput) dateInput.value = "";
  await dbSaveGoal(g);
}
async function toggleGoal(id) {
  const g = state.goals.find((g) => g.id === id);
  if (!g) return;
  g.done = !g.done;
  g.status = g.done ? "completed" : "active";
  await dbSaveGoal(g);
}
/* Goals are identified by their title now that items link to them by name, so a rename has to carry
   those items along — exactly what renameProject does — and a title already in use is refused. */
async function renameGoal(id, newTitle) {
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return;
  const next = String(newTitle == null ? "" : newTitle).trim();
  if (!next) {
    await alertDialog({ title: "Give it a title", body: "A goal needs a title, otherwise there is nothing to measure against." });
    return;
  }
  if (state.goals.some((g) => g.id !== id && sameName(g.title, next))) {
    await alertDialog({ title: "That title is taken", body: `"${next}" is already a goal. Pick another, or merge the two.` });
    return;
  }
  const previous = goal.title;
  goal.title = next;
  await dbSaveGoal(goal);
  await persistRetagged(retagItems("goal", previous, next));
  renderGoals();
}

function startRenameGoal(id, title) {
  const typed = prompt("Rename this goal.", title);
  if (typed === null) return;
  renameGoal(id, typed);
}

function renderGoals() {
  const el = document.getElementById("goalsList");
  if (!el) return;
  if (!state.goals.length) {
    el.innerHTML = emptyStateHTML({
      title: "The thing underneath the tasks",
      body: "Pick what's actually going right this year. Tasks you link to it show how far you've come, which is the part a to-do list can't tell you.",
      action: "document.getElementById('newGoalInput')?.focus()",
      actionLabel: "Set a goal",
    });
    return;
  }

  const isGoalDone = (g) => Boolean(g.done ?? (g.status === "completed"));
  const active = state.goals.filter((g) => !isGoalDone(g));
  const done = state.goals.filter((g) => isGoalDone(g));

  const renderLinked = (i) => `<div class="task-row" onclick="openPanel(${jsStr(i.id)})"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? icon("check") : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`;

  const renderRow = (g) => {
    // Goals arrive from the backend as `status` ("active"/"completed"/"paused"/"archived") with `done`
    // in metadata, or from the older prototype as a boolean `done`. Normalize both so the row renders
    // identically regardless of where the record came from.
    const done = Boolean(g.done ?? (g.status === "completed"));
    const days = Math.floor((Date.now() - g.created) / 86400000);
    // Items link to a goal by title, exactly as they link to a project by name, so progress is
    // computed from them rather than stored and left to drift.
    const items = goalItems(g.title);
    const finished = items.filter((i) => i.done).length;
    const total = items.length;
    const pct = total ? Math.round((finished / total) * 100) : 0;
    const target = goalTargetLabel(g);
    const when = done
      ? "Completed"
      : days === 0
        ? "Started today"
        : `In progress · ${days} day${days !== 1 ? "s" : ""}`;
    return `<div class="task-row">
      <div class="checkbox ${done ? "checked" : ""}" onclick="toggleGoal(${jsStr(g.id)})">${done ? icon("check") : ""}</div>
      <div class="task-meta">
        <div class="task-title" style="${done ? "text-decoration:line-through;color:var(--muted);" : ""}">${escapeHtml(g.title)}</div>
        <div class="task-sub">${when}${target ? ` · ${escapeHtml(target)}` : ""}</div>
      </div>
      <button class="btn" style="padding:4px 10px;font-size:12px;" onclick="startRenameGoal(${jsStr(g.id)}, ${jsStr(g.title)})">Rename</button>
      <button class="btn" style="padding:4px 10px;font-size:12px;" onclick="startSetGoalDate(${jsStr(g.id)}, ${jsStr(g.targetDate || "")})">Date</button>
      <button class="btn danger" style="padding:4px 10px;font-size:12px;" onclick="deleteGoal(${jsStr(g.id)})">Delete</button>
    </div>
    ${
      total
        ? `<div style="background:var(--bg);border-radius:6px;height:6px;margin:8px 0 6px;overflow:hidden;">
        <div style="background:var(--green-fg);height:100%;width:${pct}%;transition:width .3s;"></div>
      </div><p style="font-size:12px;color:var(--muted);margin:0 0 8px;">${pct}% complete (${finished}/${total})</p>${items.map(renderLinked).join("")}`
        : '<p style="font-size:12px;color:var(--muted);margin:0 0 8px;">No items linked yet — set a Goal on an item to track its progress here.</p>'
    }`;
  };

  let html = "";
  if (active.length) html += active.map(renderRow).join("");
  if (done.length)
    html +=
      `<div class="card-head" style="margin-top:${active.length ? "16px" : "0"};"><h3 style="font-size:13px;color:var(--muted);">Completed (${done.length})</h3></div>` +
      done.map(renderRow).join("");
  el.innerHTML = html;
}

/* The items linked to a goal, matched by title the way renderProjects matches by name. */
function goalItems(title) {
  return state.items.filter((i) => sameName(i.goal, title) && !isArchived(i));
}

/* Days run from local midnight, so "Due today" does not become "Overdue by 1 day" after lunch. */
function goalTargetLabel(g) {
  if (!g || !g.targetDate) return "";
  const target = Date.parse(`${g.targetDate}T00:00:00`);
  if (Number.isNaN(target)) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today.getTime()) / 86400000);
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

/* A target date is typed as YYYY-MM-DD; blank clears it. The goals table has no column for one, so it
   rides inside metadata — see buildStructuredRecordPayload. The day is compared back because an
   out-of-range one like 2026-02-31 is silently rolled forward by the Date parser. */
async function setGoalDate(id, value) {
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return;
  const raw = String(value == null ? "" : value).trim();
  const parsed = raw ? new Date(`${raw}T00:00:00`) : null;
  const usable = !raw ||
    (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(parsed.getTime()) && parsed.getDate() === Number(raw.slice(8)));
  if (!usable) {
    await alertDialog({ title: "Use a real date", body: "Write it like 2026-12-31, or leave it blank to clear it." });
    return;
  }
  goal.targetDate = raw;
  await dbSaveGoal(goal);
  renderGoals();
}

function startSetGoalDate(id, current) {
  const typed = prompt("Target date for this goal (YYYY-MM-DD, blank to clear).", current || "");
  if (typed === null) return;
  setGoalDate(id, typed);
}

/* Items only store a `done` flag, so we keep a small local log of *when* something
   was completed. Used by the Reports activity chart. */
let doneLog = {};
try {
  doneLog = JSON.parse(localStorage.getItem("everything_done_log_v1") || "{}");
} catch (e) {
  doneLog = {};
}

function logCompletion(id, done) {
  if (done) doneLog[id] = Date.now();
  else delete doneLog[id];
  try {
    localStorage.setItem("everything_done_log_v1", JSON.stringify(doneLog));
  } catch (e) {}
}

/* When an item was completed: the stored timestamp when we have one (items.completed_at,
   or this device's log on an un-migrated database), otherwise fall back to when it was
   captured. */
function completedWhen(item) {
  return item.completedAt || doneLog[item.id] || item.created;
}

const REVIEW_DONE_DAYS = 7;
const REVIEW_QUIET_PROJECT_DAYS = 14;
/* Lists show this many rows before the section asks whether to show the rest. Twelve is enough to
   recognise the shape of the week without pushing the next card below the fold on a phone. */
const REVIEW_ROW_LIMIT = 12;

/* Which sections this device has opened up, like the Insights expansion: a view convenience, not
   data. It is neither synced nor stored on an item, and it resets with the session. */
let expandedReviewSections = new Set();
function toggleReviewSection(key) {
  if (expandedReviewSections.has(key)) expandedReviewSections.delete(key);
  else expandedReviewSections.add(key);
  renderReview();
}

/* A stat tile counts a list that lives *below it on the same page*, so the tile brings that list
   into view rather than navigating — except "Open", which is a count of everything and belongs to
   the Inbox, the way the Dashboard tiles jump. */
function reviewJumpTo(targetId) {
  const el = document.getElementById(targetId);
  if (el) el.scrollIntoView({ block: "start" });
}
function reviewJumpToInbox() {
  switchView("inbox");
  renderInbox("all");
}
async function toggleReviewDone(id, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  await toggleDone(id);
  renderReview();
  if (typeof renderNav === "function") renderNav();
  if (typeof renderToday === "function") renderToday();
}

/* The stuck list: overdue plus quiet-too-long waiting, deduplicated and soonest-first. Extracted
   from renderReview() because it is also the number the nav badge shows, and the badge must not
   depend on the view having been rendered first (the cold-load comment in core.js). */
function reviewStuckItems(now = Date.now()) {
  const open = currentItems().filter((item) => !item.done && !isArchived(item));

  const overdue = open.filter((item) => isOverdue(item));
  const staleWaiting = open.filter(
    (item) =>
      item.kind === "waiting" &&
      !item.dueDate &&
      Number(item.created || 0) > 0 &&
      Number(item.created) < now - REVIEW_QUIET_PROJECT_DAYS * 86400000,
  );
  // Overdue and stale waiting rarely overlap; if they do, the item is listed once, not twice.
  return [...overdue, ...staleWaiting]
    .filter((item, index, list) => list.findIndex((o) => o.id === item.id) === index)
    .sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0) || a.created - b.created);
}
function reviewStuckCount() {
  return reviewStuckItems().length;
}

/* Rows up to the limit, then a real control for the rest — the old code appended dead text
   ("and N more — open the view they belong to") to the stuck list and silently dropped rows from
   the other two. The cap is now a preview, not a wall. */
function reviewRowsHTML(list, sectionKey, rowHTML) {
  const expanded = expandedReviewSections.has(sectionKey);
  const shown = expanded ? list : list.slice(0, REVIEW_ROW_LIMIT);
  const tail =
    list.length > REVIEW_ROW_LIMIT
      ? `<div style="padding:6px 0 2px"><button class="link-btn" onclick="toggleReviewSection(${jsStr(sectionKey)})">${expanded ? "Show fewer" : `Show all (${list.length})`}</button></div>`
      : "";
  return shown.map(rowHTML).join("") + tail;
}

function renderReview() {
  const statsEl = document.getElementById("reviewStats");
  if (!statsEl) return;

  const now = Date.now();
  const open = currentItems().filter((item) => !item.done && !isArchived(item));

  const stuck = reviewStuckItems(now);

  const doneWeek = currentItems()
    .filter((item) => item.done && !isArchived(item))
    .filter((item) => completedWhen(item) >= now - REVIEW_DONE_DAYS * 86400000)
    .sort((a, b) => completedWhen(b) - completedWhen(a));

  // Open work with no day and no rhythm: it can never surface on its own, so nothing else in the
  // app will ever mention it. This is the same gap the next-step card and the digest both look for.
  const undated = open.filter(
    (item) =>
      !item.dueDate &&
      !item.recurrence &&
      (item.kind === "task" || item.kind === "waiting"),
  );

  /* Every tile is a shortcut: the three counts jump to the list they count — all three are on this
     page — and Open goes to the Inbox, which is where "everything open" lives everywhere else in the
     app. A tile that only displays a number is half a control. */
  statsEl.innerHTML = `
    <div class="stat-card" onclick="reviewJumpTo('reviewStuckCard')" style="cursor:pointer" title="Jump to what needs a decision"><div class="stat-icon" style="background:var(--red-bg);color:var(--red-fg);"><i data-lucide="triangle-alert"></i></div><div><div class="stat-num">${stuck.length}</div><div class="stat-label">Need a decision</div></div></div>
    <div class="stat-card" onclick="reviewJumpTo('reviewDoneCard')" style="cursor:pointer" title="Jump to what you finished"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);"><i data-lucide="circle-check"></i></div><div><div class="stat-num">${doneWeek.length}</div><div class="stat-label">Finished this week</div></div></div>
    <div class="stat-card" onclick="reviewJumpTo('reviewUndatedCard')" style="cursor:pointer" title="Jump to work with no day"><div class="stat-icon" style="background:var(--amber-bg);color:var(--amber-fg);"><i data-lucide="calendar-x"></i></div><div><div class="stat-num">${undated.length}</div><div class="stat-label">No next step</div></div></div>
    <div class="stat-card" onclick="reviewJumpToInbox()" style="cursor:pointer" title="Open the Inbox"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);"><i data-lucide="inbox"></i></div><div><div class="stat-num">${open.length}</div><div class="stat-label">Open</div></div></div>
  `;
  refreshIcons();

  const stuckEl = document.getElementById("reviewStuck");
  if (stuckEl) {
    stuckEl.innerHTML = stuck.length
      ? reviewRowsHTML(stuck, "stuck", (item) => `<div class="task-row" onclick="openPanel(${jsStr(item.id)})" style="cursor:pointer">
        <div class="task-meta"><div class="task-title">${escapeHtml(item.title)}</div>
        <div class="task-sub">${escapeHtml(reviewStuckReason(item))}</div></div></div>`)
      : emptyStateHTML({
            /* "That is a good week" was doing the work in the old copy, so the body keeps the warmth
               and stops apologising. Nothing about this screen is an absence. */
            title: "Nothing's stuck",
            body: "Nothing has been sitting past its date. Nothing to do here — keep it that way.",
            tone: "good",
          });
  }

  const doneEl = document.getElementById("reviewDone");
  if (doneEl) {
    doneEl.innerHTML = doneWeek.length
      ? reviewRowsHTML(doneWeek, "done", (item) => `<div class="task-row"><div class="checkbox checked" onclick="toggleReviewDone(${jsStr(item.id)}, event)">${icon("check")}</div>
        <div class="task-meta" onclick="openPanel(${jsStr(item.id)})" style="cursor:pointer"><div class="task-title">${escapeHtml(item.title)}</div>
        <div class="task-sub">Finished ${timeAgo(completedWhen(item))}</div></div></div>`)
      : emptyStateHTML({
            title: "Nothing finished in the last 7 days",
            body: "Completions show up here for a week after they happen. Tick something off and it will appear.",
          });
  }

  const projectsEl = document.getElementById("reviewProjects");
  if (projectsEl) projectsEl.innerHTML = reviewQuietProjects(now);

  const undatedEl = document.getElementById("reviewUndated");
  if (undatedEl) {
    undatedEl.innerHTML = undated.length
      ? reviewRowsHTML(undated, "undated", (item) => `<div class="task-row" onclick="openPanel(${jsStr(item.id)})" style="cursor:pointer">
        <div class="task-meta"><div class="task-title">${escapeHtml(item.title)}</div>
        <div class="task-sub">${item.kind === "waiting" ? "Waiting, with no check-back day" : "No day on it"}</div></div></div>`)
      : emptyStateHTML({
        title: "Everything open has a day or a rhythm",
        body: "Nothing here because there is nothing unscheduled. Anything without a day would appear on this list.",
      });
  }
}

/* Says *why* something is stuck, because "overdue" alone does not tell you whether to do it, move
   it, or drop it — and that choice is the whole point of a review. */
function reviewStuckReason(item) {
  if (isOverdue(item)) {
    const days = Math.max(1, Math.round((Date.now() - new Date(item.dueDate).getTime()) / 86400000));
    return `Overdue by ${days} day${days === 1 ? "" : "s"}`;
  }
  const days = Math.max(1, Math.round((Date.now() - Number(item.created || Date.now())) / 86400000));
  return `Waiting ${days} day${days === 1 ? "" : "s"} with no check-back`;
}

/* A project is quiet when nothing in it has moved for a fortnight — not when it is old, and not
   when it is empty. A project with no items has nothing to be stuck on. */
function reviewQuietProjects(now) {
  const cutoff = now - REVIEW_QUIET_PROJECT_DAYS * 86400000;
  const live = currentItems().filter((item) => !isArchived(item));
  const names = [
    ...new Set(live.map((item) => String(item.project || "").trim()).filter(Boolean)),
  ];

  const quiet = [];
  for (const name of names) {
    const inProject = live.filter((item) => item.project === name);
    if (!inProject.length) continue;
    // "Moving" is a completion or a new capture. A project that only collects new items and never
    // finishes any is not quiet, it is working.
    const lastMoved = inProject.reduce((latest, item) => {
      const touched = Math.max(Number(item.created || 0), item.done ? completedWhen(item) : 0);
      return Math.max(latest, touched);
    }, 0);
    if (lastMoved < cutoff) {
      quiet.push({ name, open: inProject.filter((item) => !item.done).length });
    }
  }

  if (!quiet.length)
    return emptyStateHTML({
      /* The probe pins /moved recently/i — this is the sentence an empty account and a healthy one
         both get, and both are true: nothing has gone quiet. */
      title: "Every project has moved recently",
      body: "A project shows up here when nothing in it has changed for two weeks.",
      tone: "good",
    });
  return quiet
    .map(
      (p) => `<div class="task-row" onclick="switchView('projects')" style="cursor:pointer">
      <div class="task-meta"><div class="task-title">${escapeHtml(p.name)}</div>
      <div class="task-sub">Nothing for ${REVIEW_QUIET_PROJECT_DAYS} days · ${p.open} still open</div></div></div>`,
    )
    .join("");
}

/* ---------- Reports ---------- */
let reportGeneratedAt = 0;

function renderReports() {
  const statsEl = document.getElementById("reportStats");
  if (!statsEl) return;
  const messageEl = document.getElementById("reportMessage");
  const resultsEl = document.getElementById("reportResults");
  const exportButton = document.getElementById("reportExportButton");
  if (!state) {
    messageEl.hidden = false;
    messageEl.className = "report-state";
    messageEl.setAttribute("role", "status");
    messageEl.innerHTML = `<span class="report-state-spinner" aria-hidden="true"></span><span>Loading your workspace data…</span>`;
    resultsEl.hidden = true;
    exportButton.disabled = true;
    return;
  }
  if (!Array.isArray(state.items)) {
    messageEl.hidden = false;
    messageEl.className = "report-state is-error";
    messageEl.setAttribute("role", "alert");
    messageEl.innerHTML = `<i data-lucide="triangle-alert" aria-hidden="true"></i><span>Reports could not be created because workspace records are unavailable. Reload the page to try again.</span>`;
    resultsEl.hidden = true;
    exportButton.disabled = true;
    refreshIcons();
    return;
  }

  messageEl.hidden = true;
  messageEl.setAttribute("role", "status");
  resultsEl.hidden = false;
  const searchEl = document.getElementById("reportSearch");
  const periodEl = document.getElementById("reportPeriod");
  const kindEl = document.getElementById("reportKind");
  const statusEl = document.getElementById("reportStatusFilter");
  const query = searchEl.value.trim().toLocaleLowerCase();
  const period = periodEl.value;
  const selectedKind = kindEl.value;
  const selectedStatus = statusEl.value;
  const now = Date.now();
  const days = period === "all" ? 0 : Number(period);
  const cutoff = days ? now - days * 86400000 : 0;
  const allItems = state.items.filter((item) => item && !isArchived(item));

  const kinds = [...new Set(allItems.map((item) => item.kind || "other"))].sort();
  if (selectedKind !== "all" && !kinds.includes(selectedKind)) kinds.push(selectedKind);
  const kindOptions = `<option value="all">All types</option>${kinds
    .map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(reportKindLabel(kind))}</option>`)
    .join("")}`;
  if (kindEl.innerHTML !== kindOptions) kindEl.innerHTML = kindOptions;
  kindEl.value = selectedKind;

  const matches = allItems
    .filter((item) => {
      const created = reportTimestamp(item.created);
      if (cutoff && (!created || created < cutoff)) return false;
      if (selectedKind !== "all" && (item.kind || "other") !== selectedKind) return false;
      if (selectedStatus === "open" && item.done) return false;
      if (selectedStatus === "completed" && !item.done) return false;
      if (!query) return true;
      const searchable = [
        item.title,
        item.description,
        item.project,
        item.person,
        item.kind,
        item.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return searchable.includes(query);
    })
    .sort((a, b) => reportTimestamp(b.created) - reportTimestamp(a.created));

  const completed = matches.filter((item) => item.done).length;
  const openTasks = matches.filter((item) => item.kind === "task" && !item.done).length;
  const taskCount = matches.filter((item) => item.kind === "task").length;
  const completedTaskCount = matches.filter((item) => item.kind === "task" && item.done).length;
  const completionRate = taskCount ? Math.round((completedTaskCount / taskCount) * 100) : 0;
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);">${icon("inbox")}</div><div><div class="stat-num">${matches.length}</div><div class="stat-label">Matching records</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);">${icon("circle-check")}</div><div><div class="stat-num">${completed}</div><div class="stat-label">Completed</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--amber-bg);color:var(--amber-fg);">${icon("list-todo")}</div><div><div class="stat-num">${openTasks}</div><div class="stat-label">Open tasks</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);">${icon("chart-no-axes-combined")}</div><div><div class="stat-num">${completionRate}%</div><div class="stat-label">Task completion rate</div></div></div>
  `;
  refreshIcons();

  const byType = {};
  matches.forEach((item) => {
    const kind = item.kind || "other";
    byType[kind] = (byType[kind] || 0) + 1;
  });
  const typeEl = document.getElementById("reportByType");
  const maxCount = Math.max(...Object.values(byType), 1);
  typeEl.innerHTML = Object.keys(byType).length
    ? Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => {
          const [, fg] = kindColor(kind);
          const pct = Math.round((count / maxCount) * 100);
          return `<button class="report-type-row${kind === selectedKind ? " is-selected" : ""}" type="button" onclick="setReportKind(${jsStr(kind)})" aria-pressed="${kind === selectedKind}">
            <span class="report-type-label">${kindIcon(kind)}<span>${escapeHtml(reportKindLabel(kind))}</span></span>
            <span class="report-type-count">${count}</span>
            <span class="report-type-track" aria-hidden="true"><span style="width:${pct}%;background:${fg}"></span></span>
          </button>`;
        })
        .join("")
    : emptyNoteHTML(
        allItems.length
          ? "No records match these filters. Try a wider date range or clear the search."
          : "Your workspace is ready for its first records. Capture something to start building a report.",
      );

  const countEl = document.getElementById("reportPreviewCount");
  countEl.textContent = `${matches.length} record${matches.length === 1 ? "" : "s"}`;
  const previewEl = document.getElementById("reportPreview");
  previewEl.innerHTML = matches.length
    ? matches
        .map((item) => {
          const created = reportTimestamp(item.created);
          const status = item.done ? "Completed" : item.status || "Open";
          return `<button class="report-item" type="button" onclick="openPanel(${jsStr(item.id)})">
            <span class="report-item-icon">${kindIcon(item.kind || "other")}</span>
            <span class="report-item-main">
              <span class="report-item-title">${escapeHtml(item.title || "Untitled")}</span>
              <span class="report-item-meta">${escapeHtml(reportKindLabel(item.kind || "other"))}${item.project ? ` · ${escapeHtml(item.project)}` : ""}${item.person ? ` · ${escapeHtml(item.person)}` : ""}</span>
            </span>
            <span class="report-item-date">${created ? new Date(created).toLocaleDateString() : "Date unavailable"}</span>
            <span class="report-item-status${item.done ? " is-complete" : ""}">${escapeHtml(status)}</span>
          </button>`;
        })
        .join("")
    : allItems.length
      ? `<p class="empty">No records match these filters. Try a wider date range, another status, or clear your search.</p><button class="btn btn-sm" type="button" onclick="clearReportFilters()">Clear filters</button>`
      : emptyStateHTML({
          title: "Your activity is waiting to take shape",
          body: "Capture tasks, notes, documents, and moments; they will appear here so you can review patterns, understand progress, and export a useful snapshot.",
          action: "openCapture()",
          actionLabel: "Capture something",
        });

  const chartEl = document.getElementById("reportChart");
  if (chartEl) chartEl.innerHTML = renderActivityChart(14, matches);
  exportButton.disabled = matches.length === 0;
  const generatedEl = document.getElementById("reportGeneratedAt");
  generatedEl.textContent = reportGeneratedAt
    ? `Last generated ${new Date(reportGeneratedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Current view: ${matches.length} matching records`
    : "Filters update the preview automatically. Generate a report to mark a snapshot.";
}

function reportTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value) || 0;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function reportKindLabel(kind) {
  return String(kind || "other")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function setReportKind(kind) {
  const select = document.getElementById("reportKind");
  if (!select) return;
  select.value = kind;
  renderReports();
}

function clearReportFilters() {
  document.getElementById("reportSearch").value = "";
  document.getElementById("reportPeriod").value = "30";
  document.getElementById("reportKind").value = "all";
  document.getElementById("reportStatusFilter").value = "all";
  renderReports();
}

function generateReport() {
  reportGeneratedAt = Date.now();
  renderReports();
}

function reportCsvCell(value) {
  let text = String(value ?? "");
  if (/^[\t\r =+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportReport() {
  if (!state || !Array.isArray(state.items)) return;
  const search = document.getElementById("reportSearch").value.trim().toLocaleLowerCase();
  const period = document.getElementById("reportPeriod").value;
  const kind = document.getElementById("reportKind").value;
  const status = document.getElementById("reportStatusFilter").value;
  const cutoff = period === "all" ? 0 : Date.now() - Number(period) * 86400000;
  const rows = state.items
    .filter((item) => {
      if (!item || isArchived(item)) return false;
      const created = reportTimestamp(item.created);
      if (cutoff && (!created || created < cutoff)) return false;
      if (kind !== "all" && (item.kind || "other") !== kind) return false;
      if (status === "open" && item.done) return false;
      if (status === "completed" && !item.done) return false;
      if (!search) return true;
      return [
        item.title,
        item.description,
        item.project,
        item.person,
        item.kind,
        item.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(search);
    })
    .sort((a, b) => reportTimestamp(b.created) - reportTimestamp(a.created));
  if (!rows.length) return;

  const columns = ["Title", "Type", "Status", "Created", "Completed", "Due date", "Project", "Person"];
  const csv = [
    columns.map(reportCsvCell).join(","),
    ...rows.map((item) =>
      [
        item.title || "Untitled",
        reportKindLabel(item.kind || "other"),
        item.done ? "Completed" : item.status || "Open",
        reportTimestamp(item.created) ? new Date(reportTimestamp(item.created)).toISOString() : "",
        item.done && reportTimestamp(item.completedAt || doneLog[item.id])
          ? new Date(reportTimestamp(item.completedAt || doneLog[item.id])).toISOString()
          : "",
        item.dueDate || "",
        item.project || "",
        item.person || "",
      ]
        .map(reportCsvCell)
        .join(","),
    ),
  ].join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `everything-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Captured vs completed per day, using the same filtered records as the preview. */
function renderActivityChart(days, items = currentItems()) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets = [];
  const indexByDay = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    indexByDay[d.toDateString()] = buckets.length;
    buckets.push({ date: d, captured: 0, completed: 0 });
  }

  items.forEach((item) => {
    const created = reportTimestamp(item.created);
    if (!created) return;
    const capturedAt = indexByDay[new Date(created).toDateString()];
    if (capturedAt !== undefined) buckets[capturedAt].captured++;

    const completedStamp = reportTimestamp(item.completedAt || doneLog[item.id]);
    if (item.done && completedStamp) {
      const completedAt = indexByDay[new Date(completedStamp).toDateString()];
      if (completedAt !== undefined) buckets[completedAt].completed++;
    }
  });

  const max = Math.max(
    ...buckets.map((b) => Math.max(b.captured, b.completed)),
    1,
  );

  return buckets
    .map((b) => {
      const capturedH = Math.round((b.captured / max) * 100);
      const completedH = Math.round((b.completed / max) * 100);
      const label = b.date.toLocaleDateString(undefined, { day: "numeric" });
      const tip = `${fmtDate(b.date)} — ${b.captured} captured, ${b.completed} completed`;
      return `<div class="chart-col" title="${tip}">
      <div class="chart-bars">
        <div class="chart-bar" style="height:${capturedH}%;background:var(--accent);"></div>
        <div class="chart-bar" style="height:${completedH}%;background:var(--green-fg);"></div>
      </div>
      <div class="chart-label">${label}</div>
    </div>`;
    })
    .join("");
}

/* ---------- Birthdays and important dates ----------
   A birthday was stored on every person from the start and then never shown again. The data was
   already there; only the surface was missing, which made this the cheapest thing on the list.

   The person who owns a birth year sees an age; nobody else does, and a family member's year of
   birth is not ours to display. Leap-day birthdays are handled explicitly because
   new Date("02-29") lands on 1 March in a non-leap year, which would quietly move that birthday to
   the wrong day three years out of four. */

const IMPORTANT_DATE_LEAD_DAYS = 30;

/* Days from today until this date's next anniversary, or null when there is no date to celebrate. A
   date already past this year means next year — that is the whole point of an annual date, and a
   birthday on 1 January is "today" every 1 January rather than 364 days away. */
function daysUntilAnnual(monthDay, from) {
  if (!monthDay) return null;
  // Only the MONTH and DAY matter — the year is what makes an annual date recur. The stored form is
  // YYYY-MM-DD, so a naive split gave month = 2026 and day = 10, and the anniversary resolved to
  // the year 2026 instead of this one. Every birthday came back tens of thousands of days away and
  // was then dropped by the lead window, so the feature was silently dead.
  const parts = String(monthDay).trim().split("-");
  const month = Number(parts.length >= 3 ? parts[1] : parts[0]);
  const day = Number(parts.length >= 3 ? parts[2] : parts[1]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const today = new Date(from);
  today.setHours(0, 0, 0, 0);

  // 29 February does not exist in a common year, so it is celebrated on 28 February. Drifting to
  // 1 March would be a different date, and a wrong one.
  const leapDay = month === 2 && day === 29;
  const anniversary = (year) => {
    const candidate = new Date(year, month - 1, day);
    if (leapDay && !(candidate.getMonth() === 1 && candidate.getDate() === 29)) {
      return new Date(year, 1, 28);
    }
    return candidate;
  };

  let next = anniversary(today.getFullYear());
  if (next < today) next = anniversary(today.getFullYear() + 1);
  return Math.round((next - today) / 86400000);
}

function yearsSinceBirth(birthday) {
  const year = Number(String(birthday).split("-")[0]);
  if (!Number.isFinite(year) || year < 1900) return null;
  return new Date().getFullYear() - year;
}

/* Everyone with an important date coming up, soonest first. Sorted by days away rather than by name
   so the next one is always first, which is the only order this list is useful in. */
function upcomingImportantDates(from) {
  const out = [];
  (state.people || []).forEach((p) => {
    if (!p.birthday) return;
    const days = daysUntilAnnual(p.birthday, from || Date.now());
    if (days === null || days > IMPORTANT_DATE_LEAD_DAYS) return;
    out.push({
      personId: p.id,
      name: p.name,
      date: p.birthday,
      days,
      // ownBirthday is the person saying "this is me". Without it the year of birth is not ours to
      // show, so no age is rendered and only the date itself appears.
      own: Boolean(p.ownBirthday),
      years: p.ownBirthday ? yearsSinceBirth(p.birthday) : null,
    });
  });
  return out.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));
}

/* "in 3 days" / "tomorrow" / "today", with "turns 30" only on the person's own record. */
function importantDateLabel(entry) {
  const when = entry.days === 0 ? "today" : entry.days === 1 ? "tomorrow" : `in ${entry.days} days`;
  if (entry.years) return `birthday ${when} · turns ${entry.years}`;
  return `birthday ${when}`;
}

function renderUpcomingDates() {
  const host = document.getElementById("upcomingDates");
  if (!host) return;
  const entries = upcomingImportantDates();
  if (!entries.length) {
    // Hidden rather than an empty card: a permanent "nothing coming up" box teaches nothing and
    // takes the space a real one would need.
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML =
    `<div class="card-head"><h3>Coming up</h3><button class="link-btn" onclick="switchView('people')">All people →</button></div>` +
    entries
      .map(
        (entry) =>
          `<div class="upcoming-date-row" onclick="openPersonModal(${jsStr(entry.personId)}, ${jsStr(entry.name)})">
            <span class="upcoming-date-icon">${icon("cake")}</span>
            <div><div class="upcoming-date-name">${escapeHtml(entry.name)}</div>
            <div class="upcoming-date-when">${escapeHtml(importantDateLabel(entry))}</div></div>
          </div>`,
      )
      .join("");
}

/* What has lapsed, or lapses within the week, on the Dashboard.

   A reminder only helps if the thing is still there when it arrives, and a lapsed warranty that
   quietly disappeared behind a notification is the case where the reminder has already failed.
   Same rule as the birthdays card above: hidden when there is nothing, never an empty box. */
function renderExpiringDocuments() {
  const host = document.getElementById("expiringDocuments");
  if (!host) return;
  const items = documentsNeedingAttention();
  if (!items.length) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML =
    `<div class="card-head"><h3>Expiring soon</h3><button class="link-btn" onclick="switchView('documents')">All documents →</button></div>` +
    items
      .slice(0, 4)
      .map(
        (item) =>
          `<div class="upcoming-date-row" onclick="openPanel(${jsStr(item.id)})">
            <span class="upcoming-date-icon">${icon(documentBucket(item) === "expired" ? "alert-triangle" : "file-badge")}</span>
            <div><div class="upcoming-date-name">${escapeHtml(item.title)}</div>
            <div class="upcoming-date-when">${escapeHtml(documentLabel(item))}</div></div>
          </div>`,
      )
      .join("");
}
