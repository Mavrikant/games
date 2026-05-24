// karaman.dev/games service worker.
//
// Strategy:
//   - Precache the install entry (home + favicon + manifest) so repeat
//     visits feel instant.
//   - Cache-first for hashed Astro assets (immutable, cache-busted by
//     content hash in filename).
//   - Network-first for HTML (so new game pages and edits appear without
//     a hard refresh; falls back to cache when offline).
//   - Stale-while-revalidate for game thumbs / icons.
//
// Bump CACHE_VERSION whenever the precache list shape changes; old
// caches are deleted on `activate`.

const CACHE_VERSION = 'v2';
const PRECACHE = `karaman-games-precache-${CACHE_VERSION}`;
const RUNTIME = `karaman-games-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/games/',
  '/games/favicon.svg',
  '/games/manifest.webmanifest',
  '/games/offline.html',
];

self.addEventListener('install', (event) => {
  // Activate the updated worker as soon as it's installed so a new version
  // applies in the background. The page is NOT reloaded — clients.claim() on
  // activate lets the next navigation serve fresh content (silent update).
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== PRECACHE && k !== RUNTIME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isHashedAsset(pathname) {
  // Astro emits hashed filenames into /games/_astro/...
  return /^\/games\/_astro\//.test(pathname);
}

function isThumbOrIcon(pathname) {
  return /^\/games\/(thumbs|favicon)/.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin requests rooted under our subpath.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/games/')) return;

  // 1. Hashed Astro assets — cache-first, immutable.
  if (isHashedAsset(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(RUNTIME).then((cache) => cache.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // 2. Thumbs / icons — stale-while-revalidate.
  if (isThumbOrIcon(url.pathname)) {
    event.respondWith(
      caches.open(RUNTIME).then((cache) =>
        cache.match(req).then((cached) => {
          const fetchPromise = fetch(req)
            .then((res) => {
              cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        }),
      ),
    );
    return;
  }

  // 3. HTML and everything else — network-first, fall back to cache, then to
  //    the offline page for navigations that were never cached.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (cached) =>
            cached ||
            (req.mode === 'navigate'
              ? caches.match('/games/offline.html')
              : caches.match('/games/')),
        ),
      ),
  );
});
