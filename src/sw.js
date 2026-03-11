/* src/sw.js — Offline + "no leaderboard" service worker */

const CACHE_VERSION = 'mbw-v1';
const PRECACHE = `${CACHE_VERSION}-precache`;
const RUNTIME = `${CACHE_VERSION}-runtime`;

/**
 * Paths we want to block (no leaderboard, no score submissions).
 * Adjust if your console shows different endpoints.
 */
const BLOCKED_PATHS = [
  /leaderboard/i,
  /scores?/i,
  /submit/i,
  /api/i,
  /server/i
];

/**
 * Core files to precache. Adjust names if your bundle differs.
 * The bundle produced by "npm run bundle" writes to dist/ with index.html + bundle.js
 * per upstream docs.
 */
const CORE = [
  './',            // GitHub Pages will serve subpath; relative scope is important
  './index.html',
  './manifest.json',
  './bundle.js',
  './favicon.ico'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(PRECACHE).then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => ![PRECACHE, RUNTIME].includes(n))
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Only handle GETs
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Block leaderboard / API attempts entirely with a stub response.
  if (BLOCKED_PATHS.some(rx => rx.test(url.pathname))) {
    event.respondWith(
      new Response(JSON.stringify({ ok: false, disabled: true, offline: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    return;
  }

  // Same-origin: cache-first for static assets; network-first for documents.
  if (url.origin === location.origin) {
    const dest = req.destination; // 'document' | 'script' | 'style' | 'image' | 'audio' | 'font' | 'worker' | '' …

    // Documents: try network, fall back to cache (so updates show up quickly).
    if (dest === 'document' || dest === '') {
      event.respondWith((async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(RUNTIME);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(req);
          return cached || caches.match('./index.html');
        }
      })());
      return;
    }

    // Static assets: cache-first; populate runtime cache on miss.
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(RUNTIME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        // last resort: offline fallback to index
        return caches.match('./index.html');
      }
    })());
    return;
  }

  // Cross-origin (e.g., fonts, music CDN): network-first with cache fallback
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { mode: 'cors' });
      const cache = await caches.open(RUNTIME);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(req);
      return cached || new Response('', { status: 204 });
    }
  })());
});
