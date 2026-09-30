/* ---------- the morning digest ----------

   One notification a day, at a time you choose, saying what actually needs you. Everything else in
   this app is pull-based: you open it, and it tells you what is on. That works right up until the
   thing you needed was the reason you forgot to open it.

   A daily notification is the easiest thing in this app to get wrong. Get it wrong once and it is
   muted for good, and a muted digest is worse than none — it is the "pressure" the rest of this app
   is careful to avoid. So three rules, all enforced below:

     opt in        never on by default
     say little    counts and two or three names, never the whole list
     stay quiet    when there is genuinely nothing to say, say nothing at all  */

const MORNING_DIGEST_KEY = "everything_morning_digest_v1";
const DIGEST_DEFAULT_HOUR = 8;
const DIGEST_MAX_NAMES = 3;
/* A waiting item with no check-back day that has sat this long is the one thing a pull-based view
   never surfaces: it is not overdue, not due today, and not in anybody's way. */
const DIGEST_WAITING_STALE_DAYS = 14;

function readMorningDigestSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(MORNING_DIGEST_KEY) || "{}") || {};
  } catch (error) {
    saved = {};
  }
  if (typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const hour = Number(saved.hour);
  return {
    enabled: saved.enabled === true,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DIGEST_DEFAULT_HOUR,
    lastSentOn: typeof saved.lastSentOn === "string" ? saved.lastSentOn : "",
  };
}

function writeMorningDigestSettings(patch) {
  const next = { ...readMorningDigestSettings(), ...patch };
  try {
    localStorage.setItem(MORNING_DIGEST_KEY, JSON.stringify(next));
  } catch (error) {
    /* Private mode: today's digest still sends, it just cannot remember that it did. */
  }
  return next;
}

/* A local calendar day, not UTC. toISOString would roll over at midnight UTC, which is the wrong
   day for most of the world and would send the digest at an odd hour — or twice. */
