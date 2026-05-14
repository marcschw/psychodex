const APP_VERSION  = 'v5';
const APP_CACHE    = `psychodex-app-${APP_VERSION}`;
const IMAGE_CACHE  = `psychodex-images-${APP_VERSION}`;

// App shell – cached on install, updated network-first
const APP_SHELL = [
  './',
  './index.html',
  './styles/main.css',
  './src/app.js',
  './src/db.js',
  './src/achievements.js',
  './src/icd-loader.js',
  './src/xp-engine.js',
  './src/ranks.js',
  './src/missions.js',
  './src/vendor/dexie.js',
  // ICD JSON data
  './data/icd/f00.json','./data/icd/f10.json','./data/icd/f20.json',
  './data/icd/f30.json','./data/icd/f40.json','./data/icd/f50.json',
  './data/icd/f60.json','./data/icd/f70.json','./data/icd/f80.json',
  './data/icd/f90.json',
  // Category mosaic images (only 10 – worth pre-loading)
  './assets/images/categories/mosaike/f0.png',
  './assets/images/categories/mosaike/f1.png',
  './assets/images/categories/mosaike/f2.png',
  './assets/images/categories/mosaike/f3.png',
  './assets/images/categories/mosaike/f4.png',
  './assets/images/categories/mosaike/f5.png',
  './assets/images/categories/mosaike/f6.png',
  './assets/images/categories/mosaike/f7.png',
  './assets/images/categories/mosaike/f8.png',
  './assets/images/categories/mosaike/f9.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(APP_CACHE)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== APP_CACHE && k !== IMAGE_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // ── Diagnosis images: cache-first, store on miss ──────────────────────────
  if (url.pathname.startsWith('/assets/images/diagnoses/')) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(async cache => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          return new Response('', { status: 404 });
        }
      })
    );
    return;
  }

  // ── Category / rank images: cache-first ───────────────────────────────────
  if (url.pathname.startsWith('/assets/images/')) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(async cache => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          return new Response('', { status: 404 });
        }
      })
    );
    return;
  }

  // ── App shell (JS/CSS/HTML/JSON): network-first, cache fallback ───────────
  const isShell = url.pathname.endsWith('.js')
    || url.pathname.endsWith('.css')
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.json')
    || url.pathname === '/'
    || url.pathname === '/index.html';

  if (isShell) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            caches.open(APP_CACHE).then(c => c.put(request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
  }
});
