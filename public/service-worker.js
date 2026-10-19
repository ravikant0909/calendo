/*
 * Calendo service worker.
 *
 * Design rules (read before changing — these prevent correctness bugs):
 *  1. NEVER cache /api/* responses. Availability/bookings must always be live;
 *     a stale "free" slot served from cache could cause a double-booking. API
 *     requests are passed straight through to the network, untouched.
 *  2. Navigations (HTML) are network-first. When online the user always gets the
 *     freshest page (so new deploys apply immediately); only when the network
 *     fails do we show the offline fallback.
 *  3. Static assets (images, fonts, the embed script, the manifest) use
 *     stale-while-revalidate: fast from cache, refreshed in the background.
 *  4. Only same-origin GET requests are ever touched. Everything else is ignored.
 *  5. Bump CACHE_VERSION on any change here so old caches are purged on activate.
 */
const CACHE_VERSION = 'v2';
const CACHE = 'calendo-' + CACHE_VERSION;

// The offline fallback is fully self-contained, so precaching just this one file
// guarantees install can't partially fail. NB: we use the clean URL "/offline"
// (not "/offline.html"): Cloudflare Assets 307-redirects .html → clean URLs, and
// cache.add() must not store a redirected response, so we precache the 200 directly.
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; never interfere with POST/PUT/DELETE (logins, bookings, etc.).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only — never touch third-party requests (Google, analytics, etc.).
  if (url.origin !== self.location.origin) return;

  // RULE 1: never cache or fall back for the API. Let it hit the network as-is.
  if (url.pathname.startsWith('/api/')) return;

  // RULE 2: navigations → network-first with an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // pwa.js drives the install UX, so it must never go stale — serve it
  // network-first (fall back to cache only when offline). Otherwise
  // stale-while-revalidate would keep showing the previous version's install
  // logic for an extra load after every deploy.
  if (url.pathname === '/pwa.js') {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // RULE 3: static assets → stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          // Only cache successful, same-origin ("basic") responses.
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
