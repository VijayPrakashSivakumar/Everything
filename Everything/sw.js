// Bump whenever a shell file (index.html / style.css / js/*.js) changes, otherwise returning
// phones keep serving the previous cached version and the new UI appears not to work.
const CACHE_NAME = 'everything-shell-v50';

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
  // The app logic is fifteen files in a fixed load order. All fifteen are shell: they are the app.
  // A list written by hand here would be a second copy of the order in index.html, and the two
  // would drift — leaving a part uncached, which looks like a random offline failure rather than a
  // cache miss. ui-structure.test.mjs derives this list from index.html and fails if they disagree.
  './js/core.js',
  './js/model.js',
  './js/render.js',
  './js/recurring.js',
  './js/people-projects.js',
  './js/calendar.js',
  './js/item-panel.js',
  './js/capture.js',
  './js/extraction.js',
  './js/lists.js',
  './js/search.js',
  './js/shell.js',
  './js/utils.js',
  './js/reminders.js',
  './js/init.js',
  './manifest.json',
  './icon.svg'
];

/* Cross-origin libraries. Cached best-effort so the shell still boots offline.

   These are read out of index.html during install rather than written out here, because a second
   copy of a CDN URL is a second thing to forget — and it already was one: index.html moved to a
   pinned version while this list still pointed at the old floating tag, so an offline install kept
   serving whatever the CDN happened to return that day instead of the version under test.

   Deriving them means a mismatch is impossible by construction. The shell file is fetched anyway,
   and a CDN URL that has not loaded yet is simply not precached: the network-first path still gets
   it, which is the same outcome as before this was derived. */
const VENDOR_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com'];

function vendorFilesFromHtml(html) {
  return [...html.matchAll(/<script src="(https:\/\/[^"]+)"><\/script>/g)]
    .map(m => m[1])
    .filter(url => {
      try { return VENDOR_HOSTS.includes(new URL(url).hostname); } catch { return false; }
    });
}

async function vendorFilesFromShell() {
  try {
    const res = await fetch('./index.html', { cache: 'reload' });
    if (!res.ok) return [];
    return vendorFilesFromHtml(await res.text());
  } catch {
    return [];
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(SHELL_FILES);

    // Never let a flaky CDN break the install.
    const vendorFiles = await vendorFilesFromShell();
    await Promise.all(vendorFiles.map(async url => {
      try {
        await cache.add(new Request(url, { mode: 'cors' }));
      } catch (e) { /* offline or blocked — the network-first path covers us later */ }
    }));
  })());

  self.skipWaiting();
});

/* ---------- share target ----------

   A share target receives a POST, not a navigation. A POST to a page has nowhere to render, so
   without this the share opens Everything and silently drops whatever was shared. The shared text
   is stashed in Cache Storage and the page is redirected to collect it.

   This is a second, separate fetch listener on purpose: it only ever claims a POST carrying
   `?share=1`, and everything else falls straight through to the routing below untouched. */
const SHARE_KEY = './__shared-capture__';

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'POST') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.searchParams.get('share') !== '1') return;

  event.respondWith(stashSharedCapture(request));
});

