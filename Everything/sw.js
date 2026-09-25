const CACHE_NAME = 'everything-shell-v11';

/* Tiny persistent store for the reminder schedule. Cache Storage is used because it is
   available to the service worker at any time (unlike page memory), so a reminder armed
   while the app was open can still fire after the app is closed, backgrounded or offline. */
const REMINDER_CACHE = 'everything-reminders-v1';
const REMINDER_KEY = './__reminder-store__';
const MAX_TIMEOUT = 2147483000; // setTimeout() ceiling (~24.8 days)
const MISSED_AFTER_MS = 60000; // overdue by more than a minute means we were not running

let reminderTimers = new Map(); // reminder id -> timeout handle
let rearmTimer = null;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon.svg'
];

/* Cross-origin libraries. Cached best-effort so the shell still boots offline. */
const VENDOR_FILES = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chrono-node@1/dist/chrono.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(SHELL_FILES);

    // Never let a flaky CDN break the install.
    await Promise.all(VENDOR_FILES.map(async url => {
      try {
        await cache.add(new Request(url, { mode: 'cors' }));
      } catch (e) { /* offline or blocked — the network-first path covers us later */ }
    }));
  })());

  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== REMINDER_CACHE).map(k => caches.delete(k))
    );

    await self.clients.claim();

    // The browser may have stopped us while reminders were pending — deliver them now.
    await checkMissedReminders();
  })());
});

function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return request.method === 'GET' && accept.includes('text/html');
}

function isApiRequest(request) {
  try {
    return new URL(request.url).pathname.startsWith('/api/');
  } catch (e) {
    return false;
  }
}

/* App shell: network first, so a new deploy is picked up immediately,
   falling back to the cached copy when offline. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);

    if (response && response.ok) cache.put(request, response.clone());

    return response;
  } catch (e) {
    const cached = await cache.match(request);

    return cached || cache.match('./index.html');
  }
}

/* Static assets: serve from cache instantly, refresh in the background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(response => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone());
      }

      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const response = await network;

  if (response) return response;
  if (isNavigationRequest(request)) return cache.match('./index.html');

  return Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;

  // Never intercept writes (e.g. POST /api/ask) or API traffic.
  if (request.method !== 'GET') return;
  if (isApiRequest(request)) return;

  event.respondWith(
    isNavigationRequest(request)
      ? networkFirst(request)
      : staleWhileRevalidate(request)
  );
});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  // A push that belongs to an item replaces whatever we already have for that item,
  // so a reminder delivered locally while offline is never shown twice.
  const reminder = normalizeReminder(data.reminder || {
    id: data.itemId || data.tag || 'push-' + Date.now(),
    title: data.title || 'Everything',
    body: data.body || 'You have a task due.',
    url: data.url || './',
    priority: data.priority || '',
    time: data.timestamp || Date.now()
  });

  event.waitUntil((async () => {
    if (reminder) {
      await cancelReminder(reminder.id);
      await deliverReminder(reminder, !!data.missed);
      return;
    }

    await self.registration.showNotification(data.title || 'Everything', {
      body: data.body || 'You have a task due.',
      icon: data.icon || './icon.svg',
      badge: './icon.svg',
      tag: data.tag || 'everything-due',
      renotify: true,
      data: { url: data.url || './' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const data = event.notification.data || {};
  const action = event.action || 'open';
  const url = data.url || './';

  event.waitUntil(handleNotificationAction(action, data, url));
});

/* Open / Done / Snooze share one path. When the app is already running we hand the
   action to the page (which can save it — even offline, it queues to Supabase on the
   next sync). When it is not running we open it with the same intent in the URL. */
async function handleNotificationAction(action, data, url) {
  if (action === 'open') return focusOrOpen(url);

  const client = await firstWindowClient();

  if (client) {
    client.postMessage({
      type: 'NOTIFICATION_ACTION',
      action,
      itemId: data.itemId || null
    });

    return 'focus' in client ? client.focus() : undefined;
  }

  const intent = new URL(url, self.location.origin);
  intent.searchParams.set('notifAction', action);
  if (data.itemId) intent.searchParams.set('itemId', data.itemId);

  return self.clients.openWindow(intent.toString());
}

async function focusOrOpen(url) {
  const client = await firstWindowClient();

  if (client) {
    if ('navigate' in client) client.navigate(url);
    return 'focus' in client ? client.focus() : undefined;
  }

  return self.clients.openWindow(url);
}

async function firstWindowClient() {
  try {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return list[0] || null;
  } catch (e) {
    return null;
  }
}
/* ---------- end of notification click routing ---------- */

/* ============================================================
   REMINDER ENGINE (offline first)
   The page posts the whole schedule here. We keep it in Cache Storage, arm real
   timers, and deliver through one shared path whether the trigger was a push, a
   timer, or the app coming back online after being offline.
   ============================================================ */

async function readStore() {
  try {
    const cache = await caches.open(REMINDER_CACHE);
    const res = await cache.match(REMINDER_KEY);
    if (!res) return { scheduled: [], delivered: [] };
    const data = await res.json();
    return {
      scheduled: Array.isArray(data.scheduled) ? data.scheduled : [],
      delivered: Array.isArray(data.delivered) ? data.delivered : []
    };
  } catch (e) {
    return { scheduled: [], delivered: [] };
  }
}

