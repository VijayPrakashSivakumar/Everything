const SUPABASE_URL = "https://fyikavzqkezjykvxhqnz.supabase.co"; // e.g. https://xxxx.supabase.co
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5aWthdnpxa2V6anlrdnhocW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MTA3NDAsImV4cCI6MjEwNTM4Njc0MH0.nNI8-lKsVJCo1vTYCsmQNchBkaOOkJ5ur0FQz_d4QeI";

// Bump when the DOM contract in index.html changes. See repairVersionMismatch() below.
const APP_BUILD = "2026-09-25.9";

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
  };
  if (kind === "goal") normalized.done = row.done ?? row.status === "completed";
  return normalized;
}

function mergeStructuredStateRecord(kind, row) {
  if (!row || !canReadStructuredRow(row)) return;
  const normalized = normaliseStructuredRecord(kind, row);
  const list = kind === "project" ? state.projects : kind === "goal" ? state.goals : state.people;
  if (!Array.isArray(list)) return;
  const index = list.findIndex(
    (entry) => entry.id === normalized.id || (normalized.backendId && entry.backendId === normalized.backendId),
  );
  if (index >= 0) list[index] = { ...list[index], ...normalized };
  else list.unshift(normalized);
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
      metadata: { ...metadata, done: Boolean(record.done) },
    };
  }
  return {
    household_id: currentHouseholdId,
    user_id: sbUser,
    name: record.name || "",
    notes: record.notes || "",
    client_id: record.id,
    metadata,
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
          console.warn("Structured sync permanently failed:", operation.kind, result.data?.error || result.status);
          removeStructuredSyncOperation(operation.id);
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
    alert(
      'To install Everything, tap Share in Safari, then choose "Add to Home Screen".',
    );
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
function showNormalAuth() {
  document.getElementById("authFormForgot").style.display = "none";
  document.getElementById("authFormNormal").style.display = "block";
}

async function authForgotPassword() {
  const email = document.getElementById("forgotEmail").value.trim();
  const msg = document.getElementById("forgotMessage");
  if (!email) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = "Enter your email first.";
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  msg.style.color = error ? "var(--red-fg)" : "var(--accent)";
  msg.textContent = error
    ? error.message
    : "Check your email for a reset link.";
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
    const passwordInput = document.getElementById("authPassword");
    const newPasswordInput = document.getElementById("newPassword");
    if (passwordInput) passwordInput.value = "";
    if (newPasswordInput) newPasswordInput.value = "";
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
  if (logoutButton) {
    logoutButton.disabled = true;
    logoutButton.textContent = "Signing out...";
  }
  try {
    const signedOut = await authSignOut();
    if (signedOut) return;
  } finally {
    if (logoutButton) {
      logoutButton.disabled = false;
      logoutButton.innerHTML = `
        <svg class="logout-button-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8 3H4v14h4" />
          <path d="M11 6l4 4-4 4M6 10h9" />
        </svg>
        Log Out`;
    }
  }
}
let sbUser = null;
let sbChannel = null;
let structuredChannels = [];
let syncReadyPromise = null;
let hasCompletedAt = false;
let hasReminderColumns = false;
let hasChecklistColumn = false;
let hasRecurrenceKeyColumn = false;
let hasArchivedAtColumn = false;
const smartCaptureColumns = {
  sourceType: false,
  rawText: false,
  metadata: false,
  fingerprint: false,
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
  return row;
}
function rowToItem(row) {
  return {
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
  };
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
  await ensureHousehold(userId);
  sbUser = userId;
  hasCompletedAt = await detectCompletedAtColumn();
  hasReminderColumns = await detectReminderColumns();
  hasChecklistColumn = await detectChecklistColumn();
  hasRecurrenceKeyColumn = await detectRecurrenceKeyColumn();
  hasArchivedAtColumn = await detectArchivedAtColumn();
  await detectSmartCaptureColumns();
  const { data, error } = await sb
    .from("items")
    .select("*")
    .eq("household_id", currentHouseholdId)
    .order("created", { ascending: false });
  if (!error && data) {
    state.items = data.map(rowToItem);
    if (!state.projects) state.projects = [];
    if (!state.goals) state.goals = [];
    if (!state.people) state.people = [];
    state.items.forEach((item) => {
      if (item.notified) rememberNotified(item.id);
    });
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
          const updated = rowToItem(payload.new);
          const idx = state.items.findIndex((i) => i.id === updated.id);
          if (idx >= 0) state.items[idx] = updated;
          else state.items.unshift(updated);
          // The cron (or another device) already delivered this one — stay quiet here.
          if (updated.notified) rememberNotified(updated.id);
        }
        renderAll();
        refreshReminderSchedule();
      },
    )
    .subscribe();

  const projectRows = await loadStructuredCollection("projects", "projects");
  if (projectRows) state.projects = projectRows.map((row) => normaliseStructuredRecord("project", row));
  const goalRows = await loadStructuredCollection("goals", "goals");
  if (goalRows) state.goals = goalRows.map((row) => normaliseStructuredRecord("goal", row));
  const peopleRows = await loadStructuredCollection("people", "people");
  if (peopleRows) state.people = peopleRows.map((row) => normaliseStructuredRecord("person", row));
  renderProjects();
  renderGoals();
  renderNav();
  renderReports();

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
  const { data } = await sb
    .from("households")
    .select("invite_code")
    .eq("id", currentHouseholdId)
    .single();
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
    .single();
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
    .single();
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
function confirmSignOut() {
  if (confirm("Sign out of Everything?")) {
    authSignOut();
  }
  document.getElementById("avatarMenu").style.display = "none";
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
  refreshIcons();
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
  const { data } = await sb
    .from("profiles")
    .select("*")
    .eq("user_id", sbUser)
    .single();
  const profile = data || {
    full_name: "",
    phone: "",
    avatar_url: "",
    date_format: "MM/DD/YYYY",
    time_format: "12h",
  };
  applyFormatPrefs(profile);
  document.getElementById("profileFullName").value = profile.full_name || "";
  applyFormatPrefs(profile);
  document.getElementById("profilePhone").value = profile.phone || "";
  document.getElementById("dateFormatSelect").value =
    profile.date_format || "MM/DD/YYYY";
  document.getElementById("timeFormatSelect").value =
    profile.time_format || "12h";
  document.getElementById("themeSelect").value =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  const { data: authData } = await sb.auth.getUser();
  if (authData?.user) {
    document.getElementById("profileEmail").value = authData.user.email;
    const fallbackName = authData.user.email.split("@")[0];
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
  state.theme = val;
  save();
}

/* ---------- Data model ---------- */
const NAV = [
  { id: "today", icon: "layout-dashboard", label: "Dashboard" },
  { id: "inbox", icon: "inbox", label: "Inbox", badgeKey: "inboxCount" },
  { id: "tasks", icon: "check-square-2", label: "Tasks", badgeKey: "taskCount" },
  { id: "schedule", icon: "calendar-days", label: "Schedule" },
  { id: "memory", icon: "brain", label: "Memory" },
  { id: "people", icon: "users", label: "People" },
  { id: "projects", icon: "folder-kanban", label: "Projects" },
  { id: "goals", icon: "target", label: "Goals" },
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

function isArchived(item) {
  return Boolean(item?.archivedAt || item?.archived_at);
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
function nextOccurrence(iso, recurrence) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  else if (recurrence === "monthly") {
    // Date#setMonth overflows (Jan 31 -> Mar 3). Clamp to the last valid day
    // of the target month so monthly tasks remain predictable.
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
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
    try {
      const raw = localStorage.getItem("everything_state_v1");
      state = raw ? JSON.parse(raw) : seedData();
    } catch (e) {
      state = seedData();
    }
    if (!state.projects) state.projects = [];
    if (!state.goals) state.goals = [];
    if (!state.people) state.people = [];
    sharedItems = state.items;
    privateItems = [];
    if (state.theme)
      document.documentElement.setAttribute("data-theme", state.theme);
    renderAll();
    return;
  }

  const itemsCol = db.collection("items");
  const projCol = db.collection("projects");
  const goalCol = db.collection("goals");

  const existing = await itemsCol.get();
  if (existing.empty) {
    const seed = seedData();
    for (const it of seed.items) await itemsCol.doc(it.id).set(it);
    for (const p of seed.projects) await projCol.doc(p.id).set(p);
    for (const g of seed.goals) await goalCol.doc(g.id).set(g);
  }

  state = { items: [], projects: [], goals: [], theme: "light" };

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
      archivedAt: item.archivedAt || null,
    },
    client_id: item.id,
  };
}

async function dbSaveItem(item) {
  if (syncReadyPromise) await syncReadyPromise;
  if (!item.scope) item.scope = "shared";
  if (item.kind === "task" && item.recurrence && item.recurrence !== "none" && !item.recurrenceKey) {
    item.recurrenceKey = taskRecurrenceKey(item);
  } else if (item.kind === "task" && (!item.recurrence || item.recurrence === "none")) {
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

function save() {
  try {
    localStorage.setItem("everything_state_v1", JSON.stringify(state));
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
    el.onclick = () => switchView(item.id);
    nav.appendChild(el);
  });
  refreshIcons();
}

let activeView = "today";

function switchView(id) {
  activeView = id;
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + id).classList.add("active");
  renderNav();
  closeSidebar();
  if (id === "schedule") renderCalendar();
  if (id === "reports") renderReports();
  if (id === "projects") renderProjects();
  if (id === "goals") renderGoals();
  if (id === "tasks") renderTasks();
  if (id === "inbox") renderInbox();
  if (id === "memory") renderMemory();
  if (id === "people") renderPeople();
  if (id === "settings") renderSettings();

  const content = document.querySelector(".content");
  if (content) content.scrollTo({ top: 0, left: 0, behavior: "auto" });
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
      const [bg, fg] = kindColor(item.kind);
      const el = document.createElement("div");
      el.className = "recent-item";
      el.onclick = () => openPanel(item.id);
      el.innerHTML = `<div class="recent-dot" style="background:${bg};color:${fg};">${kindIcon(item.kind)}</div>
      <div><div class="recent-text">${escapeHtml(item.title)}</div><div class="recent-tag">${item.kind.charAt(0).toUpperCase() + item.kind.slice(1)}</div></div>
      <div class="recent-time">${timeAgo(item.created)}</div>`;
      recent.appendChild(el);
    });

  const insights = document.getElementById("insightsList");
  const insightData = getInsights();
  insights.innerHTML = insightData
    .map(
      (i) =>
        `<div class="insight-item"><span>${icon(i.icon)}</span><div><div class="insight-title">${i.title}</div><div class="insight-sub">${i.sub}</div></div></div>`,
    )
    .join("");
  document.getElementById("insightsFull").innerHTML =
    insights.innerHTML || '<p class="empty">Nothing to show yet.</p>';
  const statsEl = document.getElementById("insightsStats");
  if (statsEl) {
  const activeItems = state.items.filter((i) => !isArchived(i));
  const totalItems = activeItems.length;
  const completedCount = activeItems.filter((i) => i.done).length;
  const activeDays = new Set(
    activeItems.map((i) => new Date(i.created).toDateString()),
  ).size;
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);"><i data-lucide="inbox"></i></div><div><div class="stat-num">${totalItems}</div><div class="stat-label">Total captured</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);"><i data-lucide="circle-check"></i></div><div><div class="stat-num">${completedCount}</div><div class="stat-label">Completed</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);"><i data-lucide="calendar-days"></i></div><div><div class="stat-num">${activeDays}</div><div class="stat-label">Active days</div></div></div>
    `;
    refreshIcons();
  }
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

function taskRow(item) {
  const row = document.createElement("div");
  row.className = "task-row" + (item.done ? " done" : "") + (isArchived(item) ? " archived" : "");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.onclick = (e) => {
    if (e.target.closest(".checkbox, button")) return;
    openPanel(item.id);
  };
  row.onkeydown = (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPanel(item.id);
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
  return row;
}

const taskMutationInFlight = new Set();

async function createRecurringOccurrence(item) {
  if (!item.done || item.kind !== "task" || !item.recurrence || item.recurrence === "none" || !item.dueDate) return;
  const nextDue = nextOccurrence(item.dueDate, item.recurrence);
  if (!nextDue) return;
  const seriesKey = taskRecurrenceKey(item);
  const nextId = recurringOccurrenceId(seriesKey, nextDue);
  // Occurrence ids are deterministic, so a retry or a second device converges
  // on the same row instead of creating another copy.
  const alreadyQueued = state.items.some(
    (candidate) => candidate.id === nextId || (
      candidate.kind === "task" &&
      candidate.recurrenceKey === seriesKey &&
      candidate.dueDate === nextDue
    ),
  );
  if (alreadyQueued) return;
  const next = {
    ...item,
    id: nextId,
    recurrenceKey: seriesKey,
    ownerId: sbUser || currentUserId || item.ownerId || null,
    backendEntryId: null,
    backendTaskId: null,
    done: false,
    completedAt: "",
    checklist: normaliseChecklist(item.checklist).map((step) => ({ ...step, done: false })),
    notified: false,
    notifiedAt: "",
    snoozedUntil: "",
    archivedAt: 0,
    dueDate: nextDue,
    due: formatDueDisplay(nextDue),
    created: Date.now(),
    status: isToday(nextDue) ? "today" : "planned",
  };
  state.items.unshift(next);
  await dbSaveItem(next);
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

function renderInbox(filter) {
  filter = filter || "all";
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
        `<div class="tab ${id === filter ? "active" : ""}" onclick="renderInbox('${id}')">${label}</div>`,
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
    return;
  }
  items.forEach((item) => list.appendChild(taskRow(item)));
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
          `<div class="tab ${id === filter ? "active" : ""}" onclick="renderTasks('${id}')">${label}</div>`,
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
  tasks.forEach((t) => list.appendChild(taskRow(t)));
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
          (i) => `<div class="task-row" onclick="openPanel('${i.id}')">
        <div class="task-meta"><div class="task-title">${i.scope === "private" ? icon("lock") + " " : ""}${escapeHtml(i.title)}</div>
        <div class="task-sub">${timeAgo(i.created)}${i.person ? " · " + icon("user") + " " + escapeHtml(i.person) : ""}</div></div>
      </div>`,
        )
        .join("")}</div>
    </div>`,
    )
    .join("");
}

