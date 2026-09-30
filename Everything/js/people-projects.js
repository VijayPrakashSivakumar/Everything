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
    alert("A name is required.");
    return;
  }
  if (personNameTaken(next, oldName)) {
    alert(`"${next}" is already in your people list.`);
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
  if (
    !confirm(
      `Remove "${name}"? ${linked.length} linked item${many ? "s" : ""} will no longer be tagged with them. The items themselves are kept.`,
    )
  )
    return;
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
    alert("Pick a different person to merge into.");
    return;
  }
  const target = state.people.find((p) => sameName(p.name, into));
  if (!target) {
    alert(`"${into}" is not in your people list.`);
    return;
  }
  const source = state.people.find((p) => sameName(p.name, from));
  const linked = state.items.filter((i) => sameName(i.person, from) && !isArchived(i));
  const many = linked.length !== 1;
  if (
    !confirm(
      `Merge "${from}" into "${into}"? ${linked.length} linked item${many ? "s" : ""} will move onto "${into}", and the "${from}" record is deleted.`,
    )
  )
    return;
  closePersonModal();
  // Notes are kept from both sides, de-duplicated so merging twice cannot duplicate the text.
  const notes = [...new Set([target.notes, source?.notes].map((n) => (n || "").trim()).filter(Boolean))];
  target.notes = notes.join("\n\n");
  ["phone", "email", "birthday"].forEach((field) => {
    if (!target[field] && source && source[field]) target[field] = source[field];
  });
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
    alert("A name is required.");
    return;
  }
  if (state.projects.some((p) => p.id !== id && sameName(p.name, next))) {
    alert(`"${next}" is already a project.`);
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
    el.innerHTML =
      '<div class="card"><p class="empty">No projects yet.</p></div>';
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
    created: Date.now(),
    targetDate: dateInput ? dateInput.value.trim() : "",
  };
  state.goals.unshift(g);
  input.value = "";
  if (dateInput) dateInput.value = "";
  await dbSaveGoal(g);
}
async function toggleGoal(id) {
  const g = state.goals.find((g) => g.id === id);
  if (g) {
    g.done = !g.done;
    await dbSaveGoal(g);
  }
}
/* Goals are identified by their title now that items link to them by name, so a rename has to carry
   those items along — exactly what renameProject does — and a title already in use is refused. */
