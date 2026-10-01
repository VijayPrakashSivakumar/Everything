const SUPABASE_URL = "https://fyikavzqkezjykvxhqnz.supabase.co"; // e.g. https://xxxx.supabase.co
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5aWthdnpxa2V6anlrdnhocW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MTA3NDAsImV4cCI6MjEwNTM4Njc0MH0.nNI8-lKsVJCo1vTYCsmQNchBkaOOkJ5ur0FQz_d4QeI";

// Bump when the DOM contract in index.html changes. See repairVersionMismatch() below.
const APP_BUILD = "2026-09-30.1";

/* A deploy can briefly serve a mixed build: fresh index.html alongside a cached style.css or
   script.js. The new markup then calls handlers the old script never defined, which looks like a
   broken app rather than a caching artefact (a collapsed search bar, clicks doing nothing).

   index.html carries the build it expects; if the running script does not match, the page
   reloads once from the network. Reloading is guarded by a session flag so a genuinely broken
   deploy cannot loop forever. */
function repairVersionMismatch() {
  const meta = document.querySelector('meta[name="everything-build"]');
  const expected = meta ? meta.getAttribute("content") : null;
  if (!expected || expected === APP_BUILD) return;

  if (sessionStorage.getItem("everythingBuildRepair") === expected) return;
  sessionStorage.setItem("everythingBuildRepair", expected);
  console.warn(
    `Stale app shell detected (page wants ${expected}, running ${APP_BUILD}). Reloading from the network.`,
  );
  // Tell the worker to step aside so it cannot re-serve the stale shell for this navigation.
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "SKIP_WAITING" });
  }
  location.replace(location.href.split("#")[0] + "?build=" + expected);
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* Opening index.html straight from disk runs the app on the file:// protocol, where the
   browser refuses every fetch("/api/...") call with a bare 403. The server is never reached,
   so a locally opened file silently loses login, sync, and AI Ask. Detect it up front and say
   so plainly instead of surfacing a meaningless Forbidden. */
