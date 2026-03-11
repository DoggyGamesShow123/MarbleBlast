/* src/sw.js — Load levels/assets from repo (rewrite /server/* -> ./*), offline cache, no leaderboard */

const CACHE_VERSION = 'mbw-v4';              // bump to force client update on deploy
const PRECACHE = `${CACHE_VERSION}-pre`;
const RUNTIME  = `${CACHE_VERSION}-rt`;

/* Block only leaderboard-related endpoints (any method). */
const BLOCKED_PATHS = [
  /\/leaderboard\b/i,
  /\/scores?\b/i,
  /\/submit(-score)?\b/i,
  /\/top-?times?\b/i
];

/* Precache your app shell. Make sure bundle path matches your HTML. */
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './js/bundle.js',
  './favicon.ico'
];

/* --- Helpers ------------------------------------------------------------- */

/** Return site base path (e.g., '/<repo>/' on GitHub Pages). */
function basePath() {
  const scope = new URL(self.registration.scope);
  return scope.pathname.endsWith('/') ? scope.pathname : scope.pathname + '/';
}

/** True if URL path begins with a site-relative prefix (ignoring basePath). */
function pathStartsWith(url, prefix) {
  const p = url.pathname.startsWith(basePath())
    ? url.pathname.slice(basePath().length)
    : url.pathname;
  return p.startsWith(prefix);
}

/** Construct a new same-origin URL resolved against the site’s base scope. */
function scopedUrl(relativePath) {
  return new URL(relativePath.replace(/^\/+/, ''), self.registration.scope).href;
}

/* --- Install / Activate -------------------------------------------------- */

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await cache.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
      await self.skipWaiting();
    })().catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n !== PRECACHE && n !== RUNTIME).map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* --- Fetch --------------------------------------------------------------- */

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  /* 1) Block leaderboard endpoints entirely (for ANY HTTP method). */
  if (BLOCKED_PATHS.some(rx => rx.test(url.pathname))) {
    event.respondWith(
      new Response(JSON.stringify({ ok: false, disabled: true, offline: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    return;
  }

  /* 2) Non-GETs (not blocked) just pass through. */
  if (req.method !== 'GET') return;

  /* 3) Same-origin request handling */
  if (url.origin === location.origin) {
    // 3a) If the app tries to go through '/server/...', rewrite to repo static:
    //     '/server/anything'  ==>  './anything'
    if (pathStartsWith(url, 'server/')) {
      const rel = url.pathname.startsWith(basePath())
        ? url.pathname.slice(basePath().length)   // strip '/<repo>/'
        : url.pathname.replace(/^\//, '');
      const stripped = rel.replace(/^server\//, '');
      const newUrl = scopedUrl('./' + stripped);   // stay within site scope
      event.respondWith(cacheFirstRuntime(new Request(newUrl, { credentials: 'same-origin' })));
      return;
    }

    // 3b) Documents: network-first with shell fallback
    if (req.mode === 'navigate' || req.destination === 'document' || req.destination === '') {
      event.respondWith(networkFirstWithShell(req));
      return;
    }

    // 3c) Static assets: cache-first
    event.respondWith(cacheFirstRuntime(req));
    return;
  }

  /* 4) Cross-origin: network-first with cached fallback */
  event.respondWith(networkFirstRuntime(req));
});

/* --- Strategies ---------------------------------------------------------- */

async function networkFirstWithShell(request) {
  try {
    const fresh = await fetch(request);
    const rt = await caches.open(RUNTIME);
    rt.put(request, fresh.clone());
    return fresh;
  } catch {
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
