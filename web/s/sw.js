// Offline reloads: the app's own files are fetched from the network when possible (so
// updates arrive at once) and from this cache when not. Requests to other sites (the
// Apps Script backend) are never touched.

const CACHE = 'chgk-scanner-v5';
const FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  '../shared/logic.js',
  'lib/api.js',
  'lib/camera.js',
  'lib/lookup.js',
  'lib/marks.js',
  'lib/photos.js',
  'lib/photostore.js',
  'lib/payload.js',
  'lib/queue.js',
  'lib/session.js',
  'lib/storage.js',
  'ui/state.js',
  'ui/dom.js',
  'ui/setup.js',
  'ui/tournament.js',
  'ui/scan.js',
  'ui/whose.js',
  'ui/sync.js',
  'vendor/zxing-wasm-3.1.4/zxing-reader.iife.js',
  'vendor/zxing-wasm-3.1.4/zxing_reader.wasm',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, {ignoreSearch: true}).then((hit) => hit || caches.match('index.html'))),
  );
});