function renderPeople() {
  const el = document.getElementById("peopleList");
  if (!el) return;
  const namesFromItems = [
    ...new Set(state.items.filter((i) => i.person && !isArchived(i)).map((i) => i.person)),
  ];
  const knownNames = state.people.map((p) => p.name);
  const inferredOnly = namesFromItems.filter((n) => !knownNames.includes(n));

  const rows = [
    ...state.people.map((p) => ({
      id: p.id,
      name: p.name,
      notes: p.notes || "",
      real: true,
    })),
    ...inferredOnly.map((n) => ({ id: null, name: n, notes: "", real: false })),
  ];

  if (!rows.length) {
    el.innerHTML =
      '<p class="empty">No people yet — add one below or tag someone on a task.</p>';
    return;
  }

  el.innerHTML = rows
    .map((p) => {
      const count = state.items.filter((i) => i.person === p.name && !isArchived(i)).length;
      return `<div class="task-row" onclick="openPersonModal(${p.id ? `'${p.id}'` : "null"}, '${escapeHtml(p.name)}')">
      <div class="avatar" style="width:32px;height:32px;font-size:12px;">${p.name.charAt(0).toUpperCase()}</div>
      <div class="task-meta"><div class="task-title">${escapeHtml(p.name)}</div><div class="task-sub">${count} linked item${count !== 1 ? "s" : ""}${p.notes ? " · has notes" : ""}</div></div>
    </div>`;
    })
    .join("");
}
let currentPersonName = null;
function openPersonModal(id, name) {
  currentPersonName = name;
  const person = state.people.find((p) => p.name === name);
  document.getElementById("personModalName").textContent = name;
  document.getElementById("personNotes").value = person
    ? person.notes || ""
    : "";
  const items = state.items.filter((i) => i.person === name && !isArchived(i));
  const list = document.getElementById("personItemsList");
  list.innerHTML = items.length
    ? items
        .map(
          (i) =>
            `<div class="task-row" onclick="closePersonModal();openPanel('${i.id}')"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? icon("check") : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`,
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
async function savePersonNotes() {
  if (!currentPersonName) return;
  let person = state.people.find((p) => p.name === currentPersonName);
  const notes = document.getElementById("personNotes").value.trim();
  if (!person) {
    person = { id: cid(), name: currentPersonName, notes, created: Date.now() };
    state.people.unshift(person);
  } else {
    person.notes = notes;
  }
  await dbSavePerson(person);
  closePersonModal();
}

async function addPersonManual() {
  const input = document.getElementById("newPersonInput");
  const name = input.value.trim();
  if (!name) return;
  if (state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    input.value = "";
    return;
  }
  const p = { id: cid(), name, notes: "", created: Date.now() };
  state.people.unshift(p);
  input.value = "";
  await dbSavePerson(p);
}

/* ---------- Projects ---------- */
async function addProject() {
  const input = document.getElementById("newProjectInput");
  const name = input.value.trim();
  if (!name) return;
  const p = { id: cid(), name, created: Date.now() };
  state.projects.unshift(p);
  input.value = "";
  await dbSaveProject(p);
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
      const items = state.items.filter((i) => i.project === p.name && !isArchived(i));
      const done = items.filter((i) => i.done).length;
      const total = items.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `<div class="card">
      <div class="card-head">
        <h3>${escapeHtml(p.name)}</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge task">${total - done} open</span>
          <button class="btn danger" style="padding:4px 10px;font-size:12px;" onclick="deleteProject('${p.id}','${escapeHtml(p.name)}')">Delete</button>
        </div>
      </div>
      ${
        total
          ? `<div style="background:var(--bg);border-radius:6px;height:6px;margin-bottom:12px;overflow:hidden;">
        <div style="background:var(--green-fg);height:100%;width:${pct}%;transition:width .3s;"></div>
      </div><p style="font-size:12px;color:var(--muted);margin:-6px 0 12px;">${pct}% complete (${done}/${total})</p>`
          : ""
      }
      ${items.length ? items.map((i) => `<div class="task-row" onclick="openPanel('${i.id}')"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? icon("check") : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`).join("") : '<p class="empty">No items here yet.</p>'}
    </div>`;
    })
    .join("");
}

/* ---------- Goals ---------- */
async function addGoal() {
  const input = document.getElementById("newGoalInput");
  const title = input.value.trim();
  if (!title) return;
  const g = { id: cid(), title, done: false, created: Date.now() };
  state.goals.unshift(g);
  input.value = "";
  await dbSaveGoal(g);
}
async function toggleGoal(id) {
  const g = state.goals.find((g) => g.id === id);
  if (g) {
    g.done = !g.done;
    await dbSaveGoal(g);
  }
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

  const renderRow = (g) => {
    const days = Math.floor((Date.now() - g.created) / 86400000);
    return `<div class="task-row">
      <div class="checkbox ${g.done ? "checked" : ""}" onclick="toggleGoal('${g.id}')">${g.done ? icon("check") : ""}</div>
      <div class="task-meta">
        <div class="task-title" style="${g.done ? "text-decoration:line-through;color:var(--muted);" : ""}">${escapeHtml(g.title)}</div>
        <div class="task-sub">${g.done ? "Completed" : days === 0 ? "Started today" : `In progress · ${days} day${days !== 1 ? "s" : ""}`}</div>
      </div>
      <button class="btn danger" style="padding:4px 10px;font-size:12px;" onclick="deleteGoal('${g.id}')">Delete</button>
    </div>`;
  };

  let html = "";
  if (active.length) html += active.map(renderRow).join("");
  if (done.length)
    html +=
      `<div class="card-head" style="margin-top:${active.length ? "16px" : "0"};"><h3 style="font-size:13px;color:var(--muted);">Completed (${done.length})</h3></div>` +
      done.map(renderRow).join("");
  el.innerHTML = html;
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

/* ---------- Calendar ---------- */
let calViewDate = new Date();
let calMode = "week";

function getScheduledItems() {
  return state.items.filter((i) => i.dueDate && !i.done && !isArchived(i));
}
function getWeekStart(d) {
  const date = new Date(d);
  date.setDate(date.getDate() - date.getDay());
  date.setHours(0, 0, 0, 0);
  return date;
}
function setCalView(mode) {
  calMode = mode;
  renderCalendar();
}
function calGoToday() {
  calViewDate = new Date();
  renderCalendar();
}
function calNav(dir) {
  if (calMode === "week") calViewDate.setDate(calViewDate.getDate() + dir * 7);
  else calViewDate.setMonth(calViewDate.getMonth() + dir);
  renderCalendar();
}

function renderCalendar() {
  const wTab = document.getElementById("calTabWeek"),
    mTab = document.getElementById("calTabMonth");
  if (wTab) wTab.classList.toggle("active", calMode === "week");
  if (mTab) mTab.classList.toggle("active", calMode === "month");
  document.getElementById("calWeekView").style.display =
    calMode === "week" ? "block" : "none";
  document.getElementById("calGrid").style.display =
    calMode === "month" ? "grid" : "none";
  if (calMode === "week") renderWeekView();
  else renderMonthView();
}

function renderWeekView() {
  const container = document.getElementById("calWeekView");
  const start = getWeekStart(calViewDate);
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  document.getElementById("calRangeLabel").textContent =
    `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  const startHour = 7,
    endHour = 20,
    rowHeight = 50;
  const hours = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  const scheduled = getScheduledItems();

  let html = `<div class="cal-week-wrap"><div class="cal-time-col"><div class="cal-week-head-spacer"></div>`;
  hours.forEach((h) => {
    html += `<div class="cal-hour-label">${h === 12 ? "12 PM" : h < 12 ? h + " AM" : h - 12 + " PM"}</div>`;
  });
  html += `</div><div class="cal-week-days">`;

  days.forEach((day) => {
    const isToday = day.toDateString() === new Date().toDateString();
    html += `<div class="cal-week-day-col">
      <div class="cal-week-day-head ${isToday ? "today" : ""}"><span>${day.toLocaleDateString(undefined, { weekday: "short" })}</span><span class="num">${day.getDate()}</span></div>
      <div class="cal-week-day-body" style="height:${hours.length * rowHeight}px;">`;
    hours.forEach(() => {
      html += `<div class="cal-hour-row"></div>`;
    });

    // Events are placed in lanes so simultaneous items sit side by side
    // instead of stacking on top of each other, and are clamped to the body
    // so nothing spills past the 8 PM row.
    const bodyHeight = hours.length * rowHeight;
    const dayItems = scheduled
      .filter((i) => new Date(i.dueDate).toDateString() === day.toDateString())
      .map((item) => {
        const d = new Date(item.dueDate);
        const start = d.getHours() + d.getMinutes() / 60;
        return { item, d, start };
      })
      .filter((e) => e.start >= startHour && e.start < endHour + 1)
      .sort((a, b) => a.start - b.start);

    const laneEnds = [];
    dayItems.forEach((e) => {
      let lane = laneEnds.findIndex((end) => end <= e.start);
      if (lane === -1) {
        laneEnds.push(e.start + 1);
        lane = laneEnds.length - 1;
      } else {
        laneEnds[lane] = e.start + 1;
      }
      e.lane = lane;
    });
    const laneCount = Math.max(laneEnds.length, 1);
    const laneWidth = 100 / laneCount;

    dayItems.forEach((e) => {
      const top = Math.max(0, (e.start - startHour) * rowHeight);
      const height = Math.min(rowHeight - 4, bodyHeight - top);
      if (height < 14) return;
      const [bg, fg] = kindColor(e.item.kind);
      const time = fmtTime(e.d);
      html += `<div class="cal-week-event" title="${escapeHtml(time + " " + e.item.title)}" style="top:${top}px;height:${height}px;left:calc(${(e.lane * laneWidth).toFixed(4)}% + 4px);width:calc(${laneWidth.toFixed(4)}% - 8px);background:${bg};color:${fg};" onclick="openPanel('${e.item.id}')"><b>${time}</b> ${escapeHtml(e.item.title)}</div>`;
    });
    html += `</div></div>`;
  });
  html += `</div></div>`;
  container.innerHTML = html;
}

function renderMonthView() {
  const now = calViewDate;
  document.getElementById("calRangeLabel").textContent = now.toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );
  const grid = document.getElementById("calGrid");
  grid.innerHTML = "";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
    const h = document.createElement("div");
    h.className = "cal-day-head";
    h.textContent = d;
    grid.appendChild(h);
  });
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  const scheduled = getScheduledItems();
  for (let i = 0; i < startOffset; i++) {
    const c = document.createElement("div");
    c.className = "cal-cell";
    grid.appendChild(c);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(now.getFullYear(), now.getMonth(), d);
    const c = document.createElement("div");
    c.className =
      "cal-cell" +
      (cellDate.toDateString() === new Date().toDateString() ? " today" : "");
    const num = document.createElement("div");
    num.className = "num";
    num.textContent = d;
    c.appendChild(num);
    scheduled
      .filter(
        (i) => new Date(i.dueDate).toDateString() === cellDate.toDateString(),
      )
      .forEach((item) => {
        const ev = document.createElement("div");
        ev.className = "cal-event";
        ev.onclick = () => openPanel(item.id);
        ev.textContent = fmtTime(item.dueDate) + " " + item.title;
        c.appendChild(ev);
      });
    grid.appendChild(c);
  }
}

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

  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
  refreshIcons();
}

function renderRelatedChips(item) {
  const container = document.getElementById("panelRelated");
  const chips = [];

  if (item.person) {
    chips.push({
      label: `${icon("user")} ${item.person}`,
      tag: "Person",
      onclick: `closePanel();openPersonModal(null,'${escapeHtml(item.person)}')`,
    });
  }
  if (item.project) {
    chips.push({
      label: `${icon("folder-kanban")} ${item.project}`,
      tag: "Project",
      onclick: `closePanel();switchView('projects')`,
    });
  }

  const related = state.items
    .filter(
      (i) =>
        i.id !== item.id &&
        !isArchived(i) &&
        ((item.person && i.person === item.person) ||
          (item.project && i.project === item.project)),
    )
    .slice(0, 5);

  related.forEach((r) => {
    chips.push({
      label: `${kindIcon(r.kind)} ${r.title}`,
      tag: r.kind.charAt(0).toUpperCase() + r.kind.slice(1),
      onclick: `closePanel();openPanel('${r.id}')`,
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
  document.getElementById("editModal").classList.add("open");
  lockPageScroll(true);
}
function closeEditModal() {
  document.getElementById("editModal").classList.remove("open");
  if (!document.querySelector(".modal-overlay.open, .ask-overlay.open, #panel.open"))
    lockPageScroll(false);
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
  if (!confirm("Delete this goal?")) return;
  await dbDeleteGoal(id);
}

async function deleteProject(id, name) {
  if (
    !confirm(
      `Delete "${name}"? Items linked to it will keep their project tag but the project itself will be removed.`,
    )
  )
    return;
  await dbDeleteProject(id);
}

/* ---------- Capture modal ---------- */
const CAPTURE_TYPES = [
  { id: "text", icon: "file-text", label: "Text" },
  { id: "task", icon: "check-square-2", label: "Task" },
  { id: "event", icon: "calendar-days", label: "Event" },
  { id: "memory", icon: "brain", label: "Memory" },
  { id: "waiting", icon: "hourglass", label: "Waiting for" },
  { id: "openloop", icon: "circle-help", label: "Open loop" },
  { id: "voice", icon: "mic", label: "Voice" },
  { id: "image", icon: "image", label: "Image" },
  { id: "file", icon: "paperclip", label: "File" },
  { id: "link", icon: "link", label: "Link" },
];
let mediaRecorder = null;
let recordedChunks = [];
let recordingSeconds = 0;
let recordingInterval = null;
let pendingBlob = null;
let pendingBlobExt = null;

/* Dictation languages. The browser recogniser only understands one language per session, so this
   is chosen explicitly instead of inheriting navigator.language — that default meant a Tamil or
   Hindi speaker got English transcription and a garbled capture.

   `tag` is the BCP-47 code the Web Speech API expects; `label` is shown in the picker.
   `hint` is a native-script example so the option is recognisable to the person speaking. */
const VOICE_LANGUAGES = [
  { tag: "en-IN", label: "English", hint: "English" },
  { tag: "ta-IN", label: "Tamil", hint: "தமிழ்" },
  { tag: "hi-IN", label: "Hindi", hint: "हिन्दी" },
  { tag: "te-IN", label: "Telugu", hint: "తెలుగు" },
  { tag: "kn-IN", label: "Kannada", hint: "ಕನ್ನಡ" },
  { tag: "ml-IN", label: "Malayalam", hint: "മലയാളം" },
];

/* Chosen once per capture and reused, so the recorded audio and the transcript agree. */
let captureVoiceLang = "";
/* The language actually used for the last dictation, saved onto the capture. */
let captureVoiceLanguage = "";

function defaultVoiceLang() {
  const preferred = String(navigator.language || "").toLowerCase();
  const exact = VOICE_LANGUAGES.find((entry) => entry.tag.toLowerCase() === preferred);
  if (exact) return exact.tag;
  const base = preferred.split("-")[0];
  const loose = VOICE_LANGUAGES.find((entry) => entry.tag.toLowerCase().split("-")[0] === base);
  return loose ? loose.tag : "en-IN";
}

function pickVoiceLang(tag) {
  captureVoiceLang = VOICE_LANGUAGES.some((entry) => entry.tag === tag) ? tag : defaultVoiceLang();
  document
    .querySelectorAll("#voiceLangRow .type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.lang === captureVoiceLang));
}

function renderVoiceLanguages() {
  const row = document.getElementById("voiceLangRow");
  if (!row) return;
  if (!captureVoiceLang) captureVoiceLang = defaultVoiceLang();
  row.innerHTML = VOICE_LANGUAGES.map(
    (entry) =>
      `<div class="type-chip ${entry.tag === captureVoiceLang ? "active" : ""}" data-lang="${entry.tag}" onclick="pickVoiceLang('${entry.tag}')"><span>${entry.hint}</span></div>`,
  ).join("");
}

function setVoiceRecordLabel(label, icon) {
  const btn = document.getElementById("voiceRecordBtn");
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${icon || "mic"}" aria-hidden="true"></i><span id="voiceRecordLabel">${label}</span>`;
  refreshIcons();
}

function setVoiceDictateLabel(label, icon) {
  const btn = document.getElementById("voiceDictateBtn");
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${icon || "audio-lines"}" aria-hidden="true"></i><span id="voiceDictateLabel">${label}</span>`;
  refreshIcons();
}

function setVoiceDictationStatus(message) {
  const status = document.getElementById("voiceDictationStatus");
  if (status) status.textContent = message || "";
}

function stopVoiceDictation() {
  const recognition = captureVoiceRecognition;
  captureVoiceRecognition = null;
  captureVoiceActive = false;
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.stop();
    } catch (error) {
      // Recognition may already be stopped by the browser.
    }
  }
  setVoiceDictateLabel("Dictate text", "audio-lines");
}