async function stashSharedCapture(request) {
  let text = '';
  let title = '';
  let link = '';
  let imageCount = 0;

  try {
    const form = await request.formData();
    text = typeof form.get('text') === 'string' ? form.get('text') : '';
    title = typeof form.get('title') === 'string' ? form.get('title') : '';
    link = typeof form.get('url') === 'string' ? form.get('url') : '';
    form.forEach((value) => {
      // A shared photo arrives as a File, not a string. It is counted, not kept: holding the bytes
      // in Cache Storage would pin a photo per share, and the capture sheet takes its own file
      // through the normal picker instead.
      if (typeof value !== 'string') imageCount += 1;
    });
  } catch (e) {
    /* A malformed share must not break the app — the page simply opens empty. */
  }

  // Title, text and link are joined so the reader sees the whole sentence. Sharing a page sends a
  // title and a URL and no text, and reading only the title would throw the link away.
  const combined = [text, title, link].filter(Boolean).join('\n');

  const cache = await caches.open(REMINDER_CACHE);
  await cache.put(
    SHARE_KEY,
    new Response(JSON.stringify({ text, title, url: link, imageCount, combined }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  // 303 so the browser follows it with a GET, as a redirect after a POST must.
  return Response.redirect('./?share=1', 303);
}

/* Deliberately NOT derived from CACHE_NAME.

   The shell cache is versioned by CACHE_NAME and must be, because the app's own assets change with
   every deploy. Tying the language pack to it would re-download 11 MB on every release - the exact
   cost this cache exists to remove - and it is the reason this line does not simply read
   `${CACHE_NAME}-ocr`.

   Nothing here changes between deploys. The pack is pinned to one immutable tessdata version, so it
   outlives the shell and is versioned by its own name instead. Cached data for older packs is left to
   be swept up by the activation handler below. */
const OCR_CACHE = 'everything-ocr-v1';

/* Caches this worker owns and must keep. OCR_CACHE is in the list deliberately: an omitted one is
   deleted on every activation, so the language pack would be re-downloaded after each deploy —
   exactly the cost the cache exists to remove. */
const KEPT_CACHES = new Set([CACHE_NAME, REMINDER_CACHE, OCR_CACHE]);

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(keys.filter((k) => !KEPT_CACHES.has(k)).map((k) => caches.delete(k)));

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

/* The shell's own files must never be served stale.

   index.html is network-first but style.css/script.js used to be stale-while-revalidate, so a
   deploy produced a mixed build for one load: new markup calling functions the old script did not
   define, styled by CSS that predated the new classes. The symptoms were a collapsed search bar
   and dead clicks. Shell files are small and few, so they are always network-first, with the
   cache kept purely as an offline fallback. */
const SHELL_PATHS = new Set(SHELL_FILES.map((file) => new URL(file, self.registration.scope).pathname));

function isShellRequest(request) {
  try {
    return SHELL_PATHS.has(new URL(request.url).pathname);
  } catch (e) {
    return false;
  }
}

/* The OCR engine's own downloads get a cache of their own, and cache-first.

   They used to go through staleWhileRevalidate like any other asset, which was wrong twice over. On
   failure that path answers Response.error() rather than a network error the page can see, and
   Tesseract cannot report the failure at all — naptha/tesseract.js#528 records that a download
   failing between createWorker and load() is uncatchable, and #851 shows it failing outright as an
   importScripts NetworkError. Either way the promise never settles and the read times out for
   reasons nobody can act on.

   And it was the wrong strategy regardless: these are large, immutable at a fixed version, and asked
   for repeatedly. So they are served from a dedicated cache first, and only reach the network the
   once. That is what makes the second read instant, which is the difference between a wait and a
   stall. This is also what replaces the IndexedDB cache that was switched off — Cache Storage is
   under our control and, unlike IndexedDB, has never hung.

   An opaque or failed response is never stored. Caching one would poison every later read with the
   same failure, which is a slower way to reach the timeout this was meant to remove. */
const OCR_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com'];

function isOcrVendorRequest(request) {
  try {
    return OCR_HOSTS.includes(new URL(request.url).hostname);
  } catch (e) {
    return false;
  }
}

/* Whether a response is worth keeping. A 200 is not enough: the language host answers a failed
   fetch with an HTML error page, and caching that turns one bad moment into a permanent one — every
   later read gets the same error page from Cache Storage and hangs at "loading language traineddata
   0%" for ever, with no way to recover short of clearing site data. That is a strictly worse outcome
   than the original failure, because the original was survivable by waiting.

   The two things that must never be stored are a non-2xx status and an opaque response, because
   neither says what the body is. Anything that is not actually the gzip it claims to be is refused
   too, which is what catches an HTML error page served with a 200. */
function isStorableVendorResponse(response) {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  // The vendor scripts are JavaScript; the language pack is gzip. A text/html body in either place is
  // an error page wearing the wrong content type.
  if (type.includes('text/html')) return false;
  return true;
}

async function cacheFirstVendor(request) {
  const cache = await caches.open(OCR_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  // A rejected fetch is left to reject: a network error is something the caller can be told about,
  // and Response.error() is what it was given before.
  const response = await fetch(request);
  if (isStorableVendorResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

/* The language packs, served same-origin from this worker.

   tesseract fetches its language data itself, from whatever `langPath` names, with no retry and no
   second chance: one failed request and the read hangs at "loading language traineddata 0%" until the
   app's timeout, 90 seconds after a request that gave up in under one. Nothing in the page can fix
   that, because the failing fetch belongs to the library and there is no hook for it.

   Pointed at this origin, the fetching happens here instead, where a mirror list, a byte-level check
   and Cache Storage are all available. Every language is tried against every mirror before the
   request is allowed to fail.

   All three mirrors were verified for all six languages by fetching the bytes and checking the gzip
   magic number rather than trusting the status code. Sizes: eng 2,952,873 · tam 1,446,167 ·
   hin 1,389,692 · tel 1,735,518 · kan 1,914,250 · mal 2,794,667.

   The projectnaptha host is deliberately absent. It serves the full-size 4.0.0 packs but not the
   _best_int ones this app asks for — measured, all six 404 there.

   The names below are the three-letter ISO 639-2 codes. They are not the two-letter tags the app
   stores: eng, not en. That distinction was the original bug, and getting it wrong here would
   reintroduce it silently, since a wrong name simply 404s. */
const OCR_LANG_MIRRORS = (code) => [
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`,
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}@1.0.0/4.0.0_best_int/${code}.traineddata.gz`,
  `https://unpkg.com/@tesseract.js-data/${code}@1.0.0/4.0.0_best_int/${code}.traineddata.gz`,
];

/* Same-origin path the app points tesseract at. tesseract appends "/<lang>.traineddata.gz" to whatever
   langPath it is given, so this must be a directory, not a file. */
const OCR_LANG_PATH = '/ocr-lang';

function isOcrLangRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname.startsWith(OCR_LANG_PATH + '/');
  } catch (e) {
    return false;
  }
}

/* Extracts the three-letter pack name from /ocr-lang/<code>.traineddata.gz.

   Only three letters are accepted, and that is deliberate rather than strict for its own sake: a
   two-letter name is the mistake this whole fix exists to correct, so it is refused here rather than
   being passed upstream to 404 on every mirror in turn. */
function ocrLangFromPath(pathname) {
  const match = /\/ocr-lang\/([a-z]{3})\.traineddata\.gz$/.exec(pathname || '');
  return match ? match[1] : null;
}

/* Fetches one language pack, trying each mirror in turn and validating the result.

   The byte-level checks are not decoration. A mirror that cannot serve the file often answers with an
   HTML error page and a 200, and handing that to tesseract produces a worker that reads garbage and
   hangs exactly as it would on a 404 — while now looking like success. The gzip magic number is the
   only thing that proves these are the bytes we asked for. */
async function fetchOcrLang(code) {
  for (const url of OCR_LANG_MIRRORS(code)) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response || !response.ok) continue;
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (type.includes('text/html')) continue;
      const body = await response.arrayBuffer();
      const head = new Uint8Array(body.slice(0, 2));
      // 0x1f 0x8b is the gzip signature. Anything else is not the file.
      if (head[0] !== 0x1f || head[1] !== 0x8b) continue;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': String(body.byteLength),
          // Same-origin, so no CORS headers are needed; no-store only stops an intermediary cache
          // from holding a pack that a later release might replace.
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      // This mirror is unreachable. The next one is tried.
    }
  }
  return null;
}

/* Cache first, because that is the whole point: the second read of a language must not touch the
   network at all. Only bytes that passed the gzip check are ever written, so a hit is always real. */
async function serveOcrLang(request) {
  const cache = await caches.open(OCR_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const code = ocrLangFromPath(new URL(request.url).pathname);
  if (!code) return new Response('Not found', { status: 404 });

  const response = await fetchOcrLang(code);
  if (!response) return new Response('Language pack unavailable', { status: 504 });

  await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;

  // Never intercept writes (e.g. POST /api/ask) or API traffic.
  if (request.method !== 'GET') return;
  if (isApiRequest(request)) return;
  if (isOcrLangRequest(request)) {
    event.respondWith(serveOcrLang(request));
    return;
  }
  if (isOcrVendorRequest(request)) {
    event.respondWith(cacheFirstVendor(request));
    return;
  }

  if (isNavigationRequest(request) || isShellRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', event => {
  // A page that detected a mixed build asks the worker to step aside so the reload is not
  // served the stale shell it just rejected.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  /* Warm the language pack so the first real read is fast rather than a multi-megabyte download.

     The page sends the three-letter pack name, not a URL and not the two-letter tag. It used to send a
     URL, checked with `startsWith('https://')` — which the same-origin URL now fails, so the warm-up
     was dropped in silence every time. It sent the two-letter tag before that, which warmed a name
     that does not exist. Only the code is accepted now, and the URL is built here from the one
     definition of it, so the warm-up and the read cannot drift apart again.

     Not waited on by the page — a failure here costs nothing, because the read simply downloads it. */
  const data = event.data || {};
  if (data.type === 'WARM_OCR_LANGUAGE' && typeof data.code === 'string' && /^[a-z]{3}$/.test(data.code)) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(OCR_CACHE);
        const url = `${self.location.origin}${OCR_LANG_PATH}/${data.code}.traineddata.gz`;
        if (await cache.match(url)) return;
        // fetchOcrLang is the same function the read path uses, so this warms exactly the bytes the
        // read will ask for and goes through the same mirror fallback and gzip validation.
        const response = await fetchOcrLang(data.code);
        if (response) await cache.put(url, response);
      } catch (e) { /* offline or blocked — the read will fetch it itself */ }
    })());
  }
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

  /* Hand the shared capture to the page exactly once. Deleting it here, before replying, is what
     makes a share single-use: without that, every reload would reopen the sheet with the same
     words, which is a very annoying way to lose a reload. */
  if (data.type === 'READ_SHARE') {
    event.waitUntil((async () => {
      const cache = await caches.open(REMINDER_CACHE);
      const hit = await cache.match(SHARE_KEY);
      let shared = null;
      if (hit) {
        try {
          shared = await hit.json();
        } catch (e) {
          shared = null;
        }
        await cache.delete(SHARE_KEY);
      }
      if (event.ports && event.ports[0]) event.ports[0].postMessage(shared);
    })());
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