function isFileProtocol() {
  return typeof location !== "undefined" && location.protocol === "file:";
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (typeof sb?.auth?.getSession === "function") {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}


const STRUCTURED_SYNC_QUEUE_PREFIX = "everything_structured_sync_v1:";
const STRUCTURED_SYNC_MAX_ATTEMPTS = 12;
let structuredSyncTimer = null;
let structuredSyncRunning = false;
let structuredSyncQueuedAgain = false;

function structuredQueueStorageKey() {
  return `${STRUCTURED_SYNC_QUEUE_PREFIX}${sbUser || "anonymous"}`;
}

function readStructuredSyncQueue() {
  try {
    const raw = localStorage.getItem(structuredQueueStorageKey());
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.filter((item) => item && item.key && item.kind) : [];
  } catch (err) {
    console.warn("Structured sync queue could not be read:", err.message || err);
    return [];
  }
}

function writeStructuredSyncQueue(queue) {
  try {
    localStorage.setItem(structuredQueueStorageKey(), JSON.stringify(queue));
  } catch (err) {
    console.warn("Structured sync queue could not be saved:", err.message || err);
  }
}

function structuredOperationKey(kind, action, householdId, clientId) {
  return `${kind}:${action}:${householdId || "none"}:${clientId || "none"}`;
}

function replaceStructuredSyncOperation(operation) {
  const queue = readStructuredSyncQueue();
  const identity = (item) =>
    item.kind === operation.kind &&
    item.clientId === operation.clientId &&
    item.householdId === operation.householdId;
  const next = {
    ...operation,
    id: operation.id || `${operation.key}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    attempts: operation.attempts || 0,
    queuedAt: operation.queuedAt || Date.now(),
  };
  const filtered = queue.filter((item) => !identity(item) || item.key === operation.key);
  const existing = filtered.findIndex((item) => item.key === operation.key);
  if (existing >= 0) filtered[existing] = next;
  else filtered.push(next);
  writeStructuredSyncQueue(filtered);
  structuredSyncQueuedAgain = true;
  return next;
}

function updateStructuredSyncOperation(id, patch) {
  const queue = readStructuredSyncQueue();
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return;
  queue[index] = { ...queue[index], ...patch };
  writeStructuredSyncQueue(queue);
}

function removeStructuredSyncOperation(id) {
  const queue = readStructuredSyncQueue();
  const next = queue.filter((item) => item.id !== id);
  if (next.length !== queue.length) writeStructuredSyncQueue(next);
}

function structuredResponseNeedsRetry(result) {
  if (!result || result.ok) return false;
  if (result.status === 0) return true;
  return result.status === 401 || result.status === 408 || result.status === 409 || result.status === 425 || result.status === 429 || result.status >= 500;
}

async function structuredRequest(path, options = {}) {
  try {
    const response = await apiFetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      data = {};
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    console.warn("Structured sync request failed:", err.message || err);
    return { ok: false, status: 0, data: {} };
  }
}


function structuredSyncAvailable() {
  return Boolean(sbUser && currentHouseholdId && typeof fetch === "function");
}

function queueStructuredOperation(operation) {
  if (!structuredSyncAvailable() || !operation?.clientId) return false;
  const key = operation.key || structuredOperationKey(operation.kind, operation.action, currentHouseholdId, operation.clientId);
  const queued = replaceStructuredSyncOperation({
    ...operation,
    key,
    userId: operation.userId || sbUser,
    householdId: currentHouseholdId,
  });
  void flushStructuredSyncQueue();
  return queued;
}

function normaliseCaptureMetadata(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function itemSnapshot(item) {
  return {
    id: item.id,
    ownerId: item.ownerId || null,
    scope: item.scope || "shared",
    kind: item.kind || "text",
    title: item.title || "",
    sub: item.sub || "",
    priority: item.priority || "",
    person: item.person || "",
    due: item.due || "",
    dueDate: item.dueDate || null,
    recurrence: item.recurrence || "none",
    status: item.kind === "task" ? taskStatusFromItem(item) : item.status || "inbox",
    checklist: normaliseChecklist(item.checklist),
    recurrenceKey: item.recurrenceKey || null,
    archivedAt: item.archivedAt || null,
    project: item.project || "",
    goal: item.goal || "",
    created: item.created || Date.now(),
    done: Boolean(item.done),
    notified: Boolean(item.notified),
    notifiedAt: item.notifiedAt || null,
    snoozedUntil: item.snoozedUntil || null,
    mediaUrl: item.mediaUrl || "",
    completedAt: item.completedAt || null,
    sourceType: item.sourceType || "manual",
    rawText: item.rawText || item.title || "",
    captureMetadata: normaliseCaptureMetadata(item.captureMetadata),
    captureFingerprint: item.captureFingerprint || null,
    updatedAt: Number(item.updatedAt) || 0,
    dirty: item.dirty === true,
    // Document fields. Present in the snapshot even when the database has not been migrated, so an
    // export taken before the migration is not quietly missing them.
    docType: item.docType || "",
    issuer: item.issuer || "",
    docNumber: item.docNumber || "",
    issuedOn: item.issuedOn || "",
    expiresOn: item.expiresOn || "",
  };
}

function queueStructuredItemSync(item, action = "upsert") {
  if (!item?.id) return false;
  return queueStructuredOperation({
    kind: "item",
    action,
    clientId: item.id,
    item: itemSnapshot(item),
  });
}

function queueStructuredRecordSync(kind, record, action = "upsert") {
  if (!record?.id) return false;
  return queueStructuredOperation({
    kind,
    action,
    clientId: record.id,
    record: { ...record },
  });
}

function normaliseStructuredRecord(kind, row) {
  if (!row) return row;
  const clientId = row.client_id || row.clientId || row.metadata?.originalId || row.metadata?.original_id || row.id;
  const normalized = {
    ...row,
    id: clientId || row.id,
    clientId,
    backendId: row.id,
    scope: row.scope || row.visibility || row.metadata?.scope || "shared",
    ownerId: row.user_id || row.owner_id || null,
    created: row.created ?? (row.created_at ? Date.parse(row.created_at) : Date.now()),
    // projects/goals/people already carry updated_at with a server-side trigger, so unlike items
    // this is the server's clock and not the edit time. That is a real asymmetry and is the
    // reason their conflicts are ordered by "when the server recorded the write" — a difference of
    // seconds in practice, and a single consistent clock rather than a comparison across two
    // device clocks that cannot be trusted to agree.
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
    // A row that came back from the server is by definition already stored there.
    dirty: false,
  };
  if (kind === "goal") {
    normalized.done = row.done ?? row.status === "completed";
    // The target date has no column of its own, so it rides in metadata and must be lifted back out.
    if (!normalized.targetDate && row.metadata?.targetDate) normalized.targetDate = row.metadata.targetDate;
  }
  if (kind === "person") {
    // Contact details are stored in metadata, so without this they would be dropped on the next load.
    ["phone", "email", "birthday"].forEach((field) => {
      if (!normalized[field] && row.metadata && row.metadata[field]) normalized[field] = row.metadata[field];
    });
    // ownBirthday is a flag, not a string, so the same copy is written with one difference: an
    // absent key must not clear a flag the other device set. `in` is the test — a metadata object
    // that simply predates the flag has no key at all, and a truthiness check would silently reset
    // "this is me" on the next load of an older row.
    if (row.metadata && "ownBirthday" in row.metadata) normalized.ownBirthday = Boolean(row.metadata.ownBirthday);
  }
  return normalized;
}

/* --- Conflict-safe merge for projects, goals and people ---------------------------------

   These three had the same bug that items had, in the same place, and it was left in place when
   items was fixed:

     if (projectRows) state.projects = projectRows.map(...)   // wholesale replace
     if (goalRows)     state.goals    = goalRows.map(...)     // wholesale replace
     if (peopleRows)   state.people   = peopleRows.map(...)   // wholesale replace

   A person added on a phone with no signal vanished on the next load, along with their phone
   number and every item linked to them. The same three rules as items apply here — keep what the
   server has never seen, take the server's copy when this device is clean, and on a genuine
   divergence keep *both* versions rather than silently picking one. */

const RECORD_LIST_KEY = { project: "projects", goal: "goals", person: "people" };

function recordTitle(kind, record) {
  return String(record?.title || record?.name || "Untitled").trim();
}

/* Identity and sync bookkeeping are excluded: two copies of one record differ on those by
   definition, and counting that as a difference would report a conflict on every single sync. */
function recordContentKey(record) {
  if (!record) return "";
  const copy = { ...record };
  ["id", "clientId", "backendId", "created", "updatedAt", "dirty", "ownerId", "scope"].forEach(
    (key) => delete copy[key],
  );
  // Sorted keys, because JSON.stringify preserves insertion order and two records assembled by
  // different code paths would otherwise serialise differently and look like a conflict.
  return JSON.stringify(Object.keys(copy).sort().map((key) => [key, copy[key]]));
}

function mergeRecordPair(localRecord, remoteRecord, kind) {
  const clean = { ...remoteRecord, dirty: false };
  if (localRecord.dirty !== true) return { item: clean, conflict: null };
  if (recordContentKey(localRecord) === recordContentKey(remoteRecord)) {
    return { item: clean, conflict: null };
  }

  const localStamp = Number(localRecord.updatedAt) || 0;
  const remoteStamp = Number(remoteRecord.updatedAt) || 0;
  const localWins = localStamp > remoteStamp;
  const chosen = localWins ? { ...localRecord } : { ...remoteRecord };
  // The copy that lost is still an unsaved edit, so it still has to be pushed.
  chosen.dirty = localWins;

  return {
    item: chosen,
    conflict: {
      id: localRecord.id,
      kind,
      at: Date.now(),
      kept: localWins ? "local" : "remote",
      title: recordTitle(kind, localRecord) || recordTitle(kind, remoteRecord),
      local: { ...localRecord },
      remote: { ...remoteRecord },
    },
  };
}

function mergeRecordLists(localRecords, remoteRecords, kind, onPending) {
  const local = Array.isArray(localRecords) ? localRecords : [];
  const remote = Array.isArray(remoteRecords) ? remoteRecords : [];
  const byId = new Map(local.map((record) => [record.id, record]));
  const seen = new Set();
  const merged = [];
  const conflicts = [];

  for (const remoteRecord of remote) {
    seen.add(remoteRecord.id);
    const localRecord = byId.get(remoteRecord.id);
    if (!localRecord) {
      merged.push({ ...remoteRecord, dirty: false });
      continue;
    }
    const outcome = mergeRecordPair(localRecord, remoteRecord, kind);
    merged.push(outcome.item);
    if (outcome.conflict) conflicts.push(outcome.conflict);
  }

  // Anything the server never had is a local-only edit: keep it, and hand it back.
  for (const localRecord of local) {
    if (seen.has(localRecord.id)) continue;
    merged.push(localRecord);
    if (onPending) onPending(localRecord);
  }
  return { items: merged, conflicts };
}

function mergeStructuredStateRecord(kind, row) {
  if (!row || !canReadStructuredRow(row)) return;
  const normalized = normaliseStructuredRecord(kind, row);
  const list = state[RECORD_LIST_KEY[kind]];
  if (!Array.isArray(list)) return;
  const index = list.findIndex(
    (entry) => entry.id === normalized.id || (normalized.backendId && entry.backendId === normalized.backendId),
  );
  if (index < 0) {
    list.unshift(normalized);
    return;
  }
  /* Merge rather than spread. `list[index] = { ...list[index], ...normalized }` was wholesale
     last-write-wins: another device's push landed while this one had unsaved edits, and those
     edits were simply gone. */
  const outcome = mergeRecordPair(list[index], normalized, kind);
  list[index] = outcome.item;
  if (outcome.conflict) recordSyncConflicts([outcome.conflict]);
  if (outcome.item.dirty) queueStructuredRecordSync(kind, outcome.item);
}

function removeStructuredStateRecord(kind, row) {
  const list = kind === "project" ? state.projects : kind === "goal" ? state.goals : state.people;
  if (!Array.isArray(list) || !row) return;
  const id = row.id;
  const clientId = row.client_id || row.clientId || row.metadata?.originalId || row.metadata?.original_id;
  list.splice(0, list.length, ...list.filter((entry) => entry.id !== id && entry.id !== clientId && entry.backendId !== id));
}

function buildStructuredRecordPayload(kind, record) {
  const metadata = {
    source: "prototype-sync",
    scope: record.scope || "shared",
    originalId: record.id || null,
  };
  if (kind === "project") {
    return {
      household_id: currentHouseholdId,
      user_id: sbUser,
      name: record.name || "",
      description: record.description || "",
      status: record.status || "active",
      client_id: record.id,
      metadata,
    };
  }
  if (kind === "goal") {
    return {
      household_id: currentHouseholdId,
      user_id: sbUser,
      title: record.title || "",
      description: record.description || "",
      status: record.done === true
      ? "completed"
      : record.done === false
        ? "active"
        : record.status || "active",
      client_id: record.id,
      // goals has no target-date column either, so it rides in metadata as a person's details do.
      metadata: { ...metadata, done: Boolean(record.done), targetDate: record.targetDate || "" },
    };
  }
  return {
    household_id: currentHouseholdId,
    user_id: sbUser,
    name: record.name || "",
    notes: record.notes || "",
    client_id: record.id,
    // The people table only has name and notes, so contact details ride inside metadata (already
    // jsonb) rather than needing a migration, and are lifted back out in normaliseStructuredRecord.
    metadata: {
      ...metadata,
      phone: record.phone || "",
      email: record.email || "",
      birthday: record.birthday || "",
      // Written as a real boolean rather than a string, and always written: an explicit false is
      // what un-sets it on another device, where omitting the key would leave the old true in place.
      ownBirthday: Boolean(record.ownBirthday),
    },
  };
}

const VAPID_PUBLIC_KEY =
  "BHWGWugtw2V9RIk_4mItF_ef3sx0ZJBTPuKZVjTEDfOY-o80jJcXXurZlYBhTJAyhqNQzmtBIjDdEguHwyb0hoU";
let deferredInstallPrompt = null;
const REMEMBERED_EMAIL_KEY = "everything_remembered_email";

async function deleteStructuredRecord(kind, record) {
  if (!structuredSyncAvailable() || !record?.id) return false;
  const result = await structuredRequest(
    `/api/${kind}?household_id=${encodeURIComponent(currentHouseholdId)}&client_id=${encodeURIComponent(record.id)}`,
    { method: "DELETE" },
  );
  if (result.ok) return true;
  if (structuredResponseNeedsRetry(result)) queueStructuredRecordSync(kind, record, "delete");
  else console.warn(`${kind} structured delete rejected:`, result.data?.error || result.status);
  return false;
}

async function persistStructuredRecord(kind, record) {
  if (!structuredSyncAvailable() || !record?.id) return false;
  /* Same choke point idea as dbSaveItem. Every project/goal/person write lands here, so this is
     where "this device has an edit the server has not seen" is recorded. */
  record.updatedAt = Math.max(Date.now(), (Number(record.updatedAt) || 0) + 1);
  record.dirty = true;
  const payload = buildStructuredRecordPayload(kind, record);
  const result = await structuredRequest(
    `/api/${kind}?household_id=${encodeURIComponent(currentHouseholdId)}`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  if (result.ok) {
    const row = result.data?.[kind === "project" ? "project" : kind === "goal" ? "goal" : "person"];
    if (row?.id) {
      const list = kind === "project" ? state.projects : kind === "goal" ? state.goals : state.people;
      const current = list?.find((entry) => entry.id === record.id);
      if (current) current.backendId = row.id;
    }
    return true;
  }
  if (structuredResponseNeedsRetry(result)) queueStructuredRecordSync(kind, record);
  else console.warn(`${kind} structured sync rejected:`, result.data?.error || result.status);
  return false;
}

async function processStructuredOperation(operation) {
  if (operation.userId && operation.userId !== sbUser) return { ok: true, status: 0, data: {} };
  if (operation.kind === "item") {
    const item = operation.item || {};
    if (operation.action === "delete") {
      if (item.kind === "task") {
        const taskResult = await structuredRequest(
          `/api/tasks?household_id=${encodeURIComponent(operation.householdId)}&client_id=${encodeURIComponent(operation.clientId)}`,
          { method: "DELETE" },
        );
        if (!taskResult.ok) return taskResult;
      }
      return structuredRequest(
        `/api/entries?household_id=${encodeURIComponent(operation.householdId)}&client_id=${encodeURIComponent(operation.clientId)}`,
        { method: "DELETE" },
      );
    }
    const entryPayload = {
      ...buildEntryDraftFromItem(item),
      household_id: operation.householdId,
      user_id: operation.userId,
      client_id: operation.clientId,
    };
    const entryResult = await structuredRequest(`/api/entries?household_id=${encodeURIComponent(operation.householdId)}`, {
      method: "POST",
      body: JSON.stringify(entryPayload),
    });
    if (!entryResult.ok) return entryResult;
    if (item.kind !== "task") return { ok: true, status: entryResult.status, data: entryResult.data };
    if (!entryResult.data?.entry?.id) return { ok: false, status: 502, data: { error: "Entry response did not include an id." } };
    const taskPayload = {
      ...buildTaskDraftFromItem(item, entryResult.data.entry.id),
      household_id: operation.householdId,
      user_id: operation.userId,
      client_id: operation.clientId,
    };
    return structuredRequest(`/api/tasks?household_id=${encodeURIComponent(operation.householdId)}`, {
      method: "POST",
      body: JSON.stringify(taskPayload),
    });
  }
  if (["project", "goal", "person"].includes(operation.kind)) {
    if (operation.action === "delete") {
      return structuredRequest(
        `/api/${operation.kind}?household_id=${encodeURIComponent(operation.householdId)}&client_id=${encodeURIComponent(operation.clientId)}`,
        { method: "DELETE" },
      );
    }
    const payload = {
      ...buildStructuredRecordPayload(operation.kind, operation.record || {}),
      household_id: operation.householdId,
      user_id: operation.userId,
    };
    return structuredRequest(
      `/api/${operation.kind}?household_id=${encodeURIComponent(operation.householdId)}`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }
  return { ok: true, status: 0, data: {} };
}

/* Parks a write that has exhausted its retries instead of discarding it. The operation stays in
   the queue with a far-future attempt time, so it neither vanishes nor spins in a hot loop, and
   `retryUnsyncedItems()` can revive it the moment the real cause is fixed. */
const STRUCTURED_SYNC_PARKED_MS = 24 * 60 * 60 * 1000;

function markStructuredSyncFailed(operation, result) {
  const reason = result?.data?.error || result?.status || "unknown error";
  const parked = {
    ...operation,
    attempts: (operation.attempts || 0) + 1,
    nextAttemptAt: Date.now() + STRUCTURED_SYNC_PARKED_MS,
    parkedAt: Date.now(),
    lastError: String(reason),
  };
  updateStructuredSyncOperation(operation.id, parked);
  return parked;
}

/* Everything that failed to reach the server, kept in one list the user can act on. */
function recordUnsyncedItem(operation) {
  if (!operation?.clientId) return;
  if (!Array.isArray(state.unsyncedItems)) state.unsyncedItems = [];
  const key = `${operation.kind}:${operation.clientId}`;
  const existing = state.unsyncedItems.findIndex((entry) => entry.key === key);
  const entry = {
    key,
    id: operation.clientId,
    kind: operation.kind,
    title: operation.item?.title || operation.item?.sub || operation.record?.title || "Untitled",
    error: operation.lastError || "unknown error",
    at: operation.parkedAt || Date.now(),
  };
  if (existing >= 0) state.unsyncedItems.splice(existing, 1, entry);
  else state.unsyncedItems.push(entry);
  save();
}

/* Retries every parked write and clears the list if they all land. A failure here is expected
   and simply leaves the entry in place — the next attempt happens when the user tries again. */
async function retryUnsyncedItems() {
  const parked = readStructuredSyncQueue().filter((operation) => operation.parkedAt);
  if (!parked.length) return false;
  parked.forEach((operation) => {
    updateStructuredSyncOperation(operation.id, { nextAttemptAt: 0, parkedAt: 0, attempts: 0 });
  });
  const queue = readStructuredSyncQueue();
  const stillParked = queue.filter((operation) => operation.parkedAt);
  state.unsyncedItems = stillParked.map((operation) => ({
    key: `${operation.kind}:${operation.clientId}`,
    id: operation.clientId,
    kind: operation.kind,
    title: operation.item?.title || operation.item?.sub || operation.record?.title || "Untitled",
    error: operation.lastError || "unknown error",
    at: operation.parkedAt || Date.now(),
  }));
  save();
  await flushStructuredSyncQueue();
  renderSyncConflictBanner();
  return true;
}

function scheduleStructuredSyncRetry() {
  if (structuredSyncTimer) {
    clearTimeout(structuredSyncTimer);
    structuredSyncTimer = null;
  }
  const next = readStructuredSyncQueue()
    .map((operation) => operation.nextAttemptAt)
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((a, b) => a - b)[0];
  if (!next || !structuredSyncAvailable()) return;
  structuredSyncTimer = setTimeout(() => {
    structuredSyncTimer = null;
    void flushStructuredSyncQueue();
  }, Math.min(60000, Math.max(1000, next - Date.now() + 250)));
}

async function flushStructuredSyncQueue() {
  if (structuredSyncRunning || !structuredSyncAvailable()) return;
  structuredSyncRunning = true;
  try {
    do {
      structuredSyncQueuedAgain = false;
      const queue = readStructuredSyncQueue();
      for (const operation of queue) {
        if (operation.userId && operation.userId !== sbUser) continue;
        if (operation.nextAttemptAt && operation.nextAttemptAt > Date.now()) continue;
        const result = await processStructuredOperation(operation);
        if (result.ok) {
          removeStructuredSyncOperation(operation.id);
          continue;
        }
        if (structuredResponseNeedsRetry(result) && (operation.attempts || 0) < STRUCTURED_SYNC_MAX_ATTEMPTS) {
          updateStructuredSyncOperation(operation.id, {
            attempts: (operation.attempts || 0) + 1,
            nextAttemptAt: Date.now() + Math.min(60000, 1000 * 2 ** (operation.attempts || 0)),
          });
          scheduleStructuredSyncRetry();
        } else {
          /* Do not just drop it. This used to remove the operation outright, which left the item
             in localStorage looking perfectly normal and never on the server — the one case that
             turned "synced" into a lie. It is now parked and surfaced so the person can retry. */
          const parked = markStructuredSyncFailed(operation, result);
          recordUnsyncedItem(parked);
          scheduleStructuredSyncRetry();
        }
      }
    } while (structuredSyncQueuedAgain);
  } finally {
    structuredSyncRunning = false;
    scheduleStructuredSyncRetry();
  }
}

window.addEventListener("online", () => {
  void flushStructuredSyncQueue();
});


function restoreRememberedEmail() {
  const emailInput = document.getElementById("authEmail");
  const rememberMe = document.getElementById("rememberMe");
  const rememberedEmail = localStorage.getItem(REMEMBERED_EMAIL_KEY);
  if (emailInput && rememberedEmail) emailInput.value = rememberedEmail;
  if (rememberMe) rememberMe.checked = Boolean(rememberedEmail);
}

function isAppInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIosDevice() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function updateInstallAction() {
  const installItem = document.getElementById("installAppItem");
  if (!installItem) return;
  const canInstall =
    !isAppInstalled() && (deferredInstallPrompt || isIosDevice());
  installItem.style.display = canInstall ? "block" : "none";
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallAction();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallAction();
});

async function installApp() {
  if (isIosDevice() && !deferredInstallPrompt) {
    await alertDialog({ title: "Install from the browser menu", body: "On iPhone: Share, then Add to Home Screen. On Android: the three-dot menu, then Install app." });
    return;
  }
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  updateInstallAction();
}

async function authSignUp() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const authError = document.getElementById("authError");

  if (!email || !password) {
    authError.textContent = "Enter both email and password.";
    return;
  }

  try {
    const { error } = await sb.auth.signUp({ email, password });
    authError.textContent = error
      ? error.message
      : "Check your email to confirm, then sign in.";
  } catch (err) {
    authError.textContent = err?.message || "Could not create the account.";
  }
}
async function authSignIn() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const authError = document.getElementById("authError");
  const rememberMe = document.getElementById("rememberMe");

  if (!email || !password) {
    authError.textContent = "Enter both email and password.";
    return;
  }

  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      authError.textContent = error.message;
      return;
    }
    if (rememberMe?.checked) {
      localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
    } else {
      localStorage.removeItem(REMEMBERED_EMAIL_KEY);
    }
    authError.textContent = "";
  } catch (err) {
    authError.textContent = err?.message || "Could not sign in.";
  }
}
function togglePasswordVisibility(inputId, toggleId) {
  const input = document.getElementById(inputId);
  const toggle = document.getElementById(toggleId);
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  toggle.innerHTML = icon(isHidden ? "eye-off" : "eye");
}

function showForgotPassword() {
  document.getElementById("authFormNormal").style.display = "none";
  document.getElementById("authFormForgot").style.display = "block";
}

/* The "how to get in" panel. Collapsed by default so the sign-in form stays short on a phone —
   it is the first thing a returning user needs and the last thing a brand-new one is looking for. */
function switchAuthHelp(force) {
  const panel = document.getElementById("authHelp");
  const toggle = document.getElementById("authHelpToggle");
  if (!panel || !toggle) return;
  const open = force === undefined ? panel.hidden : force;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "Hide this" : "New here? How to get in";
}
function showNormalAuth() {
  document.getElementById("authFormForgot").style.display = "none";
  document.getElementById("authFormNormal").style.display = "block";
}

/* The reset panel is the worst place to fail silently: someone locked out of their account presses
   this, and "nothing happened" tells them nothing except that the app is broken. So the request is
   guarded, timed, and always ends in a line the person can read.

   Three things it used to get wrong:
     - no busy state, so a second tap sent a second email and could trip the provider's rate limit
     - no timeout, so a request that never resolved left the button looking dead
     - nothing about spam, which is where the mail actually goes most of the time            */
let forgotInFlight = false;

/* A title, without a model.

   Clean titles normally come from the reading, so with no model configured the whole sentence was
   being stored: "remind me to call ravi Tomorrow 10 AM" as a task's title. The date and time are
   now stripped anyway, and the reminder wrapper with them, so the local path produces something a
   person would have written themselves.

   Only ever applied when the text is a reminder, and only to the wrapper that is actually there —
   a sentence that is already a clean title is left completely alone, because guessing here would
   make titles worse rather than better. */
const TITLE_REMINDER_WRAPPERS = [
  /^remind\s+me\s+to\s+/i,
  /^please\s+remind\s+me\s+(?:to|about)\s+/i,
  /^don'?t\s+forget\s+(?:to\s+)?/i,
  /^do\s+not\s+forget\s+(?:to\s+)?/i,
  /^i\s+need\s+to\s+remember\s+to\s+/i,
  /^remember\s+to\s+/i,
  /^i\s+need\s+to\s+/i,
  /^i\s+have\s+to\s+/i,
  /^i\s+must\s+/i,
  /^need\s+to\s+/i,
];

/* "remind me to call ravi Tomorrow 10 AM" -> "Call Ravi". Returns the text unchanged unless it
   really is a wrapped reminder, so this can never invent a title. */
function cleanReminderTitle(text) {
  let body = String(text || "").trim();
  if (!body) return "";
  for (const wrapper of TITLE_REMINDER_WRAPPERS) {
    const stripped = body.replace(wrapper, "");
    // A wrapper that leaves nothing behind means it matched the whole sentence, which is not a
    // title and not worth saving as one.
    if (stripped.trim() && stripped !== body) {
      body = stripped.trim();
      break;
    }
  }
  // The date and time are already stored in their own field, so repeating them in the title only
  // makes every row longer. The month names are matched before the days so "Monday" is not read
  // as a bare day inside "next Monday".
  body = body
    .replace(/\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|week|weekend|month)|next (?:week|weekend|month|year))\b/gi, "")
    .replace(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/gi, "")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, "")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
    .trim();
  if (!body) return "";
  // A reminder is work, so the title reads as an instruction — the same way the model phrases one.
  return body.charAt(0).toUpperCase() + body.slice(1);
}

async function authForgotPassword() {
  const field = document.getElementById("forgotEmail");
  const msg = document.getElementById("forgotMessage");
  const button = document.getElementById("forgotSendBtn");
  const email = field.value.trim();

  if (forgotInFlight) return;
  msg.textContent = "";
  if (!email) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = "Enter your email first.";
    field.focus();
    return;
  }
  // A malformed address is refused here rather than sent, so the person is told immediately
  // instead of waiting a minute for a rejection that is easy to miss.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = "That does not look like an email address.";
    field.focus();
    field.select();
    return;
  }

  forgotInFlight = true;
  const original = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Sending…";
  }
  msg.style.color = "var(--muted)";
  msg.textContent = "Sending the reset link…";

  try {
    // A reset request has one job, so a bounded wait is enough. supabase-js has no built-in
    // timeout, and a request that never settles is what "nothing happens" looks like.
    const result = await withTimeoutMs(
      sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin }),
      15000,
    );
    if (result?.timedOut) {
      msg.style.color = "var(--red-fg)";
      msg.textContent =
        "That took too long and no answer came back. Check your connection, or try again in a minute.";
      return;
    }
    const error = result?.error;
    if (error) {
      msg.style.color = "var(--red-fg)";
      // The two real causes are both project setup, so they are named rather than left as a code
      // nobody can act on. "Requested path is not allowed" is the redirect allow-list.
      const notAllowed = /not allowed|invalid redirect|redirect/i.test(error.message || "");
      msg.textContent = notAllowed
        ? "This app's address is not on the project's allowed redirect list, so the link cannot be built. Add it in Supabase → Authentication → URL Configuration."
        : `Could not send the reset link: ${error.message}`;
      return;
    }
    msg.style.color = "var(--accent)";
    msg.textContent = "Check your email for a reset link — including your spam folder. It works once.";
  } catch (err) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = `Could not send the reset link: ${err?.message || "unknown error"}`;
  } finally {
    forgotInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = original || "Send reset link";
    }
  }
}

/* Resolves with { timedOut: true } rather than rejecting, so a caller can tell "the server said
   no" from "the server never answered" — a person debugging a locked-out account needs that
   difference, and a plain timeout would hide it. */
function withTimeoutMs(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: err });
      });
  });
}

async function authUpdatePassword() {
  const pw = document.getElementById("newPassword").value;
  const err = document.getElementById("newPasswordError");
  if (pw.length < 6) {
    err.textContent = "Password must be at least 6 characters.";
    return;
  }
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    err.textContent = error.message;
    return;
  }
  err.style.color = "var(--accent)";
  err.textContent = "Password updated — signing you in…";
  setTimeout(() => (window.location.href = window.location.origin), 1200);
}
async function authSignOut() {
  const authError = document.getElementById("authError");
  const logoutMessage = document.getElementById("logoutMessage");
  if (authError) authError.textContent = "";
  if (logoutMessage) {
    logoutMessage.textContent = "";
    logoutMessage.style.display = "none";
  }

  try {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
    await sb.removeAllChannels();
    /* Stop the retry timer before the queue is dropped. Left running it would wake up after
       sign-out, find the key gone, and re-create an empty queue under the next account. */
    if (structuredSyncTimer) {
      clearTimeout(structuredSyncTimer);
      structuredSyncTimer = null;
    }
    const passwordInput = document.getElementById("authPassword");
    const newPasswordInput = document.getElementById("newPassword");
    if (passwordInput) passwordInput.value = "";
    if (newPasswordInput) newPasswordInput.value = "";
    /* Deliberately after the sign-out succeeded. A failed sign-out must not destroy the data of
       someone who is still, as far as the server is concerned, signed in — that would lock them
       out of work that only ever existed on this device. */
    clearAccountState();
  } catch (err) {
    const message = err?.message || "Could not sign out. Please try again.";
    if (logoutMessage) {
      logoutMessage.textContent = message;
      logoutMessage.style.display = "block";
    }
    if (authError) authError.textContent = message;
    return false;
  }
  return true;
}
async function confirmLogoutPage() {
  const logoutButton = document.querySelector(
    '#view-logout button[onclick="confirmLogoutPage()"]',
  );
  // The label is held rather than retyped, so renaming the button in index.html cannot leave a
  // "Log Out" reappearing here the first time a sign-out fails.
  const originalLabel = logoutButton ? logoutButton.innerHTML : null;
  if (logoutButton) {
    logoutButton.disabled = true;
    logoutButton.textContent = "Signing out…";
  }
  try {
    const signedOut = await authSignOut();
    if (signedOut) return;
  } finally {
    if (logoutButton && originalLabel !== null) {
      logoutButton.disabled = false;
      logoutButton.innerHTML = originalLabel;
      refreshIcons();
    }
  }
}
let sbUser = null;
let sbChannel = null;
let structuredChannels = [];
// The signed-in email, kept from the session Supabase already handed us. loadProfile() needs it for
// the Settings field and the greeting, and reading it back from /auth/v1/user is a second network
// round trip on every Settings visit for data already in memory.
let currentUserEmail = "";
let syncReadyPromise = null;
let hasCompletedAt = false;
let hasReminderColumns = false;
let hasChecklistColumn = false;
let hasRecurrenceKeyColumn = false;
let hasArchivedAtColumn = false;
let hasUpdatedAt = false;
const smartCaptureColumns = {
  sourceType: false,
  rawText: false,
  metadata: false,
  fingerprint: false,
};
/* Document columns (supabase/migrations/010). Probed rather than assumed, for the same reason as
   the smart-capture ones: a database that has not run the migration must still save normally, so
   these fields are simply left out of the row instead of failing the whole upsert. */
const documentColumns = {
  docType: false,
  issuer: false,
  docNumber: false,
  issuedOn: false,
  expiresOn: false,
};

function itemToRow(item) {
  const row = {
    id: item.id,
    owner_id: item.ownerId || sbUser,
    scope: item.scope || "shared",
    kind: item.kind,
    title: item.title,
    sub: item.sub || "",
    priority: item.priority || "",
    person: item.person || "",
    due: item.due || "",
    due_date: item.dueDate || null,
    recurrence: item.recurrence || "none",
    status: item.kind === "task" ? taskStatusFromItem(item) : item.status || "",
    project: item.project || "",
    created: item.created,
    done: !!item.done,
    notified: !!item.notified,
    household_id: currentHouseholdId,
    media_url: item.mediaUrl || "",
  };
  if (hasChecklistColumn) row.checklist = normaliseChecklist(item.checklist);
  if (hasRecurrenceKeyColumn) row.recurrence_key = item.recurrenceKey || null;
  if (hasArchivedAtColumn) row.archived_at = item.archivedAt ? new Date(item.archivedAt).toISOString() : null;
  if (smartCaptureColumns.sourceType) row.source_type = item.sourceType || "manual";
  if (smartCaptureColumns.rawText) row.raw_text = item.rawText || item.title || "";
  if (smartCaptureColumns.metadata) row.capture_metadata = normaliseCaptureMetadata(item.captureMetadata);
  if (smartCaptureColumns.fingerprint) row.capture_fingerprint = item.captureFingerprint || null;
  // Document fields (supabase/migrations/010). Empty string, never null: a document whose number was
  // cleared must overwrite the old one, and a null would leave the previous value standing.
  if (documentColumns.docType) row.doc_type = item.docType || "";
  if (documentColumns.issuer) row.issuer = item.issuer || "";
  if (documentColumns.docNumber) row.doc_number = item.docNumber || "";
  if (documentColumns.issuedOn) row.issued_on = item.issuedOn || "";
  if (documentColumns.expiresOn) row.expires_on = item.expiresOn || "";
  // Only sent once the completed_at migration has been applied — see supabase/migrations.
  if (hasCompletedAt)
    row.completed_at = item.completedAt
      ? new Date(item.completedAt).toISOString()
      : null;
  // Reminder delivery bookkeeping (supabase/migrations/004). reminder_at is the exact
  // time the server cron pushes, so it mirrors the local snooze/due decision.
  if (hasReminderColumns) {
    const reminderTime = itemReminderTime(item);
    row.reminder_at = reminderTime ? new Date(reminderTime).toISOString() : null;
    row.snoozed_until = item.snoozedUntil
      ? new Date(item.snoozedUntil).toISOString()
      : null;
    row.notified_at = item.notifiedAt
      ? new Date(item.notifiedAt).toISOString()
      : null;
  }
  // The edit time, not the sync time (supabase/migrations/009). Sent explicitly so conflict
  // resolution can compare when two devices each made a change, and deliberately not
  // triggered server-side — a trigger would overwrite this with the server's clock.
  if (hasUpdatedAt) {
    row.updated_at = new Date(Number(item.updatedAt) || Date.now()).toISOString();
  }
  return row;
}
/* --- Conflict-safe merge ------------------------------------------------------
   Two devices can be offline at the same moment, and each is right about its own edits.
   The old sync did `state.items = data.map(rowToItem)`: a wholesale replace. An item
   captured while the server was unreachable, or a queued write that had not landed yet,
   simply vanished — silently, and with nothing in the console to explain it.

   The rules, in order:
     * an item the server has never seen is always kept, and queued to be pushed
     * an item that is not dirty here takes the server's copy silently
     * a genuinely divergent item takes the newer edit AND keeps the loser, so that even
       when the timestamps cannot settle it, nothing a person typed is destroyed

   Client clocks are not trustworthy across devices, so the timestamp picks a winner — but
   it is deliberately never allowed to be the only thing standing between a person and
   their data. Every conflict is retained and surfaced. */

const SYNC_CONFLICT_LIMIT = 50;

function itemContentKey(item) {
  if (!item) return "";
  const snapshot = itemSnapshot(item);
  // Identity and sync bookkeeping are not content: two copies of the same note differ on
  // these by definition, and counting that as a difference would report a conflict on
  // every single sync.
  delete snapshot.id;
  delete snapshot.updatedAt;
  delete snapshot.dirty;
  return JSON.stringify(snapshot);
}

/* Resolves one id seen on both sides. Returns the copy to keep and, when the two genuinely
   disagree, the conflict to show the user. */
function mergeItemPair(localItem, remoteItem) {
  const clean = { ...remoteItem, dirty: false };
  if (localItem.dirty !== true) return { item: clean, conflict: null };
  if (itemContentKey(localItem) === itemContentKey(remoteItem)) {
    return { item: clean, conflict: null };
  }

  const localStamp = Number(localItem.updatedAt) || 0;
  const remoteStamp = Number(remoteItem.updatedAt) || 0;
  const localWins = localStamp > remoteStamp;
  const chosen = localWins ? { ...localItem } : { ...remoteItem };
  // The copy that lost is still an unsaved edit, so it still has to be pushed.
  chosen.dirty = localWins;

  return {
    item: chosen,
    conflict: {
      id: localItem.id,
      at: Date.now(),
      kept: localWins ? "local" : "remote",
      title: localItem.title || remoteItem.title || "Untitled",
      local: itemSnapshot(localItem),
      remote: itemSnapshot(remoteItem),
    },
  };
}

function mergeItemLists(localItems, remoteItems, { onPending } = {}) {
  const local = Array.isArray(localItems) ? localItems : [];
  const remote = Array.isArray(remoteItems) ? remoteItems : [];
  const byId = new Map(local.map((item) => [item.id, item]));
  const seen = new Set();
  const merged = [];
  const conflicts = [];

  for (const remoteItem of remote) {
    seen.add(remoteItem.id);
    const localItem = byId.get(remoteItem.id);
    if (!localItem) {
      merged.push({ ...remoteItem, dirty: false });
      continue;
    }
    const outcome = mergeItemPair(localItem, remoteItem);
    merged.push(outcome.item);
    if (outcome.conflict) conflicts.push(outcome.conflict);
  }

  // Anything the server never had is a local-only edit. It is still here, and this is the
  // moment to hand it back rather than leave it waiting for a sync that will drop it.
  for (const localItem of local) {
    if (seen.has(localItem.id)) continue;
    merged.push(localItem);
    if (onPending) onPending(localItem);
  }

  merged.sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  return { items: merged, conflicts };
}

/* Conflicts accumulate until the user deals with them, so nothing is thrown away the
   moment a sync completes. The cap stops a repeatedly-diverging item from filling storage. */
function recordSyncConflicts(conflicts) {
  if (!Array.isArray(conflicts) || !conflicts.length) return;
  if (!Array.isArray(state.syncConflicts)) state.syncConflicts = [];
  const known = new Set(state.syncConflicts.map((entry) => entry.id));
  for (const conflict of conflicts) {
    if (known.has(conflict.id)) continue;
    state.syncConflicts.push(conflict);
  }
  state.syncConflicts = state.syncConflicts.slice(-SYNC_CONFLICT_LIMIT);
  save();
}

/* Lets the user settle a conflict by hand: keep whichever version they choose, mark it
   dirty so it is pushed, and stop carrying the other copy. */
function resolveSyncConflict(id, choice) {
  const list = Array.isArray(state.syncConflicts) ? state.syncConflicts : [];
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  const conflict = list[index];
  const chosen = choice === "local" ? conflict.local : conflict.remote;
  const target = state.items.find((item) => item.id === id);
  if (target) Object.assign(target, chosen, { updatedAt: Date.now(), dirty: true });
  list.splice(index, 1);
  state.syncConflicts = list;
  save();
  if (target) void dbSaveItem(target);
  renderAll();
  renderSyncConflictBanner();
  return true;
}

/* A conflict is never resolved automatically in a way that loses text: both versions are kept
   and shown here, and the user picks. Silence would mean the losing edit existed nowhere. */
function renderSyncConflictBanner() {
  const card = document.getElementById("syncConflictCard");
  const list = document.getElementById("syncConflictList");
  if (!card || !list) return;
  const conflicts = Array.isArray(state.syncConflicts) ? state.syncConflicts : [];
  const unsynced = Array.isArray(state.unsyncedItems) ? state.unsyncedItems : [];
  if (!conflicts.length && !unsynced.length) {
    card.style.display = "none";
    list.innerHTML = "";
    return;
  }
  card.style.display = "";

  const describe = (version) => {
    const text = (version.sub || version.title || "Untitled").trim();
    const status = version.done ? "done" : version.status || "open";
    return `<b>${escapeHtml(text)}</b> <span style="color: var(--muted)">(${escapeHtml(status)})</span>`;
  };

  const conflictRows = conflicts
    .map(
      (conflict) => `<div class="field-row" style="padding:8px 0;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div style="flex:1 1 220px;min-width:0">
          <div style="font-size:13px">${describe(conflict.local)}</div>
          <div style="font-size:12.5px;color:var(--muted)">vs ${describe(conflict.remote)}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="resolveSyncConflict(${jsStr(conflict.id)}, 'local')">Keep mine</button>
          <button class="btn btn-sm" onclick="resolveSyncConflict(${jsStr(conflict.id)}, 'remote')">Keep theirs</button>
        </div>
      </div>`,
    )
    .join("");

  const unsyncedRows = unsynced.length
    ? `<div style="padding:10px 0;border-top:1px solid var(--border)">
        <div style="font-size:13px;margin-bottom:6px">
          ${unsynced.length} ${unsynced.length === 1 ? "change is" : "changes are"} saved on this
          device but did not reach the server. They are safe here.
        </div>
        ${unsynced
          .map(
            (entry) =>
              `<div style="font-size:12.5px;color:var(--muted)">${escapeHtml(entry.title)} — ${escapeHtml(entry.error)}</div>`,
          )
          .join("")}
        <button class="btn btn-sm" style="margin-top:8px" onclick="retryUnsyncedItems()">Retry now</button>
      </div>`
    : "";

  list.innerHTML = conflictRows + unsyncedRows;
}

/* A sync that did not run, said plainly.

   The dangerous state is not an error message — it is an app that looks like a brand-new account
   while the person's data is sitting in the database. A banner naming what happened, and what it
   is not, is the difference between "my account is gone" and "try again". */
let syncProblemRetry = null;

function renderSyncProblem(title, body, actionLabel, action) {
  const host = document.getElementById("syncProblemCard");
  if (!host) return;
  syncProblemRetry = action || null;
  host.style.display = "";
  host.innerHTML = `
    <p class="sync-problem-title">${icon("triangle-alert")} ${escapeHtml(title)}</p>
    <p class="sync-problem-body">${escapeHtml(body)}</p>
    ${
      action
        ? `<button type="button" class="btn" onclick="retrySyncSetup()">${escapeHtml(actionLabel || "Try again")}</button>`
        : ""
    }`;
  refreshIcons();
}

function clearSyncProblem() {
  syncProblemRetry = null;
  const host = document.getElementById("syncProblemCard");
  if (host) {
    host.style.display = "none";
    host.innerHTML = "";
  }
}

/* Re-runs the whole sync setup. Deliberately blunt: the state it depends on (the signed-in user,
   the household) is exactly what failed, so patching around it would hide the real problem. */
function retrySyncSetup() {
  const user = sbUser || currentUserId;
  if (!user) {
    location.reload();
    return;
  }
  clearSyncProblem();
  // A household resolved on the previous attempt is stale if the attempt failed to get one.
  if (!currentHouseholdId) currentHouseholdId = null;
  if (structuredChannels.length) {
    structuredChannels.forEach((channel) => sb.removeChannel(channel));
    structuredChannels = [];
  }
  if (sbChannel) sb.removeChannel(sbChannel);
  sbChannel = null;
  void startSupabaseSync(user);
}

function rowToItem(row) {
  const item = {
    id: row.id,
    ownerId: row.owner_id || null,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    sub: row.sub,
    priority: row.priority,
    person: row.person,
    due: row.due,
    dueDate: row.due_date,
    recurrence: row.recurrence,
    status: row.kind === "task" ? taskStatusFromItem(row) : row.status,
    checklist: normaliseChecklist(row.checklist),
    recurrenceKey: row.recurrence_key || null,
    archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : 0,
    project: row.project,
    created: Number(row.created),
    done: row.done,
    notified: row.notified,
    notifiedAt: row.notified_at ? new Date(row.notified_at).getTime() : "",
    snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).getTime() : "",
    mediaUrl: row.media_url,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : "",
    sourceType: row.source_type || "manual",
    rawText: row.raw_text || row.title || "",
    captureMetadata: normaliseCaptureMetadata(row.capture_metadata),
    captureFingerprint: row.capture_fingerprint || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
    // Anything arriving from the server is by definition already stored there.
    dirty: false,
  };
  // Only a document carries these. Applying them by column name rather than by spreading the row is
  // what keeps a task from picking up an `issuer` left over from a row that used to be a document.
  if (row.kind === "document") {
    normaliseDocumentField(item, row, "docType", "doc_type");
    normaliseDocumentField(item, row, "issuer", "issuer");
    normaliseDocumentField(item, row, "docNumber", "doc_number");
    normaliseDocumentField(item, row, "issuedOn", "issued_on");
    normaliseDocumentField(item, row, "expiresOn", "expires_on");
  }
  return item;
}

/* Document fields come back as text. An item that is not a document must never gain them, and an
   expiry that is not a real calendar date is dropped rather than kept: a value `daysUntil()` cannot
   read would sort the document into "no expiry", which is the one bucket where a broken date is
   least likely to be noticed. */
function normaliseDocumentField(item, row, key, column) {
  if (!documentColumns[key]) return;
  const value = String(row[column] ?? "").trim();
  if (!value) return;
  if ((key === "issuedOn" || key === "expiresOn") && !parseIsoDate(value)) return;
  item[key] = value;
}

/* items.completed_at arrives with supabase/migrations/001. Probe once at sync time so a
   database that hasn't been migrated yet keeps saving normally (the chart then falls back
   to the local completion log). */
async function detectCompletedAtColumn() {
  try {
    const { error } = await sb.from("items").select("completed_at").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

/* A date stored as YYYY-MM-DD. Parsed as local midnight on purpose: `new Date("2027-03-04")` is
   UTC midnight, which in any negative-offset timezone is the previous day, so an expiry read from a
   receipt would quietly become the day before. Same trap the birthday maths has to avoid. */
function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Rejects 2027-02-30, which Date would silently roll forward into March.
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  )
    return null;
  return date;
}

/* A Date back to YYYY-MM-DD, in local time. The mirror of parseIsoDate, and the only way a date
   leaves the app — handing it to toISOString() would write the UTC day, which in a negative offset
   is yesterday, and an expense entered tonight would land in yesterday's column of the report. */
function isoDateString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* Whole days from today to `value`, negative once it has passed. Midnight to midnight on both sides so
   the answer does not change with the time of day it is asked — "expires in 0 days" has to mean
   today, not "sometime this afternoon". */
function daysUntil(value) {
  const target = parseIsoDate(value);
  if (!target) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86400000);
}

/* items.reminder_at / snoozed_until / notified_at arrive with
   supabase/migrations/004. Until then reminders still work: the app keeps delivering
   them locally and through the service worker, only the closed-app push is skipped. */
async function detectReminderColumns() {
  try {
    const { error } = await sb.from("items").select("reminder_at").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

async function detectChecklistColumn() {
  try {
    const { error } = await sb.from("items").select("checklist").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

async function detectRecurrenceKeyColumn() {
  try {
    const { error } = await sb.from("items").select("recurrence_key").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

/* items.updated_at arrives with supabase/migrations/009. Until then conflict resolution
   degrades to "the server's copy wins", which is the old behaviour but no worse — the local
   items are still preserved by the merge, they simply cannot be ordered against the server. */
async function detectUpdatedAtColumn() {
  try {
    const { error } = await sb.from("items").select("updated_at").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

async function detectArchivedAtColumn() {
  try {
    const { error } = await sb.from("items").select("archived_at").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

async function detectSmartCaptureColumns() {
  const columns = [
    ["sourceType", "source_type"],
    ["rawText", "raw_text"],
    ["metadata", "capture_metadata"],
    ["fingerprint", "capture_fingerprint"],
  ];
  await Promise.all(
    columns.map(async ([key, column]) => {
      try {
        const { error } = await sb.from("items").select(column).limit(1);
        smartCaptureColumns[key] = !error;
      } catch (error) {
        smartCaptureColumns[key] = false;
      }
    }),
  );
}

async function detectDocumentColumns() {
  const columns = [
    ["docType", "doc_type"],
    ["issuer", "issuer"],
    ["docNumber", "doc_number"],
    ["issuedOn", "issued_on"],
    ["expiresOn", "expires_on"],
  ];
  await Promise.all(
    columns.map(async ([key, column]) => {
      try {
        const { error } = await sb.from("items").select(column).limit(1);
        documentColumns[key] = !error;
      } catch (error) {
        documentColumns[key] = false;
      }
    }),
  );
}

function isPrivateStructuredRow(row) {
  return row?.visibility === "private" || row?.scope === "private" || row?.metadata?.scope === "private";
}

function canReadStructuredRow(row) {
  return !isPrivateStructuredRow(row) || row?.user_id === sbUser;
}

/* Resolves which created-timestamp column a table actually has, cached per table. The deployed
   schema is mixed: items/projects/goals/people use `created`, entries/tasks use `created_at`. */
const STRUCTURED_CREATED_COLUMNS = ["created_at", "created", "createdAt"];
const structuredCreatedCache = new Map();

async function structuredCreatedColumn(table) {
  if (structuredCreatedCache.has(table)) return structuredCreatedCache.get(table);
  for (const column of STRUCTURED_CREATED_COLUMNS) {
    const { error } = await sb.from(table).select(column).limit(1);
    if (!error) {
      structuredCreatedCache.set(table, column);
      return column;
    }
  }
  structuredCreatedCache.set(table, null);
  return null;
}

async function loadStructuredCollection(kind, responseKey) {
  if (structuredSyncAvailable()) {
    const result = await structuredRequest(
      `/api/${kind}?household_id=${encodeURIComponent(currentHouseholdId)}`,
    );
    if (result.ok && Array.isArray(result.data?.[responseKey])) {
      return result.data[responseKey].filter(canReadStructuredRow);
    }
  }
  // The direct Supabase fallback runs only when the API route is unavailable. The created
  // timestamp column is not consistent across tables (`created` on the older prototype tables,
  // `created_at` on the later ones), so ordering by a name the table lacks errors out with a 400
  // and the collection silently disappears. Probe once, then use what actually exists.
  const orderColumn = await structuredCreatedColumn(kind);
  let query = sb.from(kind).select("*").eq("household_id", currentHouseholdId);
  if (orderColumn) query = query.order(orderColumn, { ascending: false });
  const fallback = await query;
  if (fallback.error) return null;
  return (fallback.data || []).filter(canReadStructuredRow);
}

async function startSupabaseSync(userId) {
  /* sbUser has to be set before anything reads or writes state, because the local storage key is
     derived from it. It used to be set two lines below the column probes, which meant the merge
     and any save during startup wrote to whichever account was loaded last. */
  sbUser = userId;
  /* Load this account's own local state before merging with the server. Without this the merge
     would run against the previous account's in-memory state and treat their records as
     local-only edits belonging to whoever just signed in. */
  state = readState();
  if (!state.projects) state.projects = [];
  if (!state.goals) state.goals = [];
  if (!state.people) state.people = [];
  await ensureHousehold(userId);

  /* Every view is filtered by household_id, so with no household the query below reads
     `household_id = null` and returns zero rows *without an error*. The app then shows a clean,
     genuinely empty workspace and a person concludes their account was wiped, when in fact the
     sync never ran. That is a silent failure of the worst kind, and it is exactly what a deleted
     account followed by a fresh sign-in produces: a new user id, no membership, a new household,
     and every existing row left behind under the old one.

     So it is said out loud here rather than being left to look like "no data". */
  if (!currentHouseholdId) {
    renderSyncProblem(
      "Your account could not be opened",
      "Everything is filtered by your household, and that could not be found, so nothing can be loaded. " +
        "This is not your data being deleted. Try again in a moment, and if it keeps happening your household " +
        "needs to be re-linked.",
      "Try again",
      "retrySyncSetup",
    );
    return;
  }
  clearSyncProblem();
  hasCompletedAt = await detectCompletedAtColumn();
  hasReminderColumns = await detectReminderColumns();
  hasChecklistColumn = await detectChecklistColumn();
  hasRecurrenceKeyColumn = await detectRecurrenceKeyColumn();
  hasArchivedAtColumn = await detectArchivedAtColumn();
  hasUpdatedAt = await detectUpdatedAtColumn();
  await detectSmartCaptureColumns();
  await detectDocumentColumns();
  const { data, error } = await sb
    .from("items")
    .select("*")
    .eq("household_id", currentHouseholdId)
    .order("created", { ascending: false });
  if (!error && data) {
    /* Merge, never replace. This line used to be `state.items = data.map(rowToItem)`, which
       threw away anything captured or edited while the server was unreachable — the item was
       in localStorage a moment earlier and gone the next, with no warning. */
    const pending = [];
    const { items, conflicts } = mergeItemLists(state.items, data.map(rowToItem), {
      onPending: (item) => pending.push(item),
    });
    state.items = items;
    if (!state.projects) state.projects = [];
    if (!state.goals) state.goals = [];
    if (!state.people) state.people = [];
    state.items.forEach((item) => {
      if (item.notified) rememberNotified(item.id);
    });
    recordSyncConflicts(conflicts);
    // Local-only items are safe now and are worth pushing, otherwise they sit here waiting
    // for the next sync to discard them.
    pending.forEach((item) => queueStructuredItemSync(item));
    renderSyncConflictBanner();
    renderAll();
    runReminderCheck("sync");
  }

  // This device may already be allowed to notify but have lost its push subscription
  // (re-install, storage cleared, browser rotated the endpoint). Re-register it quietly.
  if (notificationSupported() && Notification.permission === "granted") {
    ensurePushSubscription({ requestPermission: false }).then(() =>
      renderNotificationStatus(),
    );
  }
  if (structuredChannels.length) {
    structuredChannels.forEach((channel) => sb.removeChannel(channel));
    structuredChannels = [];
  }
  if (sbChannel) sb.removeChannel(sbChannel);
  sbChannel = sb
    .channel("items-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "items",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          state.items = state.items.filter((i) => i.id !== payload.old.id);
          cancelReminderFor(payload.old.id);
        } else {
          /* Merge the single record rather than overwriting it. `state.items[idx] = updated`
             was wholesale last-write-wins per item: another device's push landed while this
             one had unsaved edits, and the unsaved edit was simply gone. */
          const incoming = rowToItem(payload.new);
          const existing = state.items.find((i) => i.id === incoming.id);
          if (existing) {
            const { item, conflict } = mergeItemPair(existing, incoming);
            state.items[state.items.findIndex((i) => i.id === incoming.id)] = item;
            if (conflict) recordSyncConflicts([conflict]);
            // The local edit lost but is still unsaved, so it still has to be pushed.
            if (item.dirty) queueStructuredItemSync(item);
          } else {
            state.items.unshift(incoming);
          }
          // The cron (or another device) already delivered this one — stay quiet here.
          if (incoming.notified) rememberNotified(incoming.id);
        }
        renderSyncConflictBanner();
        renderAll();
        refreshReminderSchedule();
      },
    )
    .subscribe();

  /* Merge each structured collection, never replace it. See mergeRecordLists() for why: the
     three `.map()` assignments this replaced deleted every person, goal and project that had
     been created or edited while the server was unreachable. */
  for (const kind of ["project", "goal", "person"]) {
    const key = RECORD_LIST_KEY[kind];
    const rows = await loadStructuredCollection(key, key);
    if (!rows) continue;
    const pending = [];
    const { items, conflicts } = mergeRecordLists(
      state[key],
      rows.map((row) => normaliseStructuredRecord(kind, row)),
      kind,
      (record) => pending.push(record),
    );
    state[key] = items;
    recordSyncConflicts(conflicts);
    pending.forEach((record) => queueStructuredRecordSync(kind, record));
  }
  renderSyncConflictBanner();
  renderProjects();
  renderGoals();
  renderNav();
  renderReports();
  // Review renders itself rather than waiting to be visited, so the nav badge and any deep link
  // into it are correct from a cold load.
  renderReview();

  structuredChannels.push(
    sb.channel("projects-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "projects",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") removeStructuredStateRecord("project", payload.old);
        else {
          mergeStructuredStateRecord("project", payload.new);
          renderProjects();
          renderNav();
        }
      },
    )
    .subscribe(),
  );

  structuredChannels.push(
    sb.channel("goals-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "goals",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") removeStructuredStateRecord("goal", payload.old);
        else {
          mergeStructuredStateRecord("goal", payload.new);
          renderGoals();
          renderReports();
        }
      },
    )
    .subscribe(),
  );

  structuredChannels.push(
    sb.channel("people-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "people",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") removeStructuredStateRecord("person", payload.old);
        else {
          mergeStructuredStateRecord("person", payload.new);
          renderPeople();
        }
      },
    )
    .subscribe(),
  );
  void flushStructuredSyncQueue();
}
let currentHouseholdId = null;

async function ensureHousehold(userId) {
  if (typeof fetch === "function" && userId) {
    try {
      const listRes = await apiFetch(`/api/households?user_id=${encodeURIComponent(userId)}`);
      if (listRes.ok) {
        const listData = await listRes.json();
        const households = Array.isArray(listData?.households)
          ? listData.households
          : [];

        if (households.length) {
          currentHouseholdId = households[0].id;
          return;
        }

        const createRes = await apiFetch("/api/households", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId }),
        });
        if (createRes.ok) {
          const createData = await createRes.json();
          if (createData?.household?.id) {
            currentHouseholdId = createData.household.id;
            return;
          }
        }
      }
    } catch (err) {
      console.warn("Household API initialization skipped:", err.message || err);
    }
  }

  const { data: membership } = await sb
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .limit(1);
  if (membership && membership.length) {
    currentHouseholdId = membership[0].household_id;
    return;
  }
  const { data: newHouse } = await sb
    .from("households")
    .insert({ created_by: userId, created: Date.now() })
    .select()
    .single();
  if (newHouse) {
    currentHouseholdId = newHouse.id;
    await sb
      .from("household_members")
      .insert({ household_id: newHouse.id, user_id: userId, role: "owner" });
  }
}

async function getInviteCode() {
  // maybeSingle(): a household with no invite_code yet is a null result, not a 406.
  const { data } = await sb
    .from("households")
    .select("invite_code")
    .eq("id", currentHouseholdId)
    .maybeSingle();
  return data ? data.invite_code : null;
}

async function showInviteCode() {
  if (!currentHouseholdId) return;
  const code = await getInviteCode();
  const el = document.getElementById("inviteCodeDisplay");
  if (el) el.textContent = code || "—";
}

async function loadHouseholdName() {
  if (syncReadyPromise) await syncReadyPromise;
  if (!currentHouseholdId) return;
  const { data } = await sb
    .from("households")
    .select("name")
    .eq("id", currentHouseholdId)
    .maybeSingle();
  const input = document.getElementById("householdNameInput");
  if (input && data) input.value = data.name || "My Household";
}

async function persistMembershipToBackend(householdId, userId, role = "member") {
  if (!householdId || !userId || typeof fetch !== "function") return false;
  try {
    const res = await apiFetch("/api/household-members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ household_id: householdId, user_id: userId, role }),
    });
    return res.ok;
  } catch (err) {
    console.warn("Membership backend sync skipped:", err.message || err);
    return false;
  }
}

async function saveHouseholdName() {
  const input = document.getElementById("householdNameInput");
  const name = input ? input.value.trim() : "";
  if (!name || !currentHouseholdId || typeof fetch !== "function") return;
  try {
    const res = await apiFetch("/api/households", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: currentHouseholdId, name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      flashSaveHint("householdSaveHint", data.error || "Could not save", true);
      return;
    }
    flashSaveHint("householdSaveHint", "Saved");
  } catch (err) {
    console.warn("Household name sync failed:", err.message || err);
    flashSaveHint("householdSaveHint", "Could not save", true);
  }
}

async function joinHousehold() {
  const code = document.getElementById("joinCodeInput").value.trim();
  const msg = document.getElementById("joinMessage");
  const btn = document.getElementById("joinHouseholdBtn");
  if (!code) {
    msg.textContent = "Enter a code.";
    return;
  }
  if (btn) btn.disabled = true;

  if (typeof fetch === "function") {
    try {
      const res = await apiFetch("/api/households", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: sbUser || currentUserId,
          invite_code: code,
          role: "member",
        }),
      });

      if (res.ok) {
        const data = await res.json();
        currentHouseholdId = data?.household?.id || currentHouseholdId;
        msg.style.color = "var(--accent)";
        msg.textContent = "Joined! Reloading your data…";
        await persistMembershipToBackend(currentHouseholdId, sbUser || currentUserId, "member");
        await startSupabaseSync(sbUser || currentUserId);
        showInviteCode();
        if (btn) btn.disabled = false;
        return;
      }
    } catch (err) {
      console.warn("Household join via backend failed, falling back to Supabase:", err.message || err);
    }
  }

  const { data: house } = await sb
    .from("households")
    .select("id")
    .eq("invite_code", code)
    // maybeSingle(): a code matching nothing returns 406, not a null row.
    .maybeSingle();
  if (!house) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = "Invalid invite code.";
    if (btn) btn.disabled = false;
    return;
  }
  await sb.from("household_members").delete().eq("user_id", sbUser);
  await sb
    .from("household_members")
    .insert({ household_id: house.id, user_id: sbUser, role: "member" });
  currentHouseholdId = house.id;
  msg.style.color = "var(--accent)";
  msg.textContent = "Joined! Reloading your data…";
  await persistMembershipToBackend(house.id, sbUser || currentUserId, "member");
  await startSupabaseSync(sbUser);
  showInviteCode();
  if (btn) btn.disabled = false;
}
function toggleAvatarMenu() {
  const menu = document.getElementById("avatarMenu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("avatarMenu");
  const wrap = document.getElementById("avatarWrap");
  if (
    menu &&
    menu.style.display === "block" &&
    !menu.contains(e.target) &&
    e.target !== wrap &&
    !wrap.contains(e.target)
  ) {
    menu.style.display = "none";
  }
});
/* Both of these used to sign out directly — one behind a browser confirm() dialog, the other with
   no warning at all. Now they go to the same page that explains what happens, so there is one
   sign-out and it says the same thing wherever it was started from. */
function confirmSignOut() {
  document.getElementById("avatarMenu").style.display = "none";
  switchView("logout");
}

let syncedUserId = null;

sb.auth.onAuthStateChange((event, session) => {
  const authScreen = document.getElementById("authScreen");
  if (event === "PASSWORD_RECOVERY") {
    authScreen.style.display = "flex";
    document.getElementById("authFormNormal").style.display = "none";
    document.getElementById("authFormForgot").style.display = "none";
    document.getElementById("authFormNewPassword").style.display = "block";
    return;
  }
  if (session) {
    authScreen.style.display = "none";
    currentUserEmail = session.user.email || "";
    switchView("today");
    if (syncedUserId !== session.user.id) {
      syncedUserId = session.user.id;
      syncReadyPromise = startSupabaseSync(session.user.id);
      showInviteCode();
      loadHouseholdName();
      loadProfile();
      const settingsEmail = document.getElementById("settingsEmail");
      if (settingsEmail) settingsEmail.textContent = session.user.email;
    }
    const name = session.user.email.split("@")[0];
    const greetEl = document.getElementById("greeting");
    if (greetEl) greetEl.textContent = `${greetingText()}, ${name}!`;
    const av = document.getElementById("avatarInitial");
    if (av) av.textContent = name.charAt(0).toUpperCase();
    document.getElementById("avatarMenuEmail").textContent = session.user.email;
  } else {
    syncedUserId = null;
    sbUser = null;
    currentUserEmail = "";
    currentHouseholdId = null;
    syncReadyPromise = null;
    authScreen.style.display = "flex";
  }
});
function showSettingsTab(tab) {
  const panel = document.getElementById("settingsTab-" + tab);
  if (!panel) return;
  document
    .querySelectorAll(".settings-panel")
    .forEach((p) => (p.style.display = "none"));
  panel.style.display = "block";
  document.querySelectorAll(".tab-vert").forEach((t) => {
    const active = t.dataset.tab === tab;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  panel.scrollIntoView({ block: "nearest" });
  if (tab === "ai") renderLocalModelSettings();
  if (tab === "notifications") {
    renderMorningDigestSettings();
    renderBirthdayReminderSettings();
  }
  refreshIcons();
}

/* The local model card. Reached only from the AI tab, so the probe cost is paid on demand rather
   than on every load. */
async function renderLocalModelSettings(force = false) {
  const cfg = localModelConfig();
  const enabled = document.getElementById("localModelEnabled");
  const url = document.getElementById("localModelUrl");
  const select = document.getElementById("localModelSelect");
  const status = document.getElementById("localModelStatus");
  if (!enabled || !url || !select || !status) return;
  if (document.activeElement !== url) url.value = cfg.baseUrl;
  enabled.checked = cfg.enabled;

  status.innerHTML = `<div class="field-row" style="padding:4px 0"><span class="field-label">Status</span><span style="font-size:13px">Checking…</span></div>`;

  const result = await localModelStatus(force);
  if (document.activeElement !== url) url.value = localModelConfig().baseUrl;

  // Keep the chosen model selected even when it is not in the list, so a model that was renamed
  // or removed does not silently look like a working selection.
  const names = result.models.includes(cfg.model) ? result.models : [cfg.model, ...result.models].filter(Boolean);
  select.innerHTML = names.length
    ? names
        .map(
          (name) =>
            `<option value="${escapeHtml(name)}"${name === cfg.model ? " selected" : ""}>${escapeHtml(name)}</option>`,
        )
        .join("")
    : '<option value="">Choose a model</option>';

  const value = result.reachable
    ? cfg.model
      ? `${cfg.model} — answering on this device`
      : "Choose a model to start answering"
    : result.reason;
  status.innerHTML = `<div class="field-row" style="padding:4px 0;align-items:flex-start"><span class="field-label">Status</span><span style="font-size:13px;text-align:right">${escapeHtml(value)}</span></div>`;
}

function toggleLocalModel(on) {
  saveLocalModelConfig({ enabled: on });
  renderLocalModelSettings(true);
}

/* Accepts whatever was pasted — a bare address, or the whole cloudflared banner with the address
   buried in it — and puts a tidy address in the box, so the field never shows a message of noise
   that would then be saved and fail. */
function saveLocalModelUrl(value) {
  const normalised = normaliseLocalModelUrl(value) || LOCAL_MODEL_URL;
  const field = document.getElementById("localModelUrl");
  if (field) field.value = normalised;
  saveLocalModelConfig({ baseUrl: normalised });
  renderLocalModelSettings(true);
}

function saveLocalModelName(value) {
  saveLocalModelConfig({ model: value });
  renderLocalModelSettings(true);
}

/* Arrow keys move between tabs, as expected for a tab list. */
document.addEventListener("keydown", (e) => {
  const tab = e.target.closest && e.target.closest(".tab-vert");
  if (!tab || (e.key !== "ArrowDown" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowLeft")) return;
  const tabs = [...document.querySelectorAll(".tab-vert")];
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
  const next = tabs[(index + step + tabs.length) % tabs.length];
  showSettingsTab(next.dataset.tab);
  next.focus();
});

/* Called every time Settings is opened, so the page always shows current data
   (delivery log, reminder counts, household name, profile) instead of whatever
   was left over from the last visit. */
function renderSettings() {
  updateNotifBtn();
  renderNotificationLog();
  showInviteCode();
  loadHouseholdName();
  if (sbUser) loadProfile();
  const sq = document.getElementById("settingsQuote");
  if (sq && currentQuoteIndex !== null)
    sq.textContent = '"' + MOTIVATION_QUOTES[currentQuoteIndex] + '"';
}

async function loadProfile() {
  if (syncReadyPromise) await syncReadyPromise;
  if (!sbUser) return;
  // maybeSingle(), not single(): PostgREST returns 406 PGRST116 for zero rows, and a new account
  // has no profile row until the first save.
  const { data } = await sb
    .from("profiles")
    .select("*")
    .eq("user_id", sbUser)
    .maybeSingle();
  const profile = data || {
    full_name: "",
    phone: "",
    avatar_url: "",
    date_format: "MM/DD/YYYY",
    time_format: "12h",
  };
  applyFormatPrefs(profile);
  document.getElementById("profileFullName").value = profile.full_name || "";
  document.getElementById("profilePhone").value = profile.phone || "";
  document.getElementById("dateFormatSelect").value =
    profile.date_format || "MM/DD/YYYY";
  document.getElementById("timeFormatSelect").value =
    profile.time_format || "12h";
  document.getElementById("themeSelect").value =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  renderThemePicker();
  // The session already has the email, so skip the /auth/v1/user round trip.
  const email = currentUserEmail || "";
  if (email) {
    document.getElementById("profileEmail").value = email;
    const fallbackName = email.split("@")[0];
    const displayName = profile.full_name?.trim() || fallbackName;
    const greetEl = document.getElementById("greeting");
    if (greetEl)
      greetEl.textContent = `${greetingText()}, ${displayName.split(" ")[0]}!`;
    const avatarInitial = document.getElementById("avatarInitial");
    if (avatarInitial)
      avatarInitial.textContent = displayName.charAt(0).toUpperCase();
    const sidebarName = document.getElementById("sidebarProfileName");
    const sidebarInitial = document.getElementById("sidebarProfileInitial");
    if (sidebarName) sidebarName.textContent = displayName;
    if (sidebarInitial) sidebarInitial.textContent = displayName.charAt(0).toUpperCase();
  }
  updateAvatarDisplay(profile.full_name, profile.avatar_url);
}

function updateAvatarDisplay(name, url) {
  const el = document.getElementById("settingsAvatar");
  const initial = document.getElementById("settingsAvatarInitial");
  if (!el || !initial) return;
  if (url) {
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundSize = "cover";
    initial.style.display = "none";
  } else {
    initial.textContent = (
      name ||
      document.getElementById("avatarInitial").textContent ||
      "?"
    )
      .charAt(0)
      .toUpperCase();
  }
}

async function saveProfile(btnEl) {
  if (!sbUser) {
    flashSaveHint("profileSaveHint", "Sign in to save", true);
    return;
  }
  const profile = {
    user_id: sbUser,
    full_name: document.getElementById("profileFullName").value.trim(),
    phone: document.getElementById("profilePhone").value.trim(),
    date_format: document.getElementById("dateFormatSelect").value,
    time_format: document.getElementById("timeFormatSelect").value,
    created: Date.now(),
  };
  if (btnEl) btnEl.disabled = true;
  const { error } = await sb.from("profiles").upsert(profile);
  if (btnEl) btnEl.disabled = false;
  if (error) {
    console.error("Profile save failed:", error.message);
    flashSaveHint("profileSaveHint", "Could not save — try again", true);
    return;
  }
  applyFormatPrefs(profile);
  // The name/format choices drive the greeting, the sidebar and every date
  // label, so re-render instead of leaving stale text on screen.
  const av = document.getElementById("avatarInitial");
  if (av && profile.full_name)
    av.textContent = profile.full_name.charAt(0).toUpperCase();
  const sidebarName = document.getElementById("sidebarProfileName");
  const sidebarInitial = document.getElementById("sidebarProfileInitial");
  if (sidebarName && profile.full_name) sidebarName.textContent = profile.full_name;
  if (sidebarInitial && profile.full_name)
    sidebarInitial.textContent = profile.full_name.charAt(0).toUpperCase();
  const greetEl = document.getElementById("greeting");
  if (greetEl && profile.full_name)
    greetEl.textContent = `${greetingText()}, ${profile.full_name.split(" ")[0]}!`;
  renderAll();
  flashSaveHint("profileSaveHint", "Saved");
  if (btnEl) flashButton(btnEl, "Saved");
}

/* Small, non-blocking confirmation next to the field that changed. */
function flashSaveHint(id, text, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "var(--red-fg)" : "";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.textContent = "";
  }, 2000);
}
function flashButton(btn, label) {
  const span = btn.querySelector("span");
  const original = span ? span.textContent : null;
  if (span) span.textContent = label;
  else btn.textContent = label;
  setTimeout(() => {
    if (span) span.textContent = original;
    else btn.textContent = original;
  }, 1500);
}

async function uploadAvatar() {
  const file = document.getElementById("avatarUploadInput").files[0];
  if (!file || !sbUser) return;
  const path = `${sbUser}/avatar_${Date.now()}.${file.name.split(".").pop()}`;
  const { error } = await sb.storage.from("captures").upload(path, file);
  if (error) {
    console.error("Avatar upload failed:", error.message);
    return;
  }
  const { data } = sb.storage.from("captures").getPublicUrl(path);
  await sb.from("profiles").upsert({
    user_id: sbUser,
    avatar_url: data.publicUrl,
    created: Date.now(),
  });
  updateAvatarDisplay(null, data.publicUrl);
}

function setThemeFromSelect() {
  const val = document.getElementById("themeSelect").value;
  document.documentElement.setAttribute("data-theme", val);
  // The concept carries its own dark palette, so a scheme change has to reach it.
  syncThemeScheme();
  state.theme = val;
  save();
}