function toggleVoiceDictation() {
  if (captureVoiceActive) {
    stopVoiceDictation();
    setVoiceDictationStatus("Dictation stopped.");
    return;
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setVoiceDictationStatus("Dictation is not supported in this browser. You can still record audio or type the note.");
    return;
  }

  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  const input = document.getElementById("captureText");
  const base = input.value.trim();
  const recognition = new Recognition();
  captureVoiceRecognition = recognition;
  captureVoiceActive = true;
  captureVoiceFinal = "";
  captureVoiceBase = base;
  // Use the language the person picked. This used to be navigator.language, so anyone whose
  // browser was not set to English got English transcription of non-English speech.
  if (!captureVoiceLang) captureVoiceLang = defaultVoiceLang();
  captureVoiceLanguage = captureVoiceLang;
  recognition.lang = captureVoiceLang;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onstart = () => {
    setVoiceDictateLabel("Stop dictation", "square");
    setVoiceDictationStatus("Listening… speak your capture.");
  };
  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) final += `${transcript} `;
      else interim += transcript;
    }
    captureVoiceFinal = `${captureVoiceFinal}${final}`.trim();
    const spoken = `${captureVoiceFinal} ${interim}`.trim();
    input.value = [captureVoiceBase, spoken].filter(Boolean).join(" ");
    onCaptureInput();
  };
  recognition.onerror = (event) => {
    const message = event.error === "not-allowed"
      ? "Microphone permission was denied."
      : event.error === "no-speech"
        ? "No speech was detected. Try again."
        : "Dictation could not start. You can type or record audio instead.";
    setVoiceDictationStatus(message);
  };
  recognition.onend = () => {
    if (captureVoiceRecognition === recognition) {
      captureVoiceRecognition = null;
      captureVoiceActive = false;
      setVoiceDictateLabel("Dictate text", "audio-lines");
      if (captureVoiceFinal) setVoiceDictationStatus("Dictation added. Review it before saving.");
    }
  };

  try {
    recognition.start();
  } catch (error) {
    captureVoiceRecognition = null;
    captureVoiceActive = false;
    setVoiceDictateLabel("Dictate text", "audio-lines");
    setVoiceDictationStatus("Dictation could not start in this browser.");
  }
}