async function writeStore(store) {
  try {
    const cache = await caches.open(REMINDER_CACHE);
    await cache.put(
      REMINDER_KEY,
      new Response(JSON.stringify(store), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch (e) { /* storage unavailable — timers still work for this session */ }
}

function normalizeReminder(input) {
  if (!input || !input.id) return null;
  const time = Number(input.time);
  if (!Number.isFinite(time)) return null;
  return {
    id: String(input.id),
    title: input.title || 'Reminder',
    body: input.body || '',
    url: input.url || './',
    priority: input.priority || '',
    time,
    kind: input.kind || ''
  };
}

async function storeReminders(list) {
  const normalized = (list || []).map(normalizeReminder).filter(Boolean);
  const store = await readStore();
  store.scheduled = normalized;
  await writeStore(store);
  await armTimers(true);
}

async function upsertReminder(reminder) {
  const item = normalizeReminder(reminder);
  if (!item) return;
  const store = await readStore();
  store.scheduled = store.scheduled.filter(r => r.id !== item.id);
  store.scheduled.push(item);
  await writeStore(store);
  await armTimers(true);
}

async function cancelReminder(id) {
  const key = String(id);
  const store = await readStore();
  const before = store.scheduled.length;
  store.scheduled = store.scheduled.filter(r => r.id !== key);
  if (store.scheduled.length !== before) await writeStore(store);

  const handle = reminderTimers.get(key);
  if (handle) {
    clearTimeout(handle);
    reminderTimers.delete(key);
  }
}

function clearTimers() {
  reminderTimers.forEach(handle => clearTimeout(handle));
  reminderTimers.clear();
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
}

async function armTimers(reset) {
  if (reset) clearTimers();

  const store = await readStore();
  const now = Date.now();
  let furthest = 0;

  store.scheduled.forEach(reminder => {
    if (reminderTimers.has(reminder.id)) return;

    const delay = reminder.time - now;

    if (delay <= 0) {
      // Already due: deliver now and mark it missed when we clearly were not around.
      deliverReminder(reminder, now - reminder.time > MISSED_AFTER_MS);
      return;
    }

    if (delay > MAX_TIMEOUT) {
      // Too far away for one timer — re-arm later, the stored schedule stays intact.
      furthest = Math.max(furthest, reminder.time);
      return;
    }

    reminderTimers.set(
      reminder.id,
      setTimeout(() => {
        reminderTimers.delete(reminder.id);
        deliverReminder(reminder, false);
      }, delay)
    );
  });

  if (furthest) rearmTimer = setTimeout(() => armTimers(true), MAX_TIMEOUT);
}

async function checkMissedReminders() {
  const store = await readStore();
  const now = Date.now();

  for (const reminder of [...store.scheduled]) {
    if (reminder.time - now <= 0) await deliverReminder(reminder, true);
  }

  await armTimers(true);
}

async function postToClients(message) {
  try {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach(client => client.postMessage(message));
  } catch (e) { /* nothing listening */ }
}
/* ---------- reminder delivery ---------- */

function notificationOptions(reminder, missed) {
  const urgent = reminder.priority === 'urgent' || reminder.priority === 'high';

  return {
    body: (missed ? 'Missed while you were away · ' : '') +
      (reminder.body || 'Tap to open Everything'),
    icon: './icon.svg',
    badge: './icon.svg',
    tag: 'item-' + reminder.id, // one live notification per item — never a stack
    renotify: true,
    requireInteraction: urgent,
    timestamp: reminder.time,
    vibrate: urgent ? [220, 110, 220] : [140],
    data: {
      url: reminder.url,
      itemId: reminder.id,
      missed: !!missed,
      time: reminder.time
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'done', title: 'Done' },
      { action: 'snooze', title: 'Snooze 10m' }
    ]
  };
}

/* Single delivery path for timers, catch-up and pushes. The delivery is also recorded
   so the page can reconcile items.notified even when it was closed at the time. */
async function deliverReminder(reminder, missed) {
  const store = await readStore();
  store.scheduled = store.scheduled.filter(r => r.id !== reminder.id);
  store.delivered = [
    { id: reminder.id, at: Date.now(), missed: !!missed },
    ...(store.delivered || []).filter(d => d.id !== reminder.id)
  ].slice(0, 50);
  await writeStore(store);

  const handle = reminderTimers.get(reminder.id);
  if (handle) {
    clearTimeout(handle);
    reminderTimers.delete(reminder.id);
  }

  try {
    await self.registration.showNotification(
      (missed ? 'Missed: ' : '') + reminder.title,
      notificationOptions(reminder, missed)
    );
  } catch (e) {
    await postToClients({
      type: 'REMINDER_FAILED',
      reminder,
      error: String((e && e.message) || e)
    });
    return;
  }

  await postToClients({ type: 'REMINDER_DELIVERED', reminder, missed: !!missed });
}

self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SYNC_REMINDERS') {
    event.waitUntil(storeReminders(data.reminders));
    return;
  }

  if (data.type === 'SCHEDULE_REMINDER') {
    event.waitUntil(upsertReminder(data.reminder));
    return;
  }

  if (data.type === 'CANCEL_REMINDER') {
    event.waitUntil(cancelReminder(data.id));
    return;
  }

  if (data.type === 'CHECK_REMINDERS') {
    event.waitUntil(checkMissedReminders());
    return;
  }

  if (data.type === 'READ_DELIVERIES') {
    event.waitUntil((async () => {
      const store = await readStore();
      await postToClients({
        type: 'REMINDER_DELIVERIES',
        deliveries: store.delivered || []
      });
    })());
    return;
  }

  if (data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(data.title || 'Everything', {
        body: data.body || 'Test notification — reminders are working.',
        icon: './icon.svg',
        badge: './icon.svg',
        tag: data.tag || 'everything-test',
        data: { url: data.url || './' },
        actions: [{ action: 'open', title: 'Open' }]
      })
    );
  }
});

/* Best effort: Chrome can wake the worker periodically for installed PWAs, which lets
   a phone that was offline deliver its pending reminders without opening the app. */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'everything-reminders') {
    event.waitUntil(checkMissedReminders());
  }
});
