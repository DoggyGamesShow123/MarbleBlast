/* src/sw.js — Offline caching + "no leaderboard", but allow level/assets loading */

const CACHE_VERSION = 'mbw-v3';                 // bump to force clients to refresh
const PRECACHE = `${CACHE_VERSION}-pre`;
const RUNTIME  = `${CACHE_VERSION}-rt`;

/**
 * Block only leaderboard-related endpoints (any HTTP method).
 * Do NOT block generic /server or /api routes so resources can still load.
 * Adjust or add patterns if your Network tab shows different paths.
 */
const BLOCKED_PATHS = [
  /\/leaderboard\b/i,
  /\/scores?\b/i,
  /\/submit(-score)?\b/i,
  /\/top-?times?\b/i
];

/** Core files to precache for first load + offline shell */
const CORE = [
  './',                // keep relative for GitHub Pages subpath hosting
  './index.html',
  './manifest.json',
  './js/bundle.js',
  './favicon.ico'
];

/* ---------- Install / Activate ---------- */

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // Use cache:'reload' so we bypass any transient HTTP cache
      await cache.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
      await self.skipWaiting();
    })().catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n !== PRECACHE && n !== RUNTIME)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ---------- Fetch ---------- */

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Block leaderboard endpoints completely (for ANY method).
  if (BLOCKED_PATHS.some(rx => rx.test(url.pathname))) {
    event.respondWith(
      new Response(JSON.stringify({ ok: false, disabled: true, offline: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    return;
  }

  // For non-GET requests (that aren't blocked), let them pass through untouched.
  if (req.method !== 'GET') return;

  // 2) Same-origin requests
  if (url.origin === self.location.origin) {
    // Treat navigation/documents as network-first so updates show quickly,
    // with a fallback to cached shell (index.html) while offline.
    if (req.mode === 'navigate' || req.destination === 'document' || req.destination === '') {
      event.respondWith(networkFirstWithFallbackToShell(req));
      return;
    }

    // Static assets (scripts, styles, images, audio, fonts, etc.): cache-first
    event.respondWith(cacheFirstRuntime(req));
    return;
  }

  // 3) Cross-origin requests: network-first (then cached fallback)
  event.respondWith(networkFirstRuntime(req));
});

/* ---------- Strategies ---------- */

async function networkFirstWithFallbackToShell(request) {
  try {
    const fresh = await fetch(request);
    const rt = await caches.open(RUNTIME);
    rt.put(request, fresh.clone());
    return fresh;
  } catch {
    // try runtime cache, then the shell
    const cached = await caches.match(request);
    return cached || caches.match('./index.html');
  }
}

async function cacheFirstRuntime(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    const rt = await caches.open(RUNTIME);
    rt.put(request, fresh.clone());
    return fresh;
  } catch {
    // last resort: shell for same-origin doc requests; otherwise empty
    return (request.destination === 'document')
      ? (await caches.match('./index.html'))
      : new Response('', { status: 204 });
  }
}

async function networkFirstRuntime(request) {
  try {
    const fresh = await fetch(request, { mode: request.mode || 'cors' });
    const rt = await caches.open(RUNTIME);
    rt.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 204 });
  }
}