async function toggleVoiceRecording() {
  if (captureVoiceActive) stopVoiceDictation();
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      pendingBlob = blob;
      pendingBlobExt = "webm";
      document.getElementById("voicePreview").src = URL.createObjectURL(blob);
      document.getElementById("voicePreview").style.display = "block";
      clearInterval(recordingInterval);
      document.getElementById("voiceTimer").textContent = "";
      setVoiceRecordLabel("Re-record", "mic");
      stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.start();
    recordingSeconds = 0;
    setVoiceRecordLabel("Stop recording", "square");
    recordingInterval = setInterval(() => {
      recordingSeconds++;
      document.getElementById("voiceTimer").textContent =
        `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;
    }, 1000);
  } catch (e) {
    alert("Microphone access denied or unavailable.");
  }
}

function previewImageFile() {
  const file = document.getElementById("imageFileInput").files[0];
  if (!file) return;
  pendingBlob = file;
  pendingBlobExt = file.name.split(".").pop();
  const preview = document.getElementById("imagePreview");
  preview.src = URL.createObjectURL(file);
  preview.style.display = "block";
  // A new image invalidates any text read from the previous one.
  imageOcrText = "";
  setImageOcrStatus("");
}

/* ---------- Image text reading (OCR) ----------
   Runs entirely in the browser through Tesseract.js (WebAssembly): no API key, no cost, and
   the image never leaves the device — which is the whole point on a machine like this one.

   Everything here is opt-in and failure-tolerant. The library is fetched from a CDN only when
   the person actually presses "Read text", so a normal capture never pays for it, and if the
   download fails (offline, blocked CDN) the capture sheet carries on working exactly as before
   with a plain one-line explanation. */
const OCR_LANGUAGES = [
  { tag: "en", label: "English" },
  { tag: "ta", label: "தமிழ்" },
  { tag: "hi", label: "हिन्दी" },
  { tag: "te", label: "తెలుగు" },
  { tag: "kn", label: "ಕನ್ನಡ" },
  { tag: "ml", label: "മലയാളം" },
];
const OCR_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

let captureOcrLang = "en";
let ocrScriptPromise = null;
let ocrWorker = null;
let ocrBusy = false;
let imageOcrText = "";

function setImageOcrStatus(message) {
  const status = document.getElementById("imageOcrStatus");
  if (status) status.textContent = message || "";
}

function pickOcrLang(tag) {
  if (!OCR_LANGUAGES.some((entry) => entry.tag === tag)) return;
  captureOcrLang = tag;
  document
    .querySelectorAll("#imageOcrLangRow .type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.lang === captureOcrLang));
}

function renderOcrLanguages() {
  const row = document.getElementById("imageOcrLangRow");
  if (!row) return;
  row.innerHTML = OCR_LANGUAGES.map(
    (entry) =>
      `<div class="type-chip ${entry.tag === captureOcrLang ? "active" : ""}" data-lang="${entry.tag}" onclick="pickOcrLang('${entry.tag}')"><span>${entry.label}</span></div>`,
  ).join("");
}

/* Loads Tesseract on first use. Resolves to the global, or rejects — never throws into the
   caller, so a failed download degrades to "type the text yourself". */
function loadOcrEngine() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (ocrScriptPromise) return ocrScriptPromise;
  ocrScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OCR_SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.Tesseract
        ? resolve(window.Tesseract)
        : reject(new Error("The text reader loaded but did not start."));
    script.onerror = () => reject(new Error("The text reader could not be downloaded."));
    document.head.appendChild(script);
  }).catch((error) => {
    // Let a later attempt retry rather than caching the failure forever.
    ocrScriptPromise = null;
    throw error;
  });
  return ocrScriptPromise;
}

function setOcrButtonBusy(busy) {
  const button = document.getElementById("imageOcrBtn");
  if (!button) return;
  button.disabled = busy;
  const label = document.getElementById("imageOcrLabel");
  if (label) label.textContent = busy ? "Reading…" : "Read text from image";
}

async function runImageOcr() {
  if (ocrBusy) return;
  if (!pendingBlob) {
    setImageOcrStatus("Choose an image first.");
    return;
  }

  ocrBusy = true;
  setOcrButtonBusy(true);
  try {
    setImageOcrStatus("Loading the text reader…");
    const Tesseract = await loadOcrEngine();

    setImageOcrStatus("Preparing…");
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker(captureOcrLang, 1, {
        logger: (message) => {
          // Progress is reported by Tesseract as a 0..1 fraction per stage.
          if (message?.status && typeof message.progress === "number") {
            const percent = Math.round(message.progress * 100);
            setImageOcrStatus(`${message.status} ${percent}%`);
          }
        },
      });
    }

    setImageOcrStatus("Reading the image…");
    const { data } = await ocrWorker.recognize(pendingBlob);
    const text = String(data?.text || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) {
      setImageOcrStatus("No text was found. Try a clearer, closer photo, or type the note yourself.");
      return;
    }

    imageOcrText = text;
    // The recognised text becomes the capture body, so the existing smart-capture pipeline
    // treats a photographed receipt or note exactly like typed text: same suggestions, same
    // duplicate protection, same Task/Event/Reminder outcome. No new code path to maintain.
    const input = document.getElementById("captureText");
    input.value = text;
    setImageOcrStatus(`Read ${text.length} characters. Edit anything that looks wrong, then save.`);
    onCaptureInput();
  } catch (error) {
    // Soft failure: the capture sheet must stay usable with no text read at all.
    setImageOcrStatus(
      `${error?.message || "Text reading failed."} You can still type the note yourself.`,
    );
    console.warn("image ocr failed:", error);
  } finally {
    ocrBusy = false;
    setOcrButtonBusy(false);
  }
}

function previewGenericFile() {
  const file = document.getElementById("genericFileInput").files[0];
  if (!file) return;
  pendingBlob = file;
  pendingBlobExt = file.name.split(".").pop();
  document.getElementById("fileNamePreview").textContent =
    `Selected: ${file.name}`;
}

async function uploadPendingBlob() {
  if (!pendingBlob || !sbUser) return null;
  const path = `${sbUser}/${cid()}.${pendingBlobExt}`;
  const { error } = await sb.storage.from("captures").upload(path, pendingBlob);
  if (error) {
    console.error("Upload failed:", error.message);
    return null;
  }
  const { data } = sb.storage.from("captures").getPublicUrl(path);
  return data.publicUrl;
}
let captureAutoDetected = false;
let captureScope = "shared";
let captureSmartEnabled = true;
let captureExtraction = null;
let captureSuggestionFields = {};
let captureDuplicate = null;
let captureQuestions = [];
let captureVoiceRecognition = null;
let captureVoiceActive = false;
let captureVoiceFinal = "";
let captureVoiceBase = "";
let captureSaveInFlight = false;

function pickScope(scope) {
  captureScope = scope;
  document
    .querySelectorAll("#visibilityRow .type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.scope === scope));
}
function openCapture() {
  captureType = "text";
  if (document.getElementById("sidebar").classList.contains("open"))
    toggleSidebar();
  captureAutoDetected = false;
  captureScope = "shared";
  captureSmartEnabled = true;
  captureExtraction = null;
  captureSuggestionFields = {};
  captureDuplicate = null;
  captureVoiceFinal = "";
  captureVoiceBase = "";
  stopVoiceDictation();
  pickScope("shared");
  const row = document.getElementById("typeRow");
  row.innerHTML = CAPTURE_TYPES.map(
    (t) =>
      `<div class="type-chip ${t.id === captureType ? "active" : ""}" data-type="${t.id}" onclick="pickType('${t.id}', true)"><i data-lucide="${t.icon}"></i><span>${t.label}</span></div>`,
  ).join("");
  refreshIcons();
  document.getElementById("captureText").value = "";
  document.getElementById("captureText").placeholder = "What's on your mind?";
  document.getElementById("captureHint").textContent = "";
  captureQuestions = [];
  const questionCard = document.getElementById("captureQuestion");
  if (questionCard) {
    questionCard.hidden = true;
    questionCard.innerHTML = "";
  }
  document.getElementById("captureDuplicateWarning").hidden = true;
  document.getElementById("clearCaptureSuggestionsBtn").disabled = true;
  const smartToggle = document.getElementById("captureSmartEnabled");
  if (smartToggle) smartToggle.checked = true;
  populateProjectSelect();
  document.getElementById("captureModal").classList.add("open");
  lockPageScroll(true);
  document.getElementById("captureDueDate").value = "";
  document.getElementById("captureRecurrence").value = "none";
  document.getElementById("capturePriority").value = "";
  document.getElementById("capturePerson").value = "";
  document.getElementById("voiceCaptureUI").style.display = "none";
  document.getElementById("imageCaptureUI").style.display = "none";
  document.getElementById("fileCaptureUI").style.display = "none";
  document.getElementById("linkCaptureUI").style.display = "none";
  document.getElementById("captureText").style.display = "block";
  document.getElementById("voicePreview").style.display = "none";
  document.getElementById("imagePreview").style.display = "none";
  document.getElementById("imageOcrStatus").textContent = "";
  setOcrButtonBusy(false);
  imageOcrText = "";
  renderOcrLanguages();
  document.getElementById("fileNamePreview").textContent = "";
  document.getElementById("linkUrlInput").value = "";
  document.getElementById("imageFileInput").value = "";
  document.getElementById("genericFileInput").value = "";
  document.getElementById("voiceDictationStatus").textContent = "";
  setVoiceDictateLabel("Dictate text", "audio-lines");
  captureVoiceLanguage = "";
  pickVoiceLang(defaultVoiceLang());
  renderVoiceLanguages();
  pendingBlob = null;
  pendingBlobExt = null;
  if (mediaRecorder && mediaRecorder.state === "recording")
    mediaRecorder.stop();
  setVoiceRecordLabel("Start recording", "mic");
  setTimeout(() => document.getElementById("captureText").focus(), 50);
}
function populateProjectSelect() {
  const sel = document.getElementById("captureProject");
  sel.innerHTML =
    '<option value="">No project</option>' +
    state.projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`,
      )
      .join("");
}
function pickType(id, manual) {
  captureType = id;
  if (manual) captureAutoDetected = true;
  document
    .querySelectorAll(".type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.type === id));

  document.getElementById("voiceCaptureUI").style.display =
    id === "voice" ? "flex" : "none";
  document.getElementById("imageCaptureUI").style.display =
    id === "image" ? "block" : "none";
  document.getElementById("fileCaptureUI").style.display =
    id === "file" ? "block" : "none";
  document.getElementById("linkCaptureUI").style.display =
    id === "link" ? "block" : "none";
  document.getElementById("captureText").style.display = "block";
  if (id === "voice") {
    document.getElementById("captureText").placeholder = "Type or dictate a note…";
  } else if (id === "link") {
    document.getElementById("captureText").placeholder = "Optional note about this link…";
  } else {
    document.getElementById("captureText").placeholder = "What's on your mind?";
  }
  if (manual) updateCaptureDuplicate(id, captureInputValue());
}
function detectType(text) {
  const t = text.toLowerCase();
  if (
    /\b(tomorrow|today|at \d|am|pm|meeting|deadline|due|schedule)\b/.test(
      t,
    ) &&
    /\b(meeting|event|appointment|sync|demo)\b/.test(t)
  )
    return "event";
  if (
    /\b(todo|to-do|task|need to|have to|remind me|follow up|send|finish|complete|call|email)\b/.test(
      t,
    )
  )
    return "task";
  return "memory";
}
let extractDebounce = null;

function captureInputValue() {
  if (captureType === "link") return document.getElementById("linkUrlInput").value.trim();
  return document.getElementById("captureText").value.trim();
}

function toDateTimeLocalValue(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normaliseCaptureFingerprint(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\//g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function captureFingerprintFor(kind, title) {
  const normalized = normaliseCaptureFingerprint(title);
  return normalized ? `${kind || "text"}:${normalized}` : "";
}

const CAPTURE_GENERIC_TITLES = new Set(["file", "image", "voice note", "voice", "memory"]);

function findCaptureDuplicate(kind, title) {
  const storedKind = kind === "text" ? "memory" : kind;
  const fingerprint = captureFingerprintFor(storedKind, title);
  if (!fingerprint) return null;
  const normalizedTitle = normaliseCaptureFingerprint(title);
  if (CAPTURE_GENERIC_TITLES.has(normalizedTitle)) return null;
  const cutoff = Date.now() - 30 * 86400000;
  return state.items.find((item) => {
    if (!item || isArchived(item) || (item.created || 0) < cutoff) return false;
    if (item.scope && item.scope !== captureScope) return false;
    if (item.kind !== storedKind) return false;
    const itemFingerprint = item.captureFingerprint || captureFingerprintFor(item.kind, item.title);
    return itemFingerprint === fingerprint || normaliseCaptureFingerprint(item.title) === normalizedTitle;
  }) || null;
}

function updateCaptureDuplicate(kind, title) {
  const duplicate = findCaptureDuplicate(kind, title);
  captureDuplicate = duplicate;
  const warning = document.getElementById("captureDuplicateWarning");
  if (warning) warning.hidden = !duplicate;
  const message = document.getElementById("captureDuplicateText");
  if (message && duplicate) {
    const age = duplicate.created ? timeAgo(duplicate.created) : "recently";
    message.textContent = `“${duplicate.title}” was captured ${age}. Open it or save this as a separate item.`;
  }
  const saveButton = document.getElementById("captureSaveBtn");
  if (saveButton && !saveButton.disabled) saveButton.textContent = duplicate ? "Review duplicate" : "Save";
  return duplicate;
}

function clearCaptureDuplicate() {
  captureDuplicate = null;
  const warning = document.getElementById("captureDuplicateWarning");
  if (warning) warning.hidden = true;
  const message = document.getElementById("captureDuplicateText");
  if (message) message.textContent = "";
  const saveButton = document.getElementById("captureSaveBtn");
  if (saveButton) saveButton.textContent = "Save";
}

function openCaptureDuplicate() {
  if (!captureDuplicate) return;
  const id = captureDuplicate.id;
  closeCapture();
  openPanel(id);
}

function onCaptureSmartToggle() {
  captureSmartEnabled = Boolean(document.getElementById("captureSmartEnabled")?.checked);
  if (!captureSmartEnabled) {
    clearTimeout(extractDebounce);
    document.getElementById("captureHint").textContent = "Smart suggestions are off. You can still edit every field manually.";
    return;
  }
  if (captureInputValue()) onCaptureInput();
  else document.getElementById("captureHint").textContent = "";
}

function clearCaptureSuggestions() {
  const entries = Object.entries(captureSuggestionFields);
  entries.forEach(([field, record]) => {
    if (!record) return;
    const element = document.getElementById(record.elementId);
    if (element && element.value === record.applied) element.value = record.previous || "";
  });
  if (captureSuggestionFields.kind && captureType === captureSuggestionFields.kind.appliedKind) {
    pickType(captureSuggestionFields.kind.previous || "text", false);
    captureAutoDetected = false;
  }
  captureExtraction = null;
  captureSuggestionFields = {};
  const clearButton = document.getElementById("clearCaptureSuggestionsBtn");
  if (clearButton) clearButton.disabled = true;
  dismissCaptureQuestion();
  document.getElementById("captureHint").textContent = "Suggestions cleared. Edit the fields or type again.";
}

function onLinkInput() {
  const value = document.getElementById("linkUrlInput").value.trim();
  const hint = document.getElementById("captureHint");
  if (!value) {
    if (hint) hint.textContent = "";
    clearCaptureDuplicate();
    return;
  }
  try {
    const url = new URL(value.match(/^https?:\/\//i) ? value : `https://${value}`);
    if (hint) hint.innerHTML = `${icon("link")} Link ready: ${escapeHtml(url.hostname)}`;
  } catch (error) {
    if (hint) hint.textContent = "Enter a valid URL, for example https://example.com.";
  }
  updateCaptureDuplicate("link", value);
}

function onCaptureInput() {
  const text = document.getElementById("captureText").value;
  captureExtraction = null;
  updateCaptureDuplicate(captureType, text);
  if (!captureSmartEnabled) return;
  document.getElementById("captureHint").textContent = "";
  if (!text.trim()) {
    captureAutoDetected = false;
    return;
  }

  if (!captureAutoDetected && captureType !== "voice" && captureType !== "image" && captureType !== "file" && captureType !== "link") {
    const guessed = detectType(text);
    if (guessed !== captureType) pickType(guessed, false);
  }

  clearTimeout(extractDebounce);
  document.getElementById("captureHint").innerHTML =
    icon("sparkles") + " Reading…";
  extractDebounce = setTimeout(() => extractWithAI(text), 700);
}

/* Smart capture, in two beats.

   First the local rules run: instant, free, offline, and good enough for a plain
   "call Ravi tomorrow". Their result is applied immediately so the sheet never feels slow.

   The model is then asked for a second opinion, but only when the rules are not confident —
   a vague time, a promise, a multi-clause sentence, or a half-read. A failure there is silent:
   the local result stands, which is why this can never block saving. */
async function extractWithAI(text) {
  const local = extractLocally(text);
  if (document.getElementById("captureText").value !== text) return;
  applyExtraction(local, text);

  if (!captureSmartEnabled) return;
  if (!captureNeedsModelHelp(text, local)) return;

  setCaptureHint(icon("sparkles") + " Reading more carefully…");
  const ai = await requestModelExtraction(text);
  // The person kept typing while the request was in flight; the answer is now stale.
  if (document.getElementById("captureText").value !== text) return;
  if (ai) applyExtraction(mergeExtractions(local, ai), text);
}

/* Progress line under the smart-suggestions toggle. Extracted so the reading steps can never
   overwrite each other out of order. */
function setCaptureHint(html) {
  const hint = document.getElementById("captureHint");
  if (hint) hint.innerHTML = html || "";
}
function applyExtraction(data, text) {
  data = data && typeof data === "object" ? data : {};
  const previousKind = captureType;
  if (
    data.kind &&
    !captureAutoDetected &&
    !["voice", "image", "file", "link"].includes(captureType) &&
    data.kind !== captureType
  ) {
    captureSuggestionFields.kind = { appliedKind: data.kind, previous: previousKind };
    pickType(data.kind, false);
  }

  const applyField = (id, value) => {
    if (value === undefined || value === null || value === "") return;
    const element = document.getElementById(id);
    if (!element || element.value) return;
    const previous = element.value;
    element.value = value;
    captureSuggestionFields[id] = { elementId: id, previous, applied: value };
  };

  applyField("capturePriority", data.priority);
  applyField("captureDueDate", toDateTimeLocalValue(data.dueDate));
  applyField("capturePerson", data.person);
  applyField("captureRecurrence", data.recurrence !== "none" ? data.recurrence : "");
  if (data.project && !document.getElementById("captureProject").value) {
    const projectSelect = document.getElementById("captureProject");
    const match = [...projectSelect.options].find((option) => option.value === data.project);
    if (match) {
      const previous = projectSelect.value;
      projectSelect.value = data.project;
      captureSuggestionFields.captureProject = { elementId: "captureProject", previous, applied: data.project };
    }
  }

  captureExtraction = {
    ...data,
    source: "smart-capture",
    appliedKind: previousKind,
  };
  const parts = [];
  if (data.kind) parts.push(data.kind);
  if (data.dueDate) parts.push("due " + formatDueDisplay(data.dueDate));
  if (data.person) parts.push("person: " + data.person);
  if (data.priority) parts.push(data.priority + " priority");
  if (data.recurrence && data.recurrence !== "none") parts.push(data.recurrence);
  const clearButton = document.getElementById("clearCaptureSuggestionsBtn");
  if (clearButton) clearButton.disabled = parts.length === 0;
  // Say when the model was involved, so a better reading is visibly better rather than magic.
  const byline = data.aiUsed ? " (read by AI)" : "";
  setCaptureHint(
    parts.length
      ? `${icon("sparkles")} Suggestions${byline}: ${escapeHtml(parts.join(", "))} — edit any field to override.`
      : "",
  );
  renderCaptureQuestions(text, data);
  const currentText = captureInputValue();
  if (currentText) updateCaptureDuplicate(captureType, currentText);
}

/* ---------- Missing-value questions ----------
   The product rule from the spec: the assistant must not invent what an uncertain phrase means.
   "Maybe Friday" is not a date, so instead of silently guessing it, the sheet asks.

   Deliberately restrained. It asks at most one question at a time, only for the two cases that
   genuinely change what gets saved (an unreliable date, a promise that needs following up), and
   it never blocks saving — every question can be ignored. "Suggestions, not pressure." */
function renderCaptureQuestions(text, data) {
  const card = document.getElementById("captureQuestion");
  if (!card) return;
  const questions = buildCaptureQuestions(text, data || {});
  if (!questions.length) {
    card.hidden = true;
    card.innerHTML = "";
    captureQuestions = [];
    return;
  }
  captureQuestions = questions;
  renderCaptureQuestion();
}

function buildCaptureQuestions(text, data) {
  const body = String(text || "");
  const questions = [];

  // A promise the person made. Worth one tap: a reminder for it is the difference between
  // keeping a commitment and quietly missing it.
  if (COMMITMENT_RE.test(body)) {
    questions.push({
      id: "commitment",
      question: "This sounds like something you promised. Shall I keep it as a task?",
      options: [
        { label: "Yes, make it a task", value: "task" },
        { label: "Save as a note", value: "note" },
      ],
    });
  }

  // A time the wording does not actually pin down.
  const vague = body.match(VAGUE_TIME_RE);
  if (vague && (data.dueDate || /\b(friday|monday|tuesday|wednesday|thursday|saturday|sunday|week|month)\b/i.test(body))) {
    questions.push({
      id: "vague-date",
      question: data.dueDate
        ? `I read "${escapeHtml(vague[0])}" as ${escapeHtml(formatDueDisplay(data.dueDate))}. Keep that, or pick another day?`
        : `"${escapeHtml(vague[0])}" is not a specific day. Add one?`,
      options: data.dueDate
        ? [
            { label: "Keep it", value: "keep" },
            { label: "Pick another day", value: "pick" },
            { label: "No date", value: "clear" },
          ]
        : [
            { label: "Pick a day", value: "pick" },
            { label: "No date", value: "clear" },
          ],
    });
  }

  return questions;
}

/* Shows one question at a time so the sheet never turns into a form to fill in. */
function renderCaptureQuestion() {
  const card = document.getElementById("captureQuestion");
  if (!card) return;
  const question = captureQuestions[0];
  if (!question) {
    card.hidden = true;
    card.innerHTML = "";
    return;
  }
  card.hidden = false;
  card.innerHTML = `
    <p class="capture-question-text">${question.question}</p>
    <div class="capture-question-actions">
      ${question.options
        .map(
          (option) =>
            `<button type="button" class="btn" onclick="answerCaptureQuestion('${escapeHtml(option.value)}')">${escapeHtml(option.label)}</button>`,
        )
        .join("")}
      <button type="button" class="capture-question-skip" onclick="dismissCaptureQuestion()">Dismiss</button>
    </div>`;
}

function dismissCaptureQuestion() {
  captureQuestions = [];
  const card = document.getElementById("captureQuestion");
  if (card) {
    card.hidden = true;
    card.innerHTML = "";
  }
}

/* Applies an answer. A choice the person makes is no longer a suggestion, so it is recorded as
   an empty entry in captureSuggestionFields — "Clear suggestions" must not undo a decision. */
function answerCaptureQuestion(value) {
  const question = captureQuestions[0];
  if (!question) return;

  if (question.id === "commitment") {
    if (value === "task") {
      // Never override a type the person chose themselves.
      if (!captureAutoDetected && !["voice", "image", "file", "link"].includes(captureType)) {
        captureSuggestionFields.kind = { appliedKind: "task", previous: captureType };
        pickType("task", false);
      }
    }
  }

  if (question.id === "vague-date") {
    const field = document.getElementById("captureDueDate");
    if (value === "clear") {
      if (field) field.value = "";
      captureSuggestionFields.captureDueDate = null;
    } else if (value === "pick") {
      field?.focus();
      field?.showPicker?.();
    } else {
      // "Keep it" — protect the existing suggestion from being cleared.
      if (field?.value) captureSuggestionFields.captureDueDate = null;
    }
  }

  captureQuestions.shift();
  renderCaptureQuestion();
  const currentText = captureInputValue();
  if (currentText) updateCaptureDuplicate(captureType, currentText);
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const DAY_WORD_RE =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;

/* Compact fallback date parser for notes like "tomorrow at 5pm", "in 2 hours" or
   "friday 14:30". Only used when chrono-node isn't available (offline / CDN blocked). */
function parseLocalDate(text, now) {
  const ref = now ? new Date(now) : new Date();
  const t = " " + text.toLowerCase() + " ";

  const relative = t.match(/\bin\s+(\d+)\s*(min|minute|hour|hr|day|week)s?\b/);
  if (relative) {
    const n = parseInt(relative[1], 10);
    const d = new Date(ref);
    if (relative[2].startsWith("min")) d.setMinutes(d.getMinutes() + n);
    else if (relative[2] === "day") d.setDate(d.getDate() + n);
    else if (relative[2] === "week") d.setDate(d.getDate() + n * 7);
    else d.setHours(d.getHours() + n);
    return d;
  }

  const timeMatch =
    t.match(/\b(?:at\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)\b/) ||
    t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ||
    t.match(/\bat\s+(\d{1,2})[:.](\d{2})\b/) ||
    t.match(/\b(\d{1,2}):(\d{2})\b/);

  const d = new Date(ref);

  if (/\btomorrow\b/.test(t)) {
    d.setDate(d.getDate() + 1);
  } else if (DAY_WORD_RE.test(t)) {
    const target = DAY_NAMES.indexOf(t.match(DAY_WORD_RE)[1]);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "friday" said on a Friday means the coming one
    d.setDate(d.getDate() + delta);
  } else if (
    !/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(t)
  ) {
    return null;
  }

  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    if (timeMatch[3] === "pm" && h < 12) h += 12;
    if (timeMatch[3] === "am" && h === 12) h = 0;
    d.setHours(h, timeMatch[2] ? parseInt(timeMatch[2], 10) : 0, 0, 0);
  } else if (/\btonight\b/.test(t)) d.setHours(21, 0, 0, 0);
  else if (/\bevening\b/.test(t)) d.setHours(19, 0, 0, 0);
  else if (/\bafternoon\b/.test(t)) d.setHours(14, 0, 0, 0);
  else d.setHours(9, 0, 0, 0);

  // No explicit time given and the guess is already behind us — park it an hour out.
  if (!timeMatch && d.getTime() <= ref.getTime()) {
    d.setTime(ref.getTime() + 3600000);
    d.setMinutes(0, 0, 0);
  }

  return d;
}

/* Words that make a time unreliable rather than known. The product rule is that the assistant
   must not invent what a vague phrase means — it asks instead. "Maybe Friday" is not a date. */
const VAGUE_TIME_RE =
  /\b(maybe|perhaps|probably|some\s?time|soon|later|next week|this week|one day|eventually|whenever|any day|or so|ish|approximately|around)\b/i;

/* A promise the person made. The spec calls these out as one of the most useful things the app
   can notice, because an unfulfilled promise is easy to forget. */
const COMMITMENT_RE =
  /\b(i'?ll|i will|i promise|i said i'?d|we'?ll|we will|remind me to|don'?t forget to|i need to remember to)\b/i;

/* Splits a sentence into clauses. More than one clause usually means more than one thing — a
   task plus a promise, a date plus a follow-up — and the single-value local rules can only
   ever report the first match. That is the main reason to call the model. */
function splitCaptureClauses(text) {
  return String(text || "")
    .split(/[.;!?\n]+|\b(?:and then|also|plus|then)\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 2);
}

function extractLocally(text) {
  const result = {
    kind: "",
    priority: "",
    dueDate: "",
    person: "",
    project: "",
    recurrence: "none",
    // How much the rules actually know. Anything below "high" is a signal to ask the model.
    confidence: "low",
    ambiguous: "",
  };

  // Date/time via chrono-node (loaded from a CDN in index.html)
  if (window.chrono) {
    try {
      const parsed = window.chrono.parseDate(text, new Date());
      if (parsed) result.dueDate = parsed.toISOString();
    } catch (e) {
      /* fall through to the built-in parser below */
    }
  }

  // Built-in fallback so dates still work offline or if the CDN is blocked
  if (!result.dueDate) {
    const local = parseLocalDate(text);
    if (local) result.dueDate = local.toISOString();
  }

  // Never suggest a due date that has already passed (e.g. "yesterday")
  if (result.dueDate && new Date(result.dueDate).getTime() < Date.now() - 60000)
    result.dueDate = "";

  // Person: "call/meet/with/for <Capitalized Name>"
  const personMatch = text.match(
    /\b(?:call|meet|with|for|from)\s+([A-Z][a-z]+)\b/,
  );
  if (personMatch) result.person = personMatch[1];

  // Priority from urgency words
  if (/\b(urgent|asap|critical|important)\b/i.test(text))
    result.priority = "high";
  else if (/\b(sometime|eventually|whenever|low priority)\b/i.test(text))
    result.priority = "medium";

  // Recurrence
  if (/\bevery day|daily\b/i.test(text)) result.recurrence = "daily";
  else if (/\bevery week|weekly\b/i.test(text)) result.recurrence = "weekly";
  else if (/\bevery month|monthly\b/i.test(text)) result.recurrence = "monthly";

  // Project — match against known project names
  const proj = state.projects.find((p) =>
    text.toLowerCase().includes(p.name.toLowerCase()),
  );
  if (proj) result.project = proj.name;

  // Kind
  result.kind = detectType(text);
  if (/\bwaiting (on|for)\b/i.test(text)) result.kind = "waiting";
  else if (/\b(need to decide|undecided|not sure yet)\b/i.test(text))
    result.kind = "openloop";
  // A stated preference or fact about someone is knowledge, not work: "Ravi prefers WhatsApp".
  // Without this the "email"/"call" verbs below read it as a task, which is the one kind error a
  // memory engine must never make.
  else if (/\b(prefers?|likes?|dislikes|hates?|uses|is a|works (at|with)|lives? in|knows?)\b/i.test(text))
    result.kind = "memory";

  // How much do the rules actually know? A vague phrase is a reason to ask, not to guess.
  if (VAGUE_TIME_RE.test(text)) {
    result.confidence = "low";
  } else if (result.dueDate && result.kind) {
    result.confidence = "high";
  } else if (result.dueDate || result.kind) {
    result.confidence = "medium";
  }

  return result;
}

/* Decides whether the local rules are enough. They are for a plain "call Ravi tomorrow"; they
   are not for a sentence carrying a promise and a date, for a vague time, or for anything they
   only half-read. Calling the model costs a request, so it is reserved for those cases. */
function captureNeedsModelHelp(text, local) {
  if (VAGUE_TIME_RE.test(text)) return true;
  if (COMMITMENT_RE.test(text)) return true;
  if (local?.confidence !== "high") return true;
  return splitCaptureClauses(text).length > 1;
}

/* Asks the configured model for a structured read of the sentence. Returns null on any failure
   or when no provider is configured — the local result is already applied, so a failure here
   costs the refinement and nothing else. */
async function requestModelExtraction(text) {
  if (isFileProtocol()) return null;
  try {
    const res = await apiFetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "extract",
        text: String(text).slice(0, 2000),
        today: new Date().toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.extraction || null;
  } catch (error) {
    return null;
  }
}

/* Folds the model's reading into the local one. The model only wins on fields it actually
   filled and only when the rules were unsure; a confident local read is never overwritten,
   and a value the model left empty never erases one the rules found. */
function mergeExtractions(local, ai) {
  const merged = { ...local };
  const preferModel = local.confidence !== "high";
  for (const field of [
    "kind",
    "dueDate",
    "person",
    "project",
    "priority",
    "recurrence",
    "ambiguous",
  ]) {
    const value = ai?.[field];
    if (value === undefined || value === null || value === "") continue;
    if (preferModel || !merged[field]) merged[field] = value;
  }
  merged.confidence = ai?.confidence || local.confidence;
  // A clear title from the model is the single biggest readability win, so use it when present.
  if (ai?.title && (preferModel || !merged.title)) merged.title = ai.title;
  merged.aiUsed = true;
  return merged;
}
function closeCapture() {
  stopVoiceDictation();
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  document.getElementById("captureModal").classList.remove("open");
  lockPageScroll(false);
}
async function saveCapture(forceSave = false) {
  if (captureSaveInFlight) return false;
  const kind = captureType;
  const isMediaType = ["voice", "image", "file"].includes(kind);
  const isLink = kind === "link";
  const text = isLink
    ? document.getElementById("linkUrlInput").value.trim()
    : document.getElementById("captureText").value.trim();

  if (kind === "voice" && !pendingBlob && !text) {
    setVoiceDictationStatus("Record audio or dictate a note before saving.");
    return false;
  }
  if (["image", "file"].includes(kind) && !pendingBlob) {
    setVoiceDictationStatus("Choose a file before saving.");
    return false;
  }
  if (!isMediaType && !text) return false;

  if (isLink) {
    try {
      const url = new URL(text.match(/^https?:\/\//i) ? text : `https://${text}`);
      if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported protocol");
    } catch (error) {
      const hint = document.getElementById("captureHint");
      if (hint) hint.textContent = "Enter a valid http or https link before saving.";
      document.getElementById("linkUrlInput")?.focus();
      return false;
    }
  }

  const realKind = kind === "text" ? "memory" : kind;
  const candidateTitle = isMediaType
    ? kind === "voice"
      ? text || "Voice note"
      : kind === "image"
        ? text || pendingBlob?.name || "Image"
        : pendingBlob?.name || "File"
    : isLink
      ? text
      : text;
  if (!forceSave && updateCaptureDuplicate(realKind, candidateTitle)) {
    document.getElementById("captureDuplicateWarning")?.scrollIntoView({ block: "nearest" });
    return false;
  }

  captureSaveInFlight = true;
  const saveButton = document.getElementById("captureSaveBtn");
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
  }
  try {
    let mediaUrl = null;
    if (isMediaType && pendingBlob) mediaUrl = await uploadPendingBlob();

    const project = document.getElementById("captureProject").value;
    const dueVal = document.getElementById("captureDueDate").value;
    const dueISO = dueVal ? new Date(dueVal).toISOString() : "";
    const recurrence = document.getElementById("captureRecurrence").value;
    const priority =
      document.getElementById("capturePriority").value ||
      (kind === "task" ? "medium" : "");
    const person = document.getElementById("capturePerson").value.trim();
    const captionText = document.getElementById("captureText").value.trim();
    const sourceType = isLink ? "link" : isMediaType ? kind : "manual";
    const title = candidateTitle;
    const sub = isMediaType
      ? kind === "voice"
        ? captionText ? "Voice note" : "Voice"
        : kind === "image"
          ? captionText ? "Image" : ""
          : "File"
      : isLink
        ? captionText || "Link"
        : kind === "task"
          ? "Captured task"
          : kind === "event"
            ? "Captured event"
            : kind === "waiting"
              ? "Waiting for"
              : kind === "openloop"
                ? "Open loop"
                : "Memory";
    const captureMetadata = {
      ...(captureExtraction || {}),
      smartEnabled: captureSmartEnabled,
      source: captureExtraction?.source || "manual",
      transcript: kind === "voice" && captureVoiceFinal ? captureVoiceFinal : undefined,
      // Which language was actually dictated, so a transcript can be read back correctly later.
      language: kind === "voice" && captureVoiceLanguage ? captureVoiceLanguage : undefined,
      // Text read out of a picture, kept so the original recognition is auditable.
      ocrText: kind === "image" && imageOcrText ? imageOcrText : undefined,
      ocrLanguage: kind === "image" && imageOcrText ? captureOcrLang : undefined,
      mediaName: pendingBlob?.name || undefined,
    };
    Object.keys(captureMetadata).forEach((key) => captureMetadata[key] === undefined && delete captureMetadata[key]);
    const newItem = {
      id: cid(),
      ownerId: sbUser || currentUserId || null,
      kind: realKind,
      title,
      sub,
      priority,
      person,
      due: dueISO ? formatDueDisplay(dueISO) : kind === "task" ? "Today" : "",
      dueDate: dueISO,
      recurrence,
      status: kind === "task" ? "today" : "inbox",
      project,
      created: Date.now(),
      done: false,
      scope: captureScope,
      mediaUrl: mediaUrl || "",
      sourceType,
      rawText: text || title,
      captureMetadata,
      captureFingerprint: CAPTURE_GENERIC_TITLES.has(normaliseCaptureFingerprint(title)) ? null : captureFingerprintFor(realKind, title),
    };

    state.items.unshift(newItem);
    closeCapture();
    await dbSaveItem(newItem);
    return true;
  } catch (error) {
    console.error("Capture save failed:", error);
    const hint = document.getElementById("captureHint");
    if (hint) hint.textContent = "Could not save this capture. Please try again.";
    return false;
  } finally {
    captureSaveInFlight = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  }
}
async function quickCapture() {
  const input = document.getElementById("quickRemember");
  const text = input.value.trim();
  if (!text) return;
  const newItem = {
    id: cid(),
    kind: "memory",
    title: text,
    sub: "Memory",
    priority: "",
    person: "",
    due: "",
    status: "inbox",
    project: "",
    created: Date.now(),
    done: false,
    scope: "shared",
  };
  state.items.unshift(newItem);
  input.value = "";
  await dbSaveItem(newItem);
}
async function startNudge() {
  const newItem = {
    id: cid(),
    kind: "task",
    title: "Work on business idea",
    sub: "20-minute focus block",
    priority: "medium",
    person: "",
    due: "Today",
    status: "today",
    project: "",
    created: Date.now(),
    done: false,
  };
  state.items.unshift(newItem);
  await dbSaveItem(newItem);
  switchView("tasks");
}

function dismissNudge() {
  const today = new Date().toISOString().slice(0, 10);
  localStorage.setItem("everything_nudge_dismissed", today);
  const card = document.getElementById("nudgeCard");
  if (card) card.style.display = "none";
}

function restoreNudge() {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem("everything_nudge_dismissed") !== today) return;
  const card = document.getElementById("nudgeCard");
  if (card) card.style.display = "none";
}

let draggedDashboardSection = null;
let dashboardHoldTimer = null;
let dashboardPointerDragging = false;

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
  document.querySelectorAll("[data-dashboard-section]").forEach((section) => {
    section.addEventListener("dragstart", (event) => {
      draggedDashboardSection = section;
      section.classList.add("dashboard-dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    section.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!draggedDashboardSection || draggedDashboardSection === section) return;
      const before = event.clientY < section.getBoundingClientRect().top + section.offsetHeight / 2;
      section.parentElement.insertBefore(
        draggedDashboardSection,
        before ? section : section.nextElementSibling,
      );
    });
    section.addEventListener("dragend", () => {
      section.classList.remove("dashboard-dragging");
      draggedDashboardSection = null;
      saveDashboardLayout();
    });

    section.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, input, a")) return;
      dashboardHoldTimer = setTimeout(() => {
        dashboardPointerDragging = true;
        draggedDashboardSection = section;
        section.classList.add("dashboard-dragging");
      }, 350);
    });
    section.addEventListener("pointermove", (event) => {
      if (!dashboardPointerDragging || draggedDashboardSection !== section) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(
        "[data-dashboard-section]",
      );
      if (!target || target === section) return;
      const before = event.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
      target.parentElement.insertBefore(
        section,
        before ? target : target.nextElementSibling,
      );
    });
    section.addEventListener("pointerup", () => {
      clearTimeout(dashboardHoldTimer);
      if (!dashboardPointerDragging) return;
      section.classList.remove("dashboard-dragging");
      dashboardPointerDragging = false;
      draggedDashboardSection = null;
      saveDashboardLayout();
    });
    section.addEventListener("pointercancel", () => {
      clearTimeout(dashboardHoldTimer);
      dashboardPointerDragging = false;
      draggedDashboardSection = null;
      section.classList.remove("dashboard-dragging");
    });
  });
}

/* ---------- Ask / Search ---------- */
/* Two entry points share one search engine:
     - the header input, which streams results into a dropdown (what tapping search does now)
     - the full-screen overlay, still reachable via Ctrl+K / "/" for keyboard users
   Both render from the same helpers so results and the AI answer never drift apart. */

/* Words that carry no retrieval signal. Without this filter a question like "what should I do
   today" is searched as one long phrase that appears in no title, so the search silently
   returns nothing. Dropping them leaves the meaningful terms. */
const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do",
  "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "should", "show", "some", "tell", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

/* Splits a query into meaningful lowercase terms. Falls back to the whole trimmed string when
   the query is nothing but stop words ("the?", "what?"), so a match is still possible. */
function searchTerms(q) {
  const words = String(q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((word) => word.length > 1 && !SEARCH_STOP_WORDS.has(word));
  return meaningful.length ? meaningful : words;
}

/* Every field worth searching, in descending order of importance. The old haystack was only
   title + sub + person, so a query like "urgent Atlas project" matched nothing even when the
   item was a high-priority task on that project. */
function searchHaystack(item) {
  const status = item?.kind === "task" ? taskStatusFromItem(item) : item?.status || "";
  const steps = normaliseChecklist(item?.checklist).map((step) => step.text).join(" ");
  return [
    item?.title,
    item?.sub,
    item?.person,
    item?.project,
    taskStatusLabel(status),
    item?.priority,
    item?.kind,
    item?.recurrence && item.recurrence !== "none" ? item.recurrence : "",
    steps,
    item?.rawText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* Natural words a person actually types, mapped to the values this app stores. Without this,
   "urgent" finds nothing because priority is saved as "high", and "blocked" finds nothing
   because the status is "waiting". A term matches itself or any of its aliases. */
const SEARCH_ALIASES = {
  urgent: ["high", "asap", "important", "critical"],
  important: ["high", "urgent"],
  critical: ["high", "urgent"],
  high: ["urgent", "important", "critical"],
  blocked: ["waiting"],
  waiting: ["blocked"],
  todo: ["planned"],
  doing: ["in_progress", "progress"],
  progress: ["in_progress", "doing"],
  done: ["completed"],
  completed: ["done"],
  note: ["memory"],
  memo: ["memory"],
  meeting: ["event"],
  call: ["phone"],
  phone: ["call"],
};

function searchAliases(term) {
  return SEARCH_ALIASES[term] || [];
}

/* Scores one item against the query terms. Every term must appear somewhere (AND), which keeps
   precision high; a whole-phrase hit and a title hit are worth extra so the obvious match sorts
   first. Returns 0 for no match, which is what the filter below relies on. */
function searchScore(item, terms, phrase) {
  const haystack = searchHaystack(item);
  if (!haystack) return 0;
  const title = String(item?.title || "").toLowerCase();

  let score = 0;
  for (const term of terms) {
    const hit = haystack.includes(term);
    const alias = !hit && searchAliases(term).some((alt) => haystack.includes(alt));
    if (!hit && !alias) return 0;
    score += 1;
    if (title.includes(term)) score += 3;
  }
  // The full phrase appearing intact is the strongest possible signal.
  if (phrase && haystack.includes(phrase)) score += 4;
  // A due date makes time-based questions ("what's due today") answerable from the ranking.
  if (item?.dueDate || item?.due_date) score += 1;
  return score;
}

/* The one search engine behind both the header dropdown and the Ask overlay. Returns the
   best-matching items, most relevant first, so the AI is given the items that actually answer
   the question instead of the first N in insertion order. */
function searchMatches(q) {
  const phrase = String(q || "").toLowerCase().trim();
  if (!phrase) return [];
  const terms = searchTerms(phrase);
  return state.items
    .filter((item) => !isArchived(item))
    .map((item) => ({ item, score: searchScore(item, terms, phrase) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.created || 0) - (a.item.created || 0))
    .map((entry) => entry.item);
}

/* Builds the context sent to the model. The ranked matches lead, because those are what answer
   the question. A broad question ("what should I do now") may only match one item, so recent
   open work is then appended up to a floor: the model needs enough to actually answer, and an
   earlier version sent an arbitrary slice of the list instead. Bounded for the token cap. */
const ASK_CONTEXT_MATCHES = 12;
const ASK_CONTEXT_MINIMUM = 8;
function askContextPool(q) {
  const ranked = searchMatches(q).slice(0, ASK_CONTEXT_MATCHES);
  if (ranked.length >= ASK_CONTEXT_MINIMUM) return ranked;

  const chosen = new Set(ranked.map((item) => item.id));
  const recent = [...state.items]
    .filter((item) => !isArchived(item) && !chosen.has(item.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  const filler = recent.slice(0, ASK_CONTEXT_MINIMUM - ranked.length);
  return [...ranked, ...filler];
}

let searchDropDebounce = null;
let searchDropQuery = "";

function openSearch() {
  const dd = document.getElementById("searchDropdown");
  if (!dd) return;
  dd.hidden = false;
  document.getElementById("searchInput")?.setAttribute("aria-expanded", "true");
  if (!dd.dataset.touched) {
    dd.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
  }
}

function closeSearch() {
  const dd = document.getElementById("searchDropdown");
  const input = document.getElementById("searchInput");
  if (!dd) return;
  dd.hidden = true;
  delete dd.dataset.touched;
  input?.setAttribute("aria-expanded", "false");
}

/* Enter opens the full overlay pre-filled, so a typed question can be expanded and reviewed.
   Escape leaves the field, matching normal combobox behaviour. */
function searchKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const q = document.getElementById("searchInput").value.trim();
    closeSearch();
    document.getElementById("searchInput").blur();
    openAsk(q);
  } else if (e.key === "Escape") {
    closeSearch();
    document.getElementById("searchInput").blur();
  }
}

function runSearch(q) {
  searchDropQuery = q;
  const dd = document.getElementById("searchDropdown");
  if (!dd) return;
  dd.dataset.touched = "1";

  if (!q.trim()) {
    dd.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
    return;
  }

  const matches = searchMatches(q);
  // The AI answer lives in its own slot so re-rendering the hit list never disturbs it.
  //
  // That slot must be REUSED, not recreated. Replacing the dropdown's innerHTML on every
  // keystroke would detach the node askAI captured, and its answer would be discarded — leaving
  // the dropdown stuck on "Thinking…" forever. The existing answer is also carried over so a
  // half-typed word does not blank a finished answer.
  const previousAnswer = document.getElementById("searchAskSlot")?.innerHTML || "";
  dd.innerHTML =
    (matches.length
      ? matches
          .slice(0, 8)
          .map(
            (m) =>
              `<div class="search-hit" onclick="closeSearch();document.getElementById('searchInput').value='';openPanel('${m.id}')"><b>${escapeHtml(m.title)}</b><br><span class="search-hit-sub">${escapeHtml(m.sub || "")}</span></div>`,
          )
          .join("")
      : '<p class="empty">No matches found.</p>') +
    `<div class="search-ask" id="searchAskSlot">${previousAnswer}</div>`;

  // Ask is a debounced AI call, so it must not run on every keystroke here.
  clearTimeout(searchDropDebounce);
  searchDropDebounce = setTimeout(() => {
    if (searchDropQuery === q) {
      askAI(q, { mount: document.getElementById("searchAskSlot"), extra: "search-ask" });
    }
  }, 650);
}

function openAsk(prefill = "") {
  if (document.getElementById("sidebar")?.classList.contains("open"))
    closeSidebar();
  document.getElementById("askOverlay").classList.add("open");
  lockPageScroll(true);
  document.getElementById("askInput").value = prefill;
  document.getElementById("askResults").innerHTML =
    '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
  setTimeout(() => document.getElementById("askInput").focus(), 50);
  if (prefill) runAsk(prefill);
}
function closeAsk() {
  document.getElementById("askOverlay").classList.remove("open");
  if (!document.querySelector(".modal-overlay.open, #panel.open"))
    lockPageScroll(false);
}
let askDebounce = null;
let lastAskQuery = "";
function runAsk(q) {
  lastAskQuery = q;
  const results = document.getElementById("askResults");
  if (!q.trim()) {
    results.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
    return;
  }
  const matches = searchMatches(q);
  let html = `<div id="aiAnswerSlot"></div>`;
  html += matches.length
    ? matches
        .map(
          (m) =>
            `<div class="ask-result-item" onclick="closeAsk();openPanel('${m.id}')"><b>${escapeHtml(m.title)}</b><br><span style="color:var(--muted)">${escapeHtml(m.sub || "")}</span></div>`,
        )
        .join("")
    : '<p class="empty">No matches found.</p>';
  results.innerHTML = html;

  clearTimeout(askDebounce);
  askDebounce = setTimeout(() => {
    if (lastAskQuery === q) askAI(q);
  }, 550);
}

/* One context shape for both AI paths (the /api/ask route and the in-artifact `sample` path).

   The raw item objects were sent as-is, and buildContextLine() on the server only reads
   kind/priority/title/sub/person/due — so `status`, `project`, `recurrence` and checklist
   progress never reached the model, and it could not answer questions about workflow state.
   Normalising here keeps the two paths from drifting apart. */
function askContextPayload(items) {
  return items.map((item) => {
    const status = item.kind === "task" ? taskStatusFromItem(item) : item.status || "";
    const steps = checklistProgress(item);
    return {
      kind: item.kind || "item",
      title: item.title || "",
      sub: item.sub || "",
      person: item.person || "",
      project: item.project || "",
      status: taskStatusLabel(status),
      priority: item.priority || "",
      recurrence: item.recurrence && item.recurrence !== "none" ? item.recurrence : "",
      due: item.due || (item.dueDate ? formatDueDisplay(item.dueDate) : ""),
      dueDate: item.dueDate || item.due_date || "",
      done: Boolean(item.done),
      checklist: steps.total ? `${steps.completed}/${steps.total} done` : "",
    };
  });
}

/* The single prompt used by both AI paths, so the in-artifact `sample` call and the /api/ask
   route instruct the model identically. Each context line carries the fields the model actually
   reasons over (state, project, due), and the current date makes relative questions answerable. */
function buildAskPrompt(q, items, today) {
  const context = items
    .map((item) => {
      const label = [item.kind, item.status, item.priority].filter(Boolean).join("/");
      const bits = [item.title, item.sub].filter(Boolean).join(": ");
      const meta = [
        item.project ? `project: ${item.project}` : "",
        item.person ? `person: ${item.person}` : "",
        item.due ? `due: ${item.due}` : "",
        item.recurrence ? `repeats: ${item.recurrence}` : "",
        item.checklist ? `checklist: ${item.checklist}` : "",
        item.done ? "completed" : "",
      ].filter(Boolean);
      return `- [${label}] ${bits}${meta.length ? ` (${meta.join(", ")})` : ""}`;
    })
    .join("\n");
  return `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Today is ${today}. Be concise (2-4 sentences), specific, and reference relevant items by name. Use the status and due fields to judge what is current, overdue or still open. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context || "(none)"}\n\nQuestion: ${q}`;
}

/* Renders the AI answer for `q`. `opts.mount` is the element results are drawn into: the overlay's
   slot by default, or the header dropdown when the inline search box is the entry point. */
/* Guards against a slow response overwriting a newer one. Typing "gym" then "gym membership"
   fires two Ask calls; without this the slower first reply can land last and show an answer to a
   query the user has already moved on from. Each call takes a ticket and only the newest wins. */
let askRequestSeq = 0;

async function askAI(q, opts = {}) {
  const ticket = ++askRequestSeq;
  const extra = opts.extra || "";
  const mountId = opts.mount ? opts.mount.id : "aiAnswerSlot";

  /* Resolves the slot live rather than holding on to one node.
     The header dropdown rebuilds its own markup on every keystroke, so a node captured at the
     start of the call is detached by the time the answer arrives; writing to it would either do
     nothing or, worse, be dropped by a naive "is it still connected?" check — which is what left
     the dropdown stuck on "Thinking…". Looking the element up again by id always finds the node
     the user is actually looking at. */
  const slot = () => (mountId ? document.getElementById(mountId) : null);
  const first = slot();
  if (!first) return;
  first.innerHTML = `<div class="ask-answer">Thinking…</div>`;

  // Only a *newer* call supersedes this one. A re-rendered dropdown is not a newer question, so
  // it must not throw away an answer the user is waiting for.
  const isSuperseded = () => ticket !== askRequestSeq;
  const show = (html) => {
    if (isSuperseded()) return;
    const target = slot();
    if (target) target.innerHTML = html;
  };

  const contextItems = searchMatches(q);
  const contextPool = askContextPool(q);
  // The model is given today's date so relative questions ("today", "this week", "overdue")
  // are answerable instead of guessed.
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Results already listed by the caller should not be repeated above the AI answer.
  const buildSourcesHtml = () =>
    contextPool.length
      ? `
    <div class="ask-sources">
      <div class="ask-sources-label">SOURCES</div>
      ${contextPool
        .slice(0, 5)
        .map(
          (i) => `<div class="ask-source" onclick="${extra === "search-ask" ? "closeSearch()" : "closeAsk()"};openPanel('${i.id}')">
        <span>${kindIcon(i.kind)}</span><span class="ask-source-title">${escapeHtml(i.title)}</span>
      </div>`,
        )
        .join("")}
    </div>`
      : "";

  let sample = null;
  try {
    sample = window.claude ? await window.claude.use("sample") : null;
  } catch (e) {
    sample = null;
  }

  const renderFallback = (note) => {
    const body = contextItems.length
      ? `Based on what you've captured — ${escapeHtml(
          contextItems
            .slice(0, 3)
            .map((m) => m.title)
            .join("; "),
        )}.`
      : "No matching items in your captures.";
    const hint = note
      ? `<div class="ask-hint">${escapeHtml(note)}</div>`
      : "";
    // The dropdown already lists the matching items, so sources there would just repeat them.
    const sources = extra === "search-ask" ? "" : buildSourcesHtml();
    show(`<div class="ask-answer">${body}${hint}${sources}</div>`);
  };

  if (sample) {
    try {
      const result = await sample(buildAskPrompt(q, contextPool, today), {
        modelTier: "quick",
        onText: ({ text }) => {
          show(`<div class="ask-answer">${escapeHtml(text)}</div>`);
        },
      });
      show(`<div class="ask-answer">${escapeHtml(result.text)}${buildSourcesHtml()}</div>`);
      return;
    } catch (err) {
      /* fall through to API below */
    }
  }

  // A file:// page cannot reach the API at all, so say that instead of reporting a bare 403.
  if (isFileProtocol()) {
    renderFallback("Opened from a file — open the deployed site to use AI answers.");
    return;
  }

  try {
    const res = await apiFetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        items: askContextPayload(contextPool),
        today,
      }),
    });
    // The server returns a short, user-safe reason for 503 (no key configured) and 502
    // (upstream problem). Anything else is unexpected, so stay quiet and use local results.
    if (!res.ok) return renderFallback(await readAskError(res));
    const data = await res.json();
    if (data.answer) {
      show(`<div class="ask-answer">${escapeHtml(data.answer)}${buildSourcesHtml()}</div>`);
      return;
    }
    renderFallback();
  } catch (err) {
    renderFallback("Search is offline right now — showing your matching items.");
  }
}

/* Turns an /api/ask error response into one short line, and never throws.
   The server's `reason` (e.g. "groq:429 -> gemini:timeout") is appended so a failure can be
   diagnosed from the UI without opening DevTools. A platform-level failure (e.g. the function
   exceeding its duration limit) returns HTML rather than JSON, so the body is read as text
   first and the status code is still reported. */
async function readAskError(res) {
  let note = "Showing your matching items.";
  let data = null;
  try {
    const raw = await res.text();
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (res.status === 503) {
      note = "AI answers are off — add a model API key in Vercel to enable them.";
    } else if (res.status === 502) {
      note = "The AI provider is unavailable right now — showing your matching items.";
    } else if (typeof data?.error === "string" && data.error.length < 120) {
      note = data.error;
    }
    if (data?.reason) note += ` (${data.reason})`;
    else if (!data) note += ` (request failed, status ${res.status})`;
  } catch (e) {
    note += ` (request failed, status ${res.status})`;
  }
  console.warn("ask failed:", res.status, data);
  return note;
}

/* ---------- Keyboard shortcuts ---------- */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/* Modals and the Ask overlay block the single-letter shortcuts; the item slide-over
   does not — a quick capture from there just closes it first. */
/* ---------- Mobile back gesture ----------
   Android's back swipe arrives as a popstate. This app never navigates, so an unguarded back
   walks the browser out to whatever was open before it.

   A history entry is pushed only while a dismissible layer is open, and popped as soon as that
   layer closes. Back therefore always closes the top layer (sheet, panel, menu, search) and,
   once nothing is open, the browser is back at its real entry and exits the app normally.

   A web page cannot close its own tab, so "back closes the app" is the browser's own behaviour
   at the root of history. Holding a permanent guard instead would trap the user on the site
   with no way out, which is worse than the problem. */
let backLayerDepth = 0;

function pushBackLayer() {
  if (backLayerDepth > 0) return;
  try {
    history.pushState({ everythingLayer: true }, "");
    backLayerDepth = 1;
  } catch (e) {
    /* No history available (private mode, sandboxed frame) — back keeps its default behaviour. */
  }
}

/* Consumes the guard entry without closing a layer, e.g. when a layer closed itself by button. */
function popBackLayer() {
  if (backLayerDepth === 0) return;
  backLayerDepth = 0;
  try {
    history.back();
  } catch (e) {
    /* Ignore: the entry simply stays and the next back closes a layer. */
  }
}

function initBackNavigation() {
  const LAYER_SELECTOR =
    ".modal-overlay.open, .ask-overlay.open, #panel.open, #sidebar.open, #searchDropdown:not([hidden])";
  const anyLayerOpen = () => !!document.querySelector(LAYER_SELECTOR);

  // Keep the guard in step with what is actually on screen: push when a layer appears, pop it
  // when the last one closes. Doing this by observation means every existing open/close path
  // (buttons, Escape, save-and-close, the item slide-over) is covered without touching them.
  const observer = new MutationObserver(() => {
    if (anyLayerOpen()) pushBackLayer();
    else popBackLayer();
  });
  observer.observe(document.body, {
    attributes: true,
    subtree: true,
    childList: true,
    attributeFilter: ["class", "hidden"],
  });

  window.addEventListener("popstate", () => {
    // The browser consumed the guard entry; it must not be re-pushed for this same press.
    backLayerDepth = 0;
    // Close the top layer. If nothing was open, the app is already at its real history entry,
    // so the browser handles the rest (backgrounding the app rather than showing another site).
    closeTopmostOverlay();
  });

  // Tapping outside the search field dismisses its dropdown.
  document.addEventListener("pointerdown", (e) => {
    const dd = document.getElementById("searchDropdown");
    if (!dd || dd.hidden) return;
    if (dd.contains(e.target)) return;
    if (e.target.closest("#searchBox")) return;
    closeSearch();
  });
}

function isBlockingOverlayOpen() {
  return (
    !!document.querySelector(".modal-overlay.open") ||
    document.getElementById("askOverlay").classList.contains("open")
  );
}

/* Closes the top-most thing that is open. Returns true if it closed something. */
function closeTopmostOverlay() {
  const notif = document.getElementById("notifPanel");
  if (notif && notif.style.display === "block") {
    notif.style.display = "none";
    return true;
  }

  const avatar = document.getElementById("avatarMenu");
  if (avatar && avatar.style.display === "block") {
    avatar.style.display = "none";
    return true;
  }

  if (document.getElementById("sidebar")?.classList.contains("open")) {
    closeSidebar();
    return true;
  }

  if (document.getElementById("searchDropdown") && !document.getElementById("searchDropdown").hidden) {
    closeSearch();
    return true;
  }

  if (document.getElementById("askOverlay").classList.contains("open")) {
    closeAsk();
    return true;
  }
  if (document.getElementById("editModal").classList.contains("open")) {
    closeEditModal();
    return true;
  }
  if (document.getElementById("personModal").classList.contains("open")) {
    closePersonModal();
    return true;
  }
  if (document.getElementById("captureModal").classList.contains("open")) {
    closeCapture();
    return true;
  }
  if (document.getElementById("panel").classList.contains("open")) {
    closePanel();
    return true;
  }

  return false;
}

function shortcutsModifierLabel() {
  const isApple =
    /mac|iphone|ipad|ipod/i.test(navigator.platform || "") ||
    /mac os x/i.test(navigator.userAgent || "");
  return isApple ? "⌘ K" : "Ctrl K";
}

function initShortcuts() {
  const hint = document.getElementById("searchKbdHint");
  if (hint) hint.textContent = shortcutsModifierLabel();

  document.addEventListener("keydown", (e) => {
    const key = e.key;

    if (key === "Escape") {
      if (closeTopmostOverlay()) e.preventDefault();
      return;
    }

    const modifier = e.metaKey || e.ctrlKey;

    if (modifier && (key === "k" || key === "K")) {
      e.preventDefault();
      openAsk();
      return;
    }

    if (isTypingTarget(e.target) || modifier || e.altKey) return;

    if (key === "/") {
      e.preventDefault();
      openAsk();
      return;
    }

    if (key === "c" || key === "C") {
      e.preventDefault();
      if (isBlockingOverlayOpen()) return;
      if (document.getElementById("panel").classList.contains("open"))
        closePanel();
      openCapture();
    }
  });
}

/* ---------- Backup: export / import ---------- */
function exportData() {
  const payload = {
    app: "everything",
    version: 1,
    exportedAt: new Date().toISOString(),
    items: state.items || [],
    projects: state.projects || [],
    goals: state.goals || [],
    people: state.people || [],
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `everything-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFileAsText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importData(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await readFileAsText(file));
  } catch (e) {
    alert("That file is not valid JSON.");
    input.value = "";
    return;
  }

  const incomingItems = Array.isArray(payload.items) ? payload.items : [];
  const incomingProjects = Array.isArray(payload.projects)
    ? payload.projects
    : [];
  const incomingGoals = Array.isArray(payload.goals) ? payload.goals : [];
  const incomingPeople = Array.isArray(payload.people) ? payload.people : [];

  if (
    !incomingItems.length &&
    !incomingProjects.length &&
    !incomingGoals.length &&
    !incomingPeople.length
  ) {
    alert("No Everything data found in that file.");
    input.value = "";
    return;
  }

  if (
    !confirm(
      `Import ${incomingItems.length} item(s)? Existing records with the same id will be replaced.`,
    )
  ) {
    input.value = "";
    return;
  }

  state.items = state.items || [];
  state.projects = state.projects || [];
  state.goals = state.goals || [];
  state.people = state.people || [];

  for (const item of incomingItems) {
    if (!item || !item.id) continue;
    const existing = state.items.find((i) => i.id === item.id);
    if (existing) Object.assign(existing, item);
    else state.items.unshift(item);
    await dbSaveItem(item);
  }
  for (const p of incomingProjects) {
    if (!p || !p.id) continue;
    if (!state.projects.some((x) => x.id === p.id)) state.projects.unshift(p);
    await dbSaveProject(p);
  }
  for (const g of incomingGoals) {
    if (!g || !g.id) continue;
    if (!state.goals.some((x) => x.id === g.id)) state.goals.unshift(g);
    await dbSaveGoal(g);
  }
  for (const p of incomingPeople) {
    if (!p || !p.id) continue;
    if (!state.people.some((x) => x.id === p.id)) state.people.unshift(p);
    await dbSavePerson(p);
  }

  input.value = "";
  renderAll();
  alert(`Imported ${incomingItems.length} item(s).`);
}

/* PWA manifest shortcuts / deep links: ./?capture=1 and ./?view=tasks */
function applyLaunchShortcut() {
  if (!state || !location.search) return;

  const params = new URLSearchParams(location.search);
  const view = params.get("view");

  if (view && document.getElementById("view-" + view)) switchView(view);

  if (params.get("capture") === "1") openCapture();
}

/* ---------- Theme ---------- */
function toggleTheme() {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  state.theme = next;
  save();
}

/* ---------- Utility ---------- */
function escapeHtml(str) {
  return (str || "").replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        s
      ],
  );
}

function renderAll() {
  renderNav();
  renderToday();
  renderInbox();
  renderTasks();
  renderMemory();
  renderPeople();
  renderProjects();
  renderGoals();
  renderReports();
  renderNotifDot();
  if (activeView === "schedule") renderCalendar();
  const sq = document.getElementById("settingsQuote");
  if (
    sq &&
    typeof MOTIVATION_QUOTES !== "undefined" &&
    currentQuoteIndex !== null
  )
    sq.textContent = '"' + MOTIVATION_QUOTES[currentQuoteIndex] + '"';
}
let notifiedIds = new Set(
  JSON.parse(localStorage.getItem("notified_ids") || "[]"),
);

/* ============================================================
   REMINDER DELIVERY ENGINE
   A reminder has to reach the user in every state:
     * app open            -> an exact timer here, shown through the service worker
     * app closed + online -> /api/send-due-notifications pushes to every device
     * app closed + offline-> sw.js keeps its own persisted schedule and fires it
     * back online         -> whatever was missed arrives marked "Missed"
   items.notified / notified_at / snoozed_until keep the push and the local path from
   delivering the same reminder twice.
   ============================================================ */
const REMINDER_GRACE_MS = 12 * 60 * 60 * 1000; // deliver reminders missed up to 12h ago
const REMINDER_LOOKAHEAD_MS = 21 * 24 * 60 * 60 * 1000; // page timers; sw.js holds the rest
const MAX_TIMER_MS = 2147483000;
const SNOOZE_MINUTES = 10;

let reminderTimers = new Map();
let remindersInFlight = new Set();
let reminderSyncTimer = null;
let swRegistration = null;
let notificationLog = [];

function notificationSupported() {
  return "Notification" in window;
}

/* Safe access while the data layer is still booting (state is null until sync/login). */
function currentItems() {
  return (state && state.items) || [];
}

/* When should this item remind the user? A snooze always wins, and a delivered reminder
   stays quiet until it is snoozed or re-dated. */
function itemReminderTime(item) {
  if (!item || item.done || isArchived(item)) return null;
  if (item.snoozedUntil) return item.snoozedUntil;
  if (item.notified || notifiedIds.has(item.id)) return null;
  if (!item.dueDate) return null;
  const time = new Date(item.dueDate).getTime();
  return Number.isFinite(time) ? time : null;
}

function rememberNotified(id) {
  const key = String(id);
  if (notifiedIds.has(key)) return;
  notifiedIds.add(key);
  localStorage.setItem("notified_ids", JSON.stringify([...notifiedIds]));
}

function forgetNotified(id) {
  const key = String(id);
  if (!notifiedIds.delete(key)) return;
  localStorage.setItem("notified_ids", JSON.stringify([...notifiedIds]));
}

async function serviceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  if (swRegistration && swRegistration.active) return swRegistration;
  try {
    swRegistration = await navigator.serviceWorker.ready;
  } catch (e) {
    swRegistration = null;
  }
  return swRegistration;
}

function postToServiceWorker(message) {
  if (!("serviceWorker" in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(message);
    return;
  }
  navigator.serviceWorker.ready
    .then((reg) => reg.active && reg.active.postMessage(message))
    .catch(() => {});
}

/* On Android/iOS a notification must come from the service worker — `new Notification()`
   throws there, so the constructor is only a desktop fallback. */
async function showLocalNotification(title, options) {
  const reg = await serviceWorkerRegistration();
  if (reg && reg.showNotification) {
    try {
      await reg.showNotification(title, options);
      return true;
    } catch (e) {
      /* fall through to the constructor */
    }
  }
  try {
    new Notification(title, options);
    return true;
  } catch (e) {
    return false;
  }
}

function requestNotifications() {
  if (!("Notification" in window)) {
    alert("Notifications aren't supported in this browser.");
    return;
  }

  Notification.requestPermission().then((perm) => {
    updateNotifBtn();
    if (perm === "granted") {
      new Notification("Everything", {
        body: "Reminders are on — you'll get notified when tasks are due.",
      });
    }
  });
}
function getNotificationItems() {
  return state.items.filter(
    (i) =>
      !i.done &&
      !isArchived(i) &&
      ((i.dueDate && (isToday(i.dueDate) || isOverdue(i))) ||
        i.kind === "waiting"),
  );
}
function renderNotifDot() {
  const dot = document.getElementById("notifDot");
  if (dot) dot.style.display = getNotificationItems().length ? "block" : "none";
}
function toggleNotifPanel() {
  const panel = document.getElementById("notifPanel");
  const opening = panel.style.display !== "block";
  panel.style.display = opening ? "block" : "none";
  if (opening) renderNotifPanel();
}
function renderNotifPanel() {
  const items = getNotificationItems();
  document.getElementById("notifList").innerHTML = items.length
    ? items
        .map(
          (i) => `
    <div class="task-row" style="padding:9px 14px;" onclick="toggleNotifPanel();openPanel('${i.id}')">
      <div class="task-meta"><div class="task-title">${isOverdue(i) ? icon("triangle-alert") + " " : ""}${escapeHtml(i.title)}</div>
      <div class="task-sub">${isOverdue(i) ? "Overdue" : i.due || "Waiting for"}</div></div>
    </div>`,
        )
        .join("")
    : '<p class="empty" style="padding:14px;">Nothing needs attention right now.</p>';
}
document.addEventListener("click", (e) => {
  const panel = document.getElementById("notifPanel");
  if (
    panel &&
    panel.style.display === "block" &&
    !panel.contains(e.target) &&
    !e.target.closest(".icon-btn")
  ) {
    panel.style.display = "none";
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePushNotifications() {
  if (!notificationSupported()) {
    alert("Notifications aren't supported in this browser.");
    return;
  }

  const btn = document.getElementById("notifBtn");
  if (btn) btn.textContent = "Enabling…";

  if (!(await requestNotificationPermission())) {
    updateNotifBtn();
    renderNotificationStatus();
    alert(
      "Notifications are blocked. Allow them for Everything in your browser or phone settings, then try again.",
    );
    return;
  }

  const subscribed = await ensurePushSubscription({ requestPermission: false });

  await showLocalNotification("Everything", {
    body: subscribed
      ? "Reminders are on — you'll be notified even when the app is closed."
      : "Reminders are on. This device is notified while the app is open or in the background.",
    tag: "everything-welcome",
    data: { url: "./" },
  });

  updateNotifBtn();
  renderNotificationStatus();
}

async function requestNotificationPermission() {
  if (Notification.permission === "granted") return true;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch (e) {
    return false;
  }
}

/* Registers this device so the server can push while the app is closed. Safe to call
   repeatedly: an existing subscription is reused and its row is refreshed. */
async function ensurePushSubscription(options) {
  const opts = options || {};

  if (!notificationSupported()) return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (opts.requestPermission && !(await requestNotificationPermission())) return false;
  if (Notification.permission !== "granted") return false;
  if (!VAPID_PUBLIC_KEY) return false;
  if (syncReadyPromise) await syncReadyPromise;
  if (!sbUser) return false;

  try {
    const reg = await serviceWorkerRegistration();
    if (!reg) return false;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert(
      {
        user_id: sbUser,
        household_id: currentHouseholdId,
        endpoint: json.endpoint,
        subscription: json,
        platform: navigator.userAgentData?.platform || navigator.platform || "",
        user_agent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        enabled: true,
        created: Date.now(),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" },
    );

    if (error) {
      console.warn("Push subscription not stored:", error.message);
      return false;
    }

    return true;
  } catch (e) {
    console.warn("Push subscribe skipped:", e.message || e);
    return false;
  }
}

function updateNotifBtn() {
  const btn = document.getElementById("notifBtn");
  if (!btn || !("Notification" in window)) return;
  const perm = Notification.permission;
  btn.innerHTML =
    perm === "granted"
      ? icon("circle-check") + "<span>Enabled</span>"
      : perm === "denied"
        ? "<span>Blocked — check browser settings</span>"
        : "<span>Enable notifications</span>";
  renderNotificationStatus();
  refreshIcons();
}

/* Shows the user *how* they will be reached right now, which is the honest answer to
   "will I actually get this offline?". */
async function renderNotificationStatus() {
  const el = document.getElementById("notifStatus");
  if (!el) return;

  const granted = notificationSupported() && Notification.permission === "granted";
  const pending = currentItems().filter((item) => {
    const time = itemReminderTime(item);
    return time !== null && time > Date.now();
  });

  let pushState = "Not available in this browser";
  if (granted && "serviceWorker" in navigator && "PushManager" in window) {
    try {
      const reg = await serviceWorkerRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      pushState = sub ? "Registered — reaches this device with the app closed" : "Not registered yet";
    } catch (e) {
      pushState = "Unavailable";
    }
  }

  const rows = [
    ["Device notifications", granted ? "On" : "Off"],
    ["Closed-app push", pushState],
    [
      "Network",
      navigator.onLine
        ? "Online"
        : "Offline — reminders are delivered by this device itself",
    ],
    ["Scheduled reminders", String(pending.length)],
  ];

  el.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div class="field-row" style="padding:4px 0;"><span class="field-label">${escapeHtml(label)}</span><span style="font-size:13px;text-align:right;">${escapeHtml(value)}</span></div>`,
    )
    .join("");

  renderNotificationLog();
}

function renderNotificationLog() {
  const el = document.getElementById("notifDeliveryLog");
  if (!el) return;

  el.innerHTML = notificationLog.length
    ? notificationLog
        .map(
          (row) => `
    <div class="field-row" style="padding:6px 0; align-items:flex-start;">
      <span class="field-label" style="flex:1;">${escapeHtml(row.title || "Reminder")}</span>
      <span style="font-size:12px;text-align:right;">${escapeHtml(row.status)} · ${escapeHtml(row.channel)}<br />${escapeHtml(fmtTime(row.created_at))}</span>
    </div>`,
        )
        .join("")
    : '<p class="empty">No reminders delivered on this device yet.</p>';
}

/* Proves both legs of the chain: the local one always works (even offline), the server
   push only when the endpoint is registered. */
async function testNotification() {
  if (!notificationSupported()) {
    alert("Notifications aren't supported in this browser.");
    return;
  }
  const btn = document.getElementById("notifTestBtn");
  if (btn) btn.disabled = true;
  try {
    await runNotificationTest();
  } finally {
    if (btn) btn.disabled = false;
    // The delivery log and scheduled count may have changed.
    renderNotificationStatus();
  }
}

async function runNotificationTest() {
  if (!(await requestNotificationPermission())) {
    updateNotifBtn();
    alert("Allow notifications first, then try again.");
    return;
  }

  updateNotifBtn();

  const local = await showLocalNotification("Everything", {
    body: "This reminder came from this device — it works offline too.",
    tag: "everything-test",
    data: { url: "./" },
    actions: [{ action: "open", title: "Open" }],
  });

  if (!sbUser || !navigator.onLine) return;

  try {
    const res = await apiFetch("/api/send-due-notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true, user_id: sbUser }),
    });
    const data = await res.json().catch(() => ({}));

    await showLocalNotification("Everything", {
      body: data && data.ok
        ? "Server push works too — reminders reach this device when the app is closed."
        : `Local delivery works${local ? "" : " with a limit"} · server push: ${data.skipped || data.error || "not available"}`,
      tag: "everything-test-server",
      data: { url: "./" },
    });
  } catch (e) {
    // Offline or the endpoint isn't deployed — the local notification already arrived.
  }
}
function reminderPayload(item) {
  const time = itemReminderTime(item);

  return {
    id: item.id,
    title: item.title || "Reminder",
    body: item.sub || item.due || "Tap to open Everything",
    url: `./?item=${item.id}`,
    priority: item.priority || "",
    time,
    kind: item.kind || "",
  };
}

function logNotification(item, status, channel, detail) {
  const entry = {
    item_id: item.id,
    user_id: sbUser || null,
    channel,
    status,
    title: item.title || "",
    body: item.sub || "",
    detail: detail || "",
    created_at: new Date().toISOString(),
  };

  notificationLog = [entry, ...notificationLog].slice(0, 10);
  renderNotificationLog();

  // Best effort audit row (supabase/migrations/004) — never block delivery on it.
  if (sbUser) {
    sb
      .from("notification_log")
      .insert(entry)
      .then(({ error }) => {
        if (error) console.warn("notification_log skipped:", error.message);
      });
  }
}

/* One reminder, delivered once. `missed` marks the catch-up case: the time passed while
   the app, the device or the network was away. */
async function deliverItemReminder(item, options) {
  const opts = options || {};
  if (!item || remindersInFlight.has(item.id)) return false;

  const time = itemReminderTime(item);
  if (time === null) return false;

  remindersInFlight.add(item.id);

  try {
    const payload = reminderPayload(item);
    const missed = !!opts.missed;
    const urgent = item.priority === "urgent" || item.priority === "high";

    // Mark it before showing: the flag is what keeps the cron and other devices quiet,
    // and it makes a second delivery attempt impossible.
    rememberNotified(item.id);
    item.notified = true;
    item.notifiedAt = Date.now();
    item.snoozedUntil = "";

    let shown = false;
    if (notificationSupported() && Notification.permission === "granted") {
      shown = await showLocalNotification(
        (missed ? "Missed: " : "") + payload.title,
        {
          body: missed ? `Missed while you were away · ${payload.body}` : payload.body,
          tag: "item-" + item.id,
          renotify: true,
          requireInteraction: urgent,
          timestamp: payload.time,
          data: { url: payload.url, itemId: item.id, missed },
          actions: [
            { action: "open", title: "Open" },
            { action: "done", title: "Done" },
            { action: "snooze", title: "Snooze 10m" },
          ],
        },
      );
    }

    logNotification(
      item,
      shown ? (missed ? "missed" : "sent") : "skipped",
      "local",
      shown ? "" : "notification permission not granted on this device",
    );

    await dbSaveItem(item);
    renderNotificationStatus();

    return shown;
  } finally {
    remindersInFlight.delete(item.id);
  }
}
/* ---------- reminder scheduling ---------- */

function pendingReminderPayloads() {
  return currentItems()
    .filter((item) => itemReminderTime(item) !== null)
    .map((item) => reminderPayload(item));
}

/* Keeps two things in step with the data: the service worker's persisted schedule (which
   is what survives the app being closed) and exact page timers for anything due soon.
   Debounced because dbSaveItem runs on every mutation. */
function refreshReminderSchedule() {
  if (reminderSyncTimer) clearTimeout(reminderSyncTimer);
  reminderSyncTimer = setTimeout(() => {
    reminderSyncTimer = null;
    applyReminderSchedule();
  }, 200);
}

function applyReminderSchedule() {
  reminderTimers.forEach((handle) => clearTimeout(handle));
  reminderTimers.clear();

  const now = Date.now();
  const payloads = pendingReminderPayloads();

  postToServiceWorker({ type: "SYNC_REMINDERS", reminders: payloads });

  payloads.forEach((payload) => {
    const delay = payload.time - now;

    if (delay <= 0) {
      // Due already — deliver here if it is inside the catch-up window, otherwise the
      // worker's copy of the schedule stays as the record of it.
      if (now - payload.time <= REMINDER_GRACE_MS) {
        const item = currentItems().find((i) => i.id === payload.id);
        deliverItemReminder(item, { missed: now - payload.time > 60000 });
      }
      return;
    }

    if (delay > REMINDER_LOOKAHEAD_MS) return; // the service worker still holds it

    const item = currentItems().find((i) => i.id === payload.id);
    if (!item) return;

    reminderTimers.set(
      payload.id,
      setTimeout(() => {
        reminderTimers.delete(payload.id);
        deliverItemReminder(item, { missed: false });
      }, Math.min(delay, MAX_TIMER_MS)),
    );
  });

  renderNotificationStatus();
}

function cancelReminderFor(id) {
  const handle = reminderTimers.get(String(id));
  if (handle) {
    clearTimeout(handle);
    reminderTimers.delete(String(id));
  }
  postToServiceWorker({ type: "CANCEL_REMINDER", id });
}

/* The catch-up path. Runs on load, every 30s, when the network returns, when the tab
   becomes visible again and whenever data syncs — so a reminder that was due while the
   device was offline reaches the user as soon as anything changes. */
function runReminderCheck(reason) {
  refreshReminderSchedule();

  const now = Date.now();

  currentItems().forEach((item) => {
    const time = itemReminderTime(item);
    if (time === null || time > now) return;
    if (now - time > REMINDER_GRACE_MS) return;
    deliverItemReminder(item, { missed: now - time > 60000, reason });
  });
}
/* ---------- reminder actions ---------- */

/* Open / Done / Snooze come back from sw.js as a message, or as ?notifAction=… in the URL
   when the worker had no window to talk to. */
async function handleNotificationAction(action, itemId) {
  if (!itemId) return;

  const item = currentItems().find((i) => i.id === itemId);
  if (!item) return;

  if (action === "done") {
    if (!item.done) await toggleDone(itemId);
    return;
  }

  if (action === "snooze") {
    item.snoozedUntil = Date.now() + SNOOZE_MINUTES * 60000;
    item.notified = false;
    item.notifiedAt = "";
    forgetNotified(item.id);
    await dbSaveItem(item);
    logNotification(item, "snoozed", "in_app", `until ${fmtTime(item.snoozedUntil)}`);
    renderNotificationStatus();
    return;
  }

  if (typeof openPanel === "function") openPanel(itemId);
}

/* Deep links: ?item=<id> opens the reminder, ?notifAction=…&itemId=… replays an action
   that was tapped while the app was closed. The query is cleaned so a reload is neutral. */
function applyNotificationIntentFromUrl() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (e) {
    return;
  }

  const action = params.get("notifAction");
  const actionItemId = params.get("itemId");
  const openItemId = params.get("item");

  if (!action && !openItemId) return;

  params.delete("notifAction");
  params.delete("itemId");
  params.delete("item");

  const query = params.toString();
  history.replaceState(
    {},
    "",
    window.location.pathname + (query ? "?" + query : "") + window.location.hash,
  );

  if (action && actionItemId) handleNotificationAction(action, actionItemId);
  else if (openItemId && typeof openPanel === "function") openPanel(openItemId);
}

function initNotificationChannel() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};

    if (data.type === "NOTIFICATION_ACTION") {
      handleNotificationAction(data.action, data.itemId);
      return;
    }

    if (data.type === "REMINDER_DELIVERED") {
      // The worker showed it (app closed, or the page was asleep). Mirror that into the
      // item so the cron and the other devices do not send it again.
      const deliveredId = data.reminder && data.reminder.id;
      if (!deliveredId) return;

      rememberNotified(deliveredId);

      const item = currentItems().find((i) => i.id === deliveredId);
      if (item && !item.notified) {
        item.notified = true;
        item.notifiedAt = Date.now();
        item.snoozedUntil = "";
        dbSaveItem(item);
      }

      renderNotificationStatus();
      return;
    }

    if (data.type === "REMINDER_DELIVERIES") {
      // Whatever the worker delivered while this page was closed.
      (data.deliveries || []).forEach((delivery) => rememberNotified(delivery.id));
      refreshReminderSchedule();
      renderNotificationStatus();
    }
  });

  postToServiceWorker({ type: "READ_DELIVERIES" });
}

