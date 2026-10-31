// 2WaY service worker.
//
// Caches only the public app shell (HTML/CSS/JS/icons) and avatar images.
// It never caches /api/ responses or Socket.IO traffic, so private messages
// are never written to the device's cache storage.

const VERSION = 'v1.0.0';
const SHELL = `2way-shell-${VERSION}`;
const AVATARS = '2way-avatars';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/offline.html',
  '/css/app.css',
  '/js/theme.js',
  '/js/app.js',
  '/js/dom.js',
  '/js/api.js',
  '/js/rt.js',
  '/js/views/auth.js',
  '/js/views/common.js',
  '/js/views/lounge.js',
  '/js/views/lists.js',
  '/js/views/chat.js',
  '/js/views/profile.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('2way-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'signed-out') caches.delete(AVATARS);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Private data and realtime: always straight to the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname === '/healthz') return;

  // Avatars are immutable per URL: cache-first, bounded.
  if (url.pathname.startsWith('/avatars/')) {
    event.respondWith((async () => {
      const cache = await caches.open(AVATARS);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        cache.put(req, res.clone());
        cache.keys().then((keys) => { if (keys.length > 120) cache.delete(keys[0]); });
      }
      return res;
    })());
    return;
  }

  // Page loads: network first so deploys show up, cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put('/index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('/index.html')) || (await caches.match('/offline.html'));
      }
    })());
    return;
  }

  // Static assets: serve from cache instantly, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(fresh); return hit; }
    return (await fresh) || new Response('', { status: 504 });
  })());
});
