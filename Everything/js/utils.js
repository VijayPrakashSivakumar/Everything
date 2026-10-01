/* ---------- Utility ---------- */

/* The brand mark, as markup. One function rather than a template literal at each call site, because
   the path is already written out three times in index.html and a fourth, fifth and sixth copy is
   exactly how the sidebar and the capture button drift apart visually. A loader built from a
   different path than the logo is not the brand doing the waiting, it is a near-miss.

   The gradient is referenced by id and defined once, in the document, next to the sidebar mark. So
   the loader inherits the same paint as the logo for free instead of carrying its own colours.

   `block` centres the whole thing and is what a panel with nothing else in it wants; inline is for a
   status line that already has words next to it. */
function brandLoaderHTML(options = {}) {
  const label = options.label || "";
  const size = options.size === "lg" ? " brand-loader--lg" : options.size === "sm" ? " brand-loader--sm" : "";
  const tag = options.block ? "div" : "span";
  // role=status announces the change once, rather than on every tick, and the label is read out
  // rather than the word "loading" being implied by a moving shape that a screen reader cannot see.
  return (
    `<${tag} class="brand-loader${size}${options.block ? " brand-loader-block" : ""}" role="status">` +
    `<svg viewBox="0 0 40 24" aria-hidden="true" focusable="false">` +
    `<path class="loader-track" d="M8,12 C8,6 14,6 20,12 C26,18 32,18 32,12 C32,6 26,6 20,12 C14,18 8,18 8,12 Z"` +
    ` fill="none" stroke-width="4.5" stroke-linecap="round" pathLength="1"/>` +
    `<path class="loader-run" d="M8,12 C8,6 14,6 20,12 C26,18 32,18 32,12 C32,6 26,6 20,12 C14,18 8,18 8,12 Z"` +
    ` fill="none" stroke-width="4.5" stroke-linecap="round" pathLength="1"/>` +
    `</svg>` +
    (label ? `<span class="brand-loader-label">${escapeHtml(label)}</span>` : "") +
    `</${tag}>`
  );
}

/* ---------- Confirm dialog ----------
   Seven places used the browser's confirm(). That is a flat grey box in the middle of a considered
   interface, and it blocks the thread — so it cannot be styled, focused, animated, or made to return
   focus. Worse, it is a single yes/no with no room for the consequence, and the consequences here are
   the whole point: "Items linked to it will keep their project tag but the project itself will be
   removed" does not fit in a browser alert without looking like an error.

   Awaiting a promise is the only way to keep the call sites readable. The alternative — a callback
   wrapper — turns every call site into a nested closure and makes the destructive path the hardest
   one to read, which is exactly backwards.

   Deliberately a *confirm* and not an undo. Every caller here destroys something irreversible, and the
   design doc's own rule is that those get a dialog; bulk delete additionally gets the undo bar, so the
   person who agreed and changed their mind is still covered. This does not weaken that, it replaces the
   worst-looking half of it.

   One instance, because two dialogs on screen would be two answers to one question. `open` is a guard
   rather than a queue: a second request while one is open cannot be answered out of order, so it is
   refused rather than silently queued behind a decision the person has not read yet. */
let confirmResolver = null;

/* `danger` tints the confirm button. Only set for something that cannot be undone — using it
   everywhere would be a red button that means nothing. */
function confirmDialog(options) {
  const dialog = document.getElementById("confirmDialog");
  if (!dialog) return Promise.resolve(window.confirm(options.body || "Are you sure?"));
  // Already open. Resolving true would delete something on a decision nobody was shown.
  if (confirmResolver) return Promise.resolve(false);

  document.getElementById("confirmDialogTitle").textContent = options.title || "Are you sure?";
  document.getElementById("confirmDialogBody").textContent = options.body || "";
  const ok = document.getElementById("confirmOkBtn");
  // A null confirmLabel is the one-button form (alertDialog): the row is hidden entirely rather than
  // left empty, because an empty .modal-actions row still reserves its flex gap and reads as a dialog
  // with a button that failed to render.
  ok.textContent = options.confirmLabel || "";
  ok.hidden = !options.confirmLabel;
  ok.classList.toggle("danger", Boolean(options.danger));
  const cancel = document.getElementById("confirmCancelBtn");
  if (cancel) cancel.textContent = options.cancelLabel || "Cancel";

  dialog.classList.add("open");
  lockPageScroll(true);
  // Focus lands on Cancel, never on the destructive button. Enter then means "go back", which is the
  // safe default for something irreversible, and the person has to reach across for Delete on purpose.
  if (ok.hidden) enterDialog(dialog, "confirmCancelBtn");
  else enterDialog(dialog, options.danger ? "confirmCancelBtn" : "confirmOkBtn");

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

/* The single exit. Every route out of the dialog goes through here — the buttons, the X, the backdrop
   and Escape — so the promise cannot be settled twice, and focus is handed back exactly once. If two
   calls raced, the second would see a null resolver and settle null, which is not a valid answer, so it
   is dropped instead. */
function settleConfirmDialog(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  const dialog = document.getElementById("confirmDialog");
  if (dialog) {
    dialog.classList.remove("open");
    if (!document.querySelector(".modal-overlay.open, .ask-overlay.open, #panel.open"))
      lockPageScroll(false);
    leaveDialog(dialog);
  }
  if (resolve) resolve(Boolean(value));
}

/* Escape is the keyboard route out, and it has to mean Cancel. closeTopmostOverlay() runs first and
   finds this dialog by the same .modal-overlay.open selector as every other sheet, so without this it
   would remove the class and never settle the promise — the caller would hang forever, which is how a
   dismissed confirm() could leave a delete half-done. Guarded on the resolver so it cannot double-settle
   when Escape arrives after a click already answered it. */
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && confirmResolver
    && document.getElementById("confirmDialog")?.classList.contains("open")) {
    settleConfirmDialog(false);
  }
});