function localDayKey(date) {
  const d = new Date(date || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* Builds the digest, or null when there is nothing worth interrupting anyone for. Reuses the same
   isOverdue / isToday the Today view and the notification bell already use, so the digest can never
   disagree with the rest of the app about what is late. */
function buildMorningDigest(now) {
  const at = new Date(now || Date.now());
  const open = currentItems().filter((item) => !item.done && !isArchived(item));

  const overdue = open.filter((item) => isOverdue(item));
  const dueToday = open.filter((item) => !isOverdue(item) && isToday(item.dueDate));
  const staleCutoff = at.getTime() - DIGEST_WAITING_STALE_DAYS * 86400000;
  const staleWaiting = open.filter(
    (item) =>
      item.kind === "waiting" &&
      !item.dueDate &&
      Number(item.created || 0) > 0 &&
      Number(item.created) < staleCutoff,
  );

  // The quiet rule, in one place. Nothing needs you, so nothing is sent.
  if (!overdue.length && !dueToday.length && !staleWaiting.length) return null;

  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (staleWaiting.length) parts.push(`${staleWaiting.length} waiting too long`);

  // Names the worst first, because the worst is the reason to read the rest.
  const ranked = [
    ...overdue.map((item) => ({ item, rank: 0 })),
    ...dueToday.map((item) => ({ item, rank: 1 })),
    ...staleWaiting.map((item) => ({ item, rank: 2 })),
  ].sort((a, b) => a.rank - b.rank);

  const named = ranked
    .slice(0, DIGEST_MAX_NAMES)
    .map((entry) => entry.item.title)
    .filter(Boolean);
  const rest = ranked.length - named.length;

  return {
    counts: { overdue: overdue.length, dueToday: dueToday.length, staleWaiting: staleWaiting.length },
    title: `Good ${at.getHours() < 12 ? "morning" : at.getHours() < 17 ? "afternoon" : "evening"} · ${parts.join(" · ")}`,
    body: named.length
      ? `${named.join(" · ")}${rest > 0 ? ` · and ${rest} more` : ""}`
      : parts.join(" · "),
    // A tap opens Today, which is where all of these live, rather than an arbitrary item.
    url: "./?view=today",
  };
}

let digestInFlight = false;

/* Sends today's digest, at most once. Every early return is a reason *not* to interrupt someone,
   and each one says which rule stopped it — which is the difference between a digest people keep
   and one they mute. */
async function deliverMorningDigest(reason) {
  const settings = readMorningDigestSettings();
  if (!settings.enabled) return { sent: false, why: "not switched on" };
  if (digestInFlight) return { sent: false, why: "already sending" };
  if (!notificationSupported() || Notification.permission !== "granted") {
    return { sent: false, why: "notifications are not permitted on this device" };
  }

  const today = localDayKey();
  if (settings.lastSentOn === today) return { sent: false, why: "already sent today" };

  const digest = buildMorningDigest();
  if (!digest) {
    // Nothing needed you, so nothing happened — and the day is deliberately NOT marked as sent.
    // Marking it would suppress the rest of the day: a task snoozed to this afternoon would never
    // be mentioned. Rebuilding an empty digest every 30s costs one array filter; losing a real
    // item to save that is a bad trade.
    return { sent: false, why: "nothing to report" };
  }

  digestInFlight = true;
  try {
    const shown = await showLocalNotification(digest.title, {
      body: digest.body,
      // One tag: a second digest on the same day replaces the first rather than stacking.
      tag: "everything-morning-digest",
      renotify: true,
      requireInteraction: false,
      data: { url: digest.url, digest: true },
      actions: [{ action: "open", title: "Open" }],
    });

    if (shown) writeMorningDigestSettings({ lastSentOn: today });
    return { sent: shown, why: shown ? "sent" : "the notification could not be shown" };
  } finally {
    digestInFlight = false;
  }
}

/* The catch-up. Called on the same beats as the reminder check — startup, every 30s, the tab
   becoming visible, the network returning — so a digest missed because the phone was asleep is
   delivered on the next wake, not skipped. */
function checkMorningDigest(reason) {
  const settings = readMorningDigestSettings();
  if (!settings.enabled) return;

  const now = new Date();
  // Before the chosen hour, it stays quiet. Catching up tomorrow's overdue items tomorrow is
  // exactly what the overdue line in the digest is for.
  if (now.getHours() < settings.hour) return;
  if (settings.lastSentOn === localDayKey(now)) return;

  deliverMorningDigest(reason || "check");
}

function setMorningDigestEnabled(enabled) {
  writeMorningDigestSettings({ enabled: !!enabled, lastSentOn: "" });
  renderMorningDigestSettings();
  syncDigestPreference(!!enabled);
  if (enabled) {
    // Turning it on should not wait until tomorrow, but it still has to be after the chosen hour
    // and it still says nothing if there is genuinely nothing to say.
    checkMorningDigest("enabled");
  }
}

/* Tells the server whether this person wants the digest, so it can reach a phone with the app
   closed. Best effort in both directions: with no account it is a no-op, and a failure here must
   never stop the local setting from being honoured by the client leg. */
async function syncDigestPreference(enabled) {
  if (!sbUser || !structuredSyncAvailable()) return false;
  try {
    const { error } = await sb.from("digest_preferences").upsert({
      user_id: sbUser,
      enabled: !!enabled,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    if (error) {
      // A database that has not run migration 008 simply cannot do closed-app digests. The client
      // leg still works, so this is a note, not a failure.
      console.warn("Digest preference not synced:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("Digest preference not synced:", e.message || e);
    return false;
  }
}

function setMorningDigestHour(hour) {
  const value = Number(hour);
  if (!Number.isInteger(value) || value < 0 || value > 23) return;
  writeMorningDigestSettings({ hour: value, lastSentOn: "" });
  renderMorningDigestSettings();
}

/* ---------- birthday reminders ----------

   A birthday is the one date in the app that arrives whether or not anyone looks. The Coming up
   card is pull-based like everything else here, so a person who never opens the app on the day
   simply never finds out. This is the single reminder that earns its place without a due date the
   person set.

   The same three rules as the digest apply, for the same reason — a notification people cannot
   silence is one they turn off entirely, taking the reminders with it:

     opt in        off until asked for, and remembered across restarts
     say little    a name and a date, never a list
     stay quiet    nothing today means nothing sent

   It rides the same beats as the digest (startup, every 30s, wake, network return) rather than
   arming a timer that a year-long setTimeout cannot represent. Each birthday is delivered once,
   keyed by the person and the date it was sent for, so a phone that was asleep at 9am catches up
   on the next beat and a device that was online does not send it twice. */

const BIRTHDAY_REMINDER_KEY = "everything_birthday_reminders_v1";
const BIRTHDAY_REMINDER_HOUR = 9;
const BIRTHDAY_REMINDER_MAX_NAMES = 3;

function readBirthdayReminderSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(BIRTHDAY_REMINDER_KEY) || "{}") || {};
  } catch (error) {
    saved = {};
  }
  if (typeof saved !== "object" || Array.isArray(saved)) saved = {};
  return {
    enabled: saved.enabled === true,
    // Which anniversaries have already been delivered. Keyed "personId:YYYY-MM-DD" so the same
    // person is not greeted twice for one birthday, and is greeted again a year later.
    sent: saved.sent && typeof saved.sent === "object" && !Array.isArray(saved.sent) ? saved.sent : {},
  };
}

function writeBirthdayReminderSettings(patch) {
  const next = { ...readBirthdayReminderSettings(), ...patch };
  try {
    localStorage.setItem(BIRTHDAY_REMINDER_KEY, JSON.stringify(next));
  } catch (error) {
    /* Private mode: today's reminder still sends, it just cannot remember that it did. */
  }
  return next;
}

/* Everyone whose birthday is today, oldest record first so the order is stable across reloads.
   Uses the same daysUntilAnnual the Coming up card uses, so a reminder can never disagree with
   the card about whose birthday it is — including 29 February, which the card celebrates on the
   28th in a common year and this must celebrate on exactly the same day. */
function birthdaysToday(from) {
  const at = new Date(from || Date.now());
  return (state.people || [])
    .filter((person) => {
      if (!person.birthday) return false;
      return daysUntilAnnual(person.birthday, at.getTime()) === 0;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

let birthdayReminderInFlight = false;

async function deliverBirthdayReminder(reason) {
  const settings = readBirthdayReminderSettings();
  if (!settings.enabled) return { sent: false, why: "not switched on" };
  if (birthdayReminderInFlight) return { sent: false, why: "already sending" };
  if (!notificationSupported() || Notification.permission !== "granted") {
    return { sent: false, why: "notifications are not permitted on this device" };
  }

  const today = localDayKey();
  const due = birthdaysToday().filter((person) => !settings.sent[`${person.id}:${today}`]);
  // Nothing today is the common case by far, and it is deliberately not recorded: an entry written
  // for "nothing" would be indistinguishable from a delivery that happened, and a birthday added
  // at 10am would then never be greeted at all.
  if (!due.length) return { sent: false, why: "no birthdays today" };

  birthdayReminderInFlight = true;
  try {
    const named = due.slice(0, BIRTHDAY_REMINDER_MAX_NAMES);
    const rest = due.length - named.length;
    const firstName = String(named[0].name).split(/\s+/)[0];
    const title = due.length === 1 ? `${firstName}'s birthday is today` : `${due.length} birthdays today`;
    const body =
      named.length === 1
        ? importantDateLabel({ days: 0, years: named[0].ownBirthday ? yearsSinceBirth(named[0].birthday) : null })
        : named.map((p) => String(p.name).split(/\s+/)[0]).join(" · ") + (rest > 0 ? ` · and ${rest} more` : "");

    const shown = await showLocalNotification(title, {
      body,
      tag: "everything-birthday-reminder",
      renotify: true,
      requireInteraction: false,
      timestamp: Date.now(),
      data: { url: "./?view=people" },
      actions: [{ action: "open", title: "Open" }],
    });

    if (shown) {
      // Only what actually went out is recorded, so a person who dismissed one is not owed it again
      // on the next 30s tick.
      const sent = { ...settings.sent };
      named.forEach((person) => {
        sent[`${person.id}:${today}`] = Date.now();
      });
      writeBirthdayReminderSettings({ sent });
    }
    return { sent: shown, why: shown ? "sent" : "the notification could not be shown" };
  } finally {
    birthdayReminderInFlight = false;
  }
}

/* The catch-up, on the same beats as the digest. Before the chosen hour it stays quiet — unlike the
   digest, a birthday genuinely does not need catching up at 2am, and the morning is hours away. */
function checkBirthdayReminder(reason) {
  const settings = readBirthdayReminderSettings();
  if (!settings.enabled) return;

  const now = new Date();
  if (now.getHours() < BIRTHDAY_REMINDER_HOUR) return;
  const today = localDayKey(now);
  if (!birthdaysToday(now).some((person) => !settings.sent[`${person.id}:${today}`])) return;

  deliverBirthdayReminder(reason || "check");
}

function setBirthdayReminderEnabled(enabled) {
  // Switching on clears the record of what was sent, so a birthday greeted under the old setting is
  // greeted again under this one rather than being swallowed by stale local state.
  writeBirthdayReminderSettings({ enabled: !!enabled, sent: {} });
  renderBirthdayReminderSettings();
  if (enabled) checkBirthdayReminder("enabled");
}

function renderBirthdayReminderSettings() {
  const settings = readBirthdayReminderSettings();
  const label = document.getElementById("birthdayToggleLabel");
  if (label) label.textContent = settings.enabled ? "On" : "Off";

  const status = document.getElementById("birthdayStatusLine");
  if (!status) return;

  if (!settings.enabled) {
    status.textContent = "Off. Birthdays still appear in Coming up — nothing is sent.";
    return;
  }
  if (!notificationSupported() || Notification.permission !== "granted") {
    status.textContent =
      "On, but this device has not allowed notifications, so nothing can be sent. Turn them on above.";
    return;
  }
  const due = birthdaysToday();
  status.textContent = due.length
    ? `On. Today it would say: "${due.length === 1 ? "a birthday is today" : due.length + " birthdays today"}". One message per person, once a year.`
    : "On. No birthday today, so it will stay silent today.";
}

function toggleBirthdayReminder() {
  setBirthdayReminderEnabled(!readBirthdayReminderSettings().enabled);
}

/* The settings copy answers the only two questions that matter — is it on, and what will it
   actually say — because "a daily notification" with no stated content is how a feature gets
   switched off in week one and never turned back on. */
function renderMorningDigestSettings() {
  const settings = readMorningDigestSettings();
  const label = document.getElementById("digestToggleLabel");
  if (label) label.textContent = settings.enabled ? "On" : "Off";

  const select = document.getElementById("digestHourSelect");
  if (select && !select.options.length) {
    for (let hour = 0; hour < 24; hour += 1) {
      const option = document.createElement("option");
      option.value = String(hour);
      option.textContent = `${String(hour).padStart(2, "0")}:00`;
      select.appendChild(option);
    }
  }
  if (select) select.value = String(settings.hour);

  const status = document.getElementById("digestStatusLine");
  if (!status) return;

  if (!settings.enabled) {
    status.textContent = "Off. Everything still works as it does now — nothing is sent.";
    return;
  }
  if (!notificationSupported() || Notification.permission !== "granted") {
    status.textContent =
      "On, but this device has not allowed notifications, so nothing can be sent. Turn them on above.";
    return;
  }
  const digest = buildMorningDigest();
  status.textContent = digest
    ? `On. Today it would say: "${digest.title} — ${digest.body}". One message a day, never more.`
    : "On. There is nothing that needs you today, so it will stay silent today.";
}

function toggleMorningDigest() {
  const settings = readMorningDigestSettings();
  setMorningDigestEnabled(!settings.enabled);
}

/* "See what it would say" shows a real notification using the real text, without sending today's
   digest and without marking today as done — so it can be tried at any hour, as often as needed. */
async function previewMorningDigest() {
  const digest = buildMorningDigest();
  if (!digest) {
    const status = document.getElementById("digestStatusLine");
    if (status) {
      status.textContent =
        "Nothing to report right now — which is exactly when a real digest would say nothing too.";
    }
    return;
  }
  if (!(await requestNotificationPermission())) {
    const status = document.getElementById("digestStatusLine");
    if (status) status.textContent = "Notifications are blocked for Everything, so there is nothing to preview.";
    return;
  }
  await showLocalNotification(digest.title, {
    body: `${digest.body}  ·  (preview)`,
    tag: "everything-morning-digest-preview",
    data: { url: digest.url, digest: true },
    actions: [{ action: "open", title: "Open" }],
  });
  renderMorningDigestSettings();
}


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
  // The digest rides on the same beats, so it needs no timer of its own and cannot drift out of
  // step with the reminders it sits beside. The birthday reminder rides there too, for the same
  // reason — it is an annual event, not a date an armed timer can be set for a year ahead.
  checkMorningDigest(reason);
  checkBirthdayReminder(reason);

  const now = Date.now();

  currentItems().forEach((item) => {
    const time = itemReminderTime(item);
    if (time === null || time > now) return;
    if (now - time > REMINDER_GRACE_MS) return;
    deliverItemReminder(item, { missed: now - time > 60000, reason });
  });

  // A recurring series whose date passed has to roll forward, or it never comes back. This is the
  // only beat that is guaranteed to run on load, on every 30s tick, and when the tab wakes, so it
  // is where a series gets a chance to advance even if the app was closed through the whole date.
  // The sweep is debounced and does no work once the series is current, so riding along here is
  // free. Not awaited: a reminder must not wait on a database write.
  rollForwardRecurringSeries();
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
  const openView = params.get("view");

  if (!action && !openItemId && !openView) return;

  params.delete("notifAction");
  params.delete("itemId");
  params.delete("item");
  params.delete("view");

  const query = params.toString();
  history.replaceState(
    {},
    "",
    window.location.pathname + (query ? "?" + query : "") + window.location.hash,
  );

  if (action && actionItemId) handleNotificationAction(action, actionItemId);
  else if (openItemId && typeof openPanel === "function") openPanel(openItemId);
  // The digest opens Today, where everything it lists already lives. Guarded on a real view name,
  // because this comes out of a URL and switchView writes to history.
  else if (openView && typeof switchView === "function" && /^[a-z-]+$/.test(openView)) {
    switchView(openView);
  }
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
