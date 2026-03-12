/* src/sw.js — Final: bypass server level loading, use local missions, no leaderboard */

const CACHE_VERSION = 'mbw-final-v1';
const PRECACHE = `${CACHE_VERSION}-pre`;
const RUNTIME  = `${CACHE_VERSION}-rt`;

/* ------------- CONFIG (edit these if your folders differ) ------------- */

/** Return your site’s base path (important for GitHub Pages project sites). */
function basePath() {
  const scope = new URL(self.registration.scope);
  return scope.pathname.endsWith('/') ? scope.pathname : scope.pathname + '/';
}

/** Rewrite rules mapping /server/* or /api/* to local static paths. */
const REWRITE_RULES = [
  // Example: /server/assets/...  -> ./assets/...
  { match: /^server\/assets\//i, to: (rest) => `./assets/${rest}` },
  // Example: /server/data/...    -> ./assets/data/...
  { match: /^server\/data\//i,   to: (rest) => `./assets/data/${rest}` },
  // Generic fallthrough: /server/... -> ./{...}
  { match: /^server\//i,         to: (rest) => `./${rest}` },
  // Generic: /api/... -> ./{...}
  { match: /^api\//i,            to: (rest) => `./${rest}` }
];

/** Block only leaderboard endpoints (any HTTP method). */
const BLOCKED_PATHS = [
  /\/leaderboard\b/i,
  /\/scores?\b/i,
  /\/submit(-score)?\b/i,
  /\/top-?times?\b/i
];

/**
 * Local "mission library" you control.
 * Replace with the exact paths that exist in your built site (dist).
 * Start with 1–3 missions to verify; you can add more later.
 */
const LOCAL_MISSIONS = {
  version: 1,
  // Show up as MBG Beginner in the UI (names are cosmetic; paths must exist)
  categories: [
    {
      id: 'mbg-beginner',
      title: 'Marble Blast Gold - Beginner',
      missions: [
        // ✅ Replace the two example paths with real .mis files that exist in your build
        { name: 'Learning to Roll',    path: './assets/data/missions/mbg/beginner/learning_to_roll.mis' },
        { name: 'Learning to Walk',    path: './assets/data/missions/mbg/beginner/learning_to_walk.mis' }
      ]
    }
  ]
};

/** App shell files to precache (keep relative for GitHub Pages subpath) */
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './js/bundle.js',
  './favicon.ico'
];

/* -------------------------- INSTALL / ACTIVATE ------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    await cache.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== PRECACHE && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ------------------------------- FETCH -------------------------------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Block leaderboard endpoints fully (any method)
  if (BLOCKED_PATHS.some(rx => rx.test(url.pathname))) {
    event.respondWith(
      new Response(JSON.stringify({ ok: false, disabled: true, offline: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      })
    );
    return;
  }

  // Non-GETs (not blocked): pass through
  if (req.method !== 'GET') return;

  // 1) Handle "mission library" / “levels list” endpoints with local data
  //    Common patterns seen across forks (adjust/add if your console shows others)
  const pathNoBase = stripBase(url.pathname);
  if (isMissionLibraryPath(pathNoBase)) {
    event.respondWith(jsonResponse(LOCAL_MISSIONS));
    return;
  }

  // 2) Rewrite /server/* or /api/* to local static equivalents (stay in scope)
  if (/^(server|api)\//i.test(pathNoBase)) {
    const rewritten = rewriteToLocal(url);
    event.respondWith(cacheFirstRuntime(new Request(rewritten, { credentials: 'same-origin' })));
    return;
  }

  // 3) Same-origin: documents network-first, assets cache-first
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate' || req.destination === 'document' || req.destination === '') {
      event.respondWith(networkFirstWithShell(req));
    } else {
      event.respondWith(cacheFirstRuntime(req));
    }
    return;
  }

  // 4) Cross-origin: network-first with cache fallback
  event.respondWith(networkFirstRuntime(req));
});

/* ---------------------------- STRATEGIES ------------------------------- */

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
    // If an asset is missing and it was a document, fall back to shell
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

/* ----------------------------- HELPERS -------------------------------- */

function stripBase(pathname) {
  const b = basePath();
  return pathname.startsWith(b) ? pathname.slice(b.length) : pathname.replace(/^\//, '');
}

function isMissionLibraryPath(pathNoBase) {
  // Add/adjust patterns you observe in DevTools Network
  return /mission[-_]?library/i.test(pathNoBase) ||
         /^server\/missions?\b/i.test(pathNoBase) ||
         /^server\/library\b/i.test(pathNoBase) ||
         /^api\/missions?\b/i.test(pathNoBase);
}

function rewriteToLocal(url) {
  const p = stripBase(url.pathname);
  for (const rule of REWRITE_RULES) {
    const m = p.match(rule.match);
    if (m) {
      const rest = p.replace(rule.match, '');
      const relative = rule.to(rest);
      return new URL(relative, self.registration.scope).href;
    }
  }
  // default: drop /server|/api and keep the rest
  const relative = './' + p.replace(/^(server|api)\//i, '');
  return new URL(relative, self.registration.scope).href;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