/* An empty view. Three jobs, in this order, and the order is the design:

   Say *why* it is empty. "You have not added anything" and "your filter matched nothing" are
   different situations that want opposite things — one wants an action, the other wants the filter
   cleared. Showing the same grey sentence for both is how a person concludes the app is broken when
   they are the one who filtered it.

   Look deliberate. An empty view is the first thing a new person sees on every screen, so it is the
   app's opening line. A line of grey text in the middle of a white page reads as a failed render,
   not as a considered state.

   Offer exactly one next step. Not three. Two buttons is a decision the app is asking the person to
   make on its behalf.

   The mark is the same infinity the sidebar and the loader use, held still and dimmed. It is the
   brand acknowledging an empty state rather than a shrug, and it costs nothing to stay consistent
   because the path is written once, here. */
/* Tones are mapped, not concatenated. The old shape built the class as `empty-state--${tone}`, which
   has two problems at once: the class name never appears literally anywhere, so the dead-CSS audit
   cannot see that it is used and reports it as dead; and a typo in a `tone` value silently produced a
   class with no styles at all. A map makes the names checkable and the typo impossible. */
const EMPTY_TONES = { good: "empty-state--good" };

function emptyStateHTML(options = {}) {
  const title = options.title || "";
  const body = options.body || "";
  // One action, or none. The call sites pass a handler expression, so it is escaped like any other
  // interpolated value.
  const action = options.action
    ? `<button class="btn empty-action" onclick="${escapeHtml(options.action)}">${escapeHtml(options.actionLabel || "Get started")}</button>`
    : "";
  const tone = EMPTY_TONES[options.tone] || "";
  if (!title) return "";
  return (
    `<div class="empty-state${tone ? ` ${tone}` : ""}">` +
    `<svg class="empty-mark" viewBox="0 0 40 24" aria-hidden="true" focusable="false">` +
    `<path d="M8,12 C8,6 14,6 20,12 C26,18 32,18 32,12 C32,6 26,6 20,12 C14,18 8,18 8,12 Z"` +
    ` fill="none" stroke-width="4.5" stroke-linecap="round"/></svg>` +
    `<p class="empty-state-title">${escapeHtml(title)}</p>` +
    (body ? `<p class="empty-state-body">${escapeHtml(body)}</p>` : "") +
    action +
    `</div>`
  );
}

/* The narrow form: a single line, no mark, for a list that is merely filtered rather than new. The
   mark is wrong here — a filtered list is not an empty one, and drawing the brand's "nothing yet"
   mark on every failed search would train people to ignore it. */
function emptyNoteHTML(text) {
  return text ? `<p class="empty">${escapeHtml(text)}</p>` : "";
}

function escapeHtml(str) {
  return (str || "").replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        s
      ],
  );
}

/* A JS string literal that is safe to drop into an inline onclick handler. escapeHtml alone is not
   enough: the browser decodes entities *before* it compiles the handler, so `&#39;` turns back into
   an apostrophe and `deleteProject('id','Mom&#39;s Project')` fails to parse — the button just stops
   working, with only a console error to show for it. JSON.stringify quotes the value correctly and
   escapeHtml then makes the result safe inside the attribute; both halves are required. */
const jsStr = (v) => escapeHtml(JSON.stringify(String(v ?? "")));

function renderAll() {
  renderNav();
  renderToday();
  renderInbox();
  renderTasks();
  renderMemory();
  renderDocuments();
  renderMoney();
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
  // A document is reminded by its expiry, not by a due date it was never given. Checked before the
  // dueDate branch so a document that happens to carry both is reminded about the one that matters,
  // and a document without a dueDate is still reminded at all — which is the whole feature.
  if (isDocument(item)) return documentReminderTime(item);
  // An expense is the mirror image: the money is already gone, so there is nothing to be reminded
  // of. Without this an expense carrying a parsed date would fire a notification about spending that
  // has already happened — and it would do it every time the app was opened.
  if (isExpense(item)) return null;
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
    <div class="task-row" style="padding:9px 14px;" onclick="toggleNotifPanel();openPanel(${jsStr(i.id)})">
      <div class="task-meta"><div class="task-title">${isOverdue(i) ? icon("triangle-alert") + " " : ""}${escapeHtml(i.title)}</div>
      <div class="task-sub">${isOverdue(i) ? "Overdue" : i.due || "Waiting for"}</div></div>
    </div>`,
        )
        .join("")
    : emptyNoteHTML("Nothing needs you right now.");
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
    await alertDialog({ title: "Notifications unsupported", body: "This browser cannot show notifications from a web app. Chrome or Firefox on Android, or Safari on iPhone, all can." });
    return;
  }

  const btn = document.getElementById("notifBtn");
  if (btn) btn.textContent = "Enabling…";

  if (!(await requestNotificationPermission())) {
    updateNotifBtn();
    renderNotificationStatus();
    await alertDialog({ title: "Notifications are blocked", body: "Allow them for Everything in your browser or phone settings, then try again." });
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
    await alertDialog({ title: "Notifications unsupported", body: "This browser cannot show notifications from a web app. On Android try Chrome or Firefox." });
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
    await alertDialog({ title: "Allow notifications first", body: "Turn reminders on, then send the test again." });
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
    // A document's own `due` is empty — it was never given a due date — so the fallback text would
    // have been the generic "Tap to open Everything". The expiry is the reason to tap, so it says so.
    body: isDocument(item)
      ? item.sub || documentLabel(item)
      : item.sub || item.due || "Tap to open Everything",
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
