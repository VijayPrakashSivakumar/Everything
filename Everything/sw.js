const CACHE_NAME = 'everything-shell-v2';

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
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    );

    await self.clients.claim();
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

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'Everything',
      {
        body: data.body || 'You have a task due.',
        icon: data.icon || './icon.svg',
        tag: data.tag || 'everything-due',
        data: {
          url: data.url || './'
        }
      }
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url || './';

  event.waitUntil((async () => {
    const clientList = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientList) {
      if ('focus' in client) {
        client.navigate(url);
        return client.focus();
      }
    }

    if (clients.openWindow) {
      return clients.openWindow(url);
    }
  })());
});
