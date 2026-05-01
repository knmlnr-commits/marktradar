/* MarktRadar service worker
 *
 * Strategie:
 *  - Statische shell (HTML/CSS/JS in marktradar.html zelf, icon, manifest)
 *    wordt cache-first geserveerd zodat de app snel opent én offline
 *    bruikbaar blijft als shell. Wordt versvergeleken na elke deploy via
 *    een nieuwe CACHE_VERSION.
 *  - Alle /api/-routes gaan altijd via network (no-cache) zodat tenant-
 *    state en signalen actueel zijn.
 *  - HTML-navigaties (de portal en landing) gebruiken network-first met
 *    cache-fallback. Daardoor zie je altijd verse content als je online
 *    bent en de laatst-gecachte versie als je offline bent.
 *
 * Forward-compatibility: bij een Capacitor-wrap (optie B) gebruikt de
 * native app de pagina's direct uit de bundle; deze service worker is
 * dan inactief, maar de manifest + icons + cache-strategie zijn 1:1
 * herbruikbaar als web-build target.
 */

const CACHE_VERSION = 'mr-v1';
const SHELL_CACHE = 'mr-shell-' + CACHE_VERSION;
const RUNTIME_CACHE = 'mr-runtime-' + CACHE_VERSION;

// Assets die we proactief willen cachen op install. Marktradar.html en
// index.html zijn groot maar self-contained (alle CSS+JS inline) dus
// het is voldoende om die plus icon + manifest te pre-cachen.
const SHELL_ASSETS = [
  '/',
  '/marktradar.html',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('mr-') && !k.endsWith(CACHE_VERSION))
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: altijd network, fallback naar offline-error (geen cache).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: 'Offline — verbinding herstellen om door te gaan.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // HTML-navigaties: network-first, fallback naar cache, daarna naar
  // gegooide '/' shell zodat de app altijd opent.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/marktradar.html') || caches.match('/')))
    );
    return;
  }

  // Statische assets: cache-first met netwerk-update in achtergrond.
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => null);
      return cached || networkFetch || new Response('', { status: 504 });
    })
  );
});