async function renameGoal(id, newTitle) {
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return;
  const next = String(newTitle == null ? "" : newTitle).trim();
  if (!next) {
    alert("A goal needs a title.");
    return;
  }
  if (state.goals.some((g) => g.id !== id && sameName(g.title, next))) {
    alert(`"${next}" is already a goal.`);
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
    el.innerHTML = '<p class="empty">No goals set yet.</p>';
    return;
  }

  const active = state.goals.filter((g) => !g.done);
  const done = state.goals.filter((g) => g.done);

  const renderLinked = (i) => `<div class="task-row" onclick="openPanel(${jsStr(i.id)})"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? icon("check") : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`;

  const renderRow = (g) => {
    const days = Math.floor((Date.now() - g.created) / 86400000);
    // Items link to a goal by title, exactly as they link to a project by name, so progress is
    // computed from them rather than stored and left to drift.
    const items = goalItems(g.title);
    const finished = items.filter((i) => i.done).length;
    const total = items.length;
    const pct = total ? Math.round((finished / total) * 100) : 0;
    const target = goalTargetLabel(g);
    const when = g.done
      ? "Completed"
      : days === 0
        ? "Started today"
        : `In progress · ${days} day${days !== 1 ? "s" : ""}`;
    return `<div class="task-row">
      <div class="checkbox ${g.done ? "checked" : ""}" onclick="toggleGoal(${jsStr(g.id)})">${g.done ? icon("check") : ""}</div>
      <div class="task-meta">
        <div class="task-title" style="${g.done ? "text-decoration:line-through;color:var(--muted);" : ""}">${escapeHtml(g.title)}</div>
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
    alert("Use a date like 2026-12-31, or leave it blank to clear it.");
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

function renderReview() {
  const statsEl = document.getElementById("reviewStats");
  if (!statsEl) return;

  const now = Date.now();
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
  const stuck = [...overdue, ...staleWaiting]
    .filter((item, index, list) => list.findIndex((o) => o.id === item.id) === index)
    .sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0) || a.created - b.created);

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

  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--red-bg);color:var(--red-fg);"><i data-lucide="triangle-alert"></i></div><div><div class="stat-num">${stuck.length}</div><div class="stat-label">Need a decision</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);"><i data-lucide="circle-check"></i></div><div><div class="stat-num">${doneWeek.length}</div><div class="stat-label">Finished this week</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--amber-bg);color:var(--amber-fg);"><i data-lucide="calendar-x"></i></div><div><div class="stat-num">${undated.length}</div><div class="stat-label">No next step</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);"><i data-lucide="inbox"></i></div><div><div class="stat-num">${open.length}</div><div class="stat-label">Open</div></div></div>
  `;
  refreshIcons();

  const stuckEl = document.getElementById("reviewStuck");
  if (stuckEl) {
    stuckEl.innerHTML = stuck.length
      ? stuck
          .slice(0, 12)
          .map(
            (item) => `<div class="task-row" onclick="openPanel(${jsStr(item.id)})" style="cursor:pointer">
        <div class="task-meta"><div class="task-title">${escapeHtml(item.title)}</div>
        <div class="task-sub">${escapeHtml(reviewStuckReason(item))}</div></div></div>`,
          )
          .join("") +
        (stuck.length > 12
          ? `<p class="empty">and ${stuck.length - 12} more — open the view they belong to.</p>`
          : "")
      : '<p class="empty">Nothing is stuck. That is a good week.</p>';
  }

  const doneEl = document.getElementById("reviewDone");
  if (doneEl) {
    doneEl.innerHTML = doneWeek.length
      ? doneWeek
          .slice(0, 12)
          .map(
            (item) => `<div class="task-row"><div class="checkbox checked">${icon("check")}</div>
        <div class="task-meta"><div class="task-title">${escapeHtml(item.title)}</div>
        <div class="task-sub">Finished ${timeAgo(completedWhen(item))}</div></div></div>`,
          )
          .join("")
      : '<p class="empty">Nothing finished in the last 7 days.</p>';
  }

  const projectsEl = document.getElementById("reviewProjects");
  if (projectsEl) projectsEl.innerHTML = reviewQuietProjects(now);

  const undatedEl = document.getElementById("reviewUndated");
  if (undatedEl) {
    undatedEl.innerHTML = undated.length
      ? undated
          .slice(0, 12)
          .map(
            (item) => `<div class="task-row" onclick="openPanel(${jsStr(item.id)})" style="cursor:pointer">
        <div class="task-meta"><div class="task-title">${escapeHtml(item.title)}</div>
        <div class="task-sub">${item.kind === "waiting" ? "Waiting, with no check-back day" : "No day on it"}</div></div></div>`,
          )
          .join("")
      : '<p class="empty">Everything open has a day or a rhythm.</p>';
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

  if (!quiet.length) return '<p class="empty">Every project has moved recently.</p>';
  return quiet
    .map(
      (p) => `<div class="task-row" onclick="switchView('projects')" style="cursor:pointer">
      <div class="task-meta"><div class="task-title">${escapeHtml(p.name)}</div>
      <div class="task-sub">Nothing for ${REVIEW_QUIET_PROJECT_DAYS} days · ${p.open} still open</div></div></div>`,
    )
    .join("");
}

/* ---------- Reports ---------- */
function renderReports() {
  const statsEl = document.getElementById("reportStats");
  if (!statsEl) return;
  const weekAgo = Date.now() - 7 * 86400000;
  const allTasks = state.items.filter((i) => i.kind === "task" && !isArchived(i));
  const completedTasks = allTasks.filter((i) => i.done);
  const completed = state.items.filter((i) => i.done && !isArchived(i));
  const createdThisWeek = state.items.filter((i) => i.created >= weekAgo && !isArchived(i));
  const completionRate = allTasks.length
    ? Math.round((completedTasks.length / allTasks.length) * 100)
    : 0;
  const byType = {};
  state.items.forEach((i) => {
    if (isArchived(i)) return;
    byType[i.kind] = (byType[i.kind] || 0) + 1;
  });

  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);"><i data-lucide="circle-check"></i></div><div><div class="stat-num">${completed.length}</div><div class="stat-label">Completed</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);"><i data-lucide="inbox"></i></div><div><div class="stat-num">${createdThisWeek.length}</div><div class="stat-label">Captured this week</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);"><i data-lucide="chart-no-axes-combined"></i></div><div><div class="stat-num">${completionRate}%</div><div class="stat-label">Task completion rate</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--amber-bg);color:var(--amber-fg);"><i data-lucide="target"></i></div><div><div class="stat-num">${state.goals.filter((g) => !g.done).length}</div><div class="stat-label">Open goals</div></div></div>
  `;
  refreshIcons();

  const completedEl = document.getElementById("reportCompleted");
  completedEl.innerHTML = completed.length
    ? [...completed]
        .sort((a, b) => completedWhen(b) - completedWhen(a))
        .slice(0, 10)
        .map(
          (i) =>
            `<div class="task-row"><div class="checkbox checked">${icon("check")}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">Completed ${timeAgo(completedWhen(i))}</div></div></div>`,
        )
        .join("")
    : '<p class="empty">Nothing finished yet.</p>';

  const typeEl = document.getElementById("reportByType");
  const maxCount = Math.max(...Object.values(byType), 1);
  typeEl.innerHTML = Object.keys(byType).length
    ? Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => {
          const pct = Math.round((v / maxCount) * 100);
          const [bg, fg] = kindColor(k);
          return `<div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;"><span>${kindIcon(k)} ${k.charAt(0).toUpperCase() + k.slice(1)}</span><span>${v}</span></div>
          <div style="background:var(--bg);border-radius:6px;height:8px;overflow:hidden;"><div style="background:${fg};height:100%;width:${pct}%;"></div></div>
        </div>`;
        })
        .join("")
    : '<p class="empty">No data yet.</p>';

  const chartEl = document.getElementById("reportChart");
  if (chartEl) chartEl.innerHTML = renderActivityChart(14);
}

/* Captured vs completed per day for the last `days` days. */
function renderActivityChart(days) {
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

  state.items.forEach((item) => {
    if (isArchived(item)) return;
    const capturedAt = indexByDay[new Date(item.created).toDateString()];
    if (capturedAt !== undefined) buckets[capturedAt].captured++;

    const completedStamp = item.completedAt || doneLog[item.id];
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