function initReminderDelivery() {
  initNotificationChannel();
  applyNotificationIntentFromUrl();
  runReminderCheck("startup");

  setInterval(() => runReminderCheck("interval"), 30000);

  window.addEventListener("online", () => {
    runReminderCheck("online");
    // Re-register quietly: a device that lost its subscription while offline gets it back.
    if (notificationSupported() && Notification.permission === "granted") {
      ensurePushSubscription({ requestPermission: false }).then(() =>
        renderNotificationStatus(),
      );
    }
  });

  window.addEventListener("offline", () => {
    renderNotificationStatus();
    runReminderCheck("offline");
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      runReminderCheck("visible");
      postToServiceWorker({ type: "READ_DELIVERIES" });
    }
  });

  // Periodic catch-up for installed PWAs where the browser allows it.
  if ("serviceWorker" in navigator && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready
      .then((reg) => {
        if (reg.periodicSync && reg.periodicSync.register) {
          return reg.periodicSync
            .register("everything-reminders", { minInterval: 15 * 60 * 1000 })
            .catch(() => {});
        }
        return undefined;
      })
      .catch(() => {});
  }
}
/* ---------- Init ---------- */
restoreRememberedEmail();
if (window.claude) {
  initMultiUser();
} else {
  state = {
    items: [],
    events: [],
    projects: [],
    goals: [],
    people: [],
    theme: localStorage.getItem("theme") || "light",
  };
  if (state.theme)
    document.documentElement.setAttribute("data-theme", state.theme);
}
restoreSidebarCollapse();
syncSidebarMode();
repairVersionMismatch();
refreshIcons();
updateNotifBtn();
renderQuote();
restoreNudge();
restoreDashboardLayout();
enableDashboardDragging();
initShortcuts();
initBackNavigation();
applyLaunchShortcut();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then((reg) => {
      swRegistration = reg;
      return reg;
    })
    .catch((err) => console.warn("Service worker registration failed:", err));
}
initReminderDelivery();
setInterval(renderToday, 60000);
setInterval(shuffleQuote, 60000);
