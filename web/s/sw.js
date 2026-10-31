// Offline reloads: the app's own files are fetched from the network when it answers within
// 3 s (so updates arrive at once) and from this cache when not (a venue's slow Wi-Fi). Requests to other sites (the
// Apps Script backend) are never touched.

const CACHE = 'chgk-scanner-v7';
const NETWORK_LIMIT_MS = 3000;
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
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('chgk-scanner-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  const network = fetch(event.request);
  event.waitUntil(
    network
      .then((response) =>
        response.ok ? caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())) : undefined,
      )
      .catch(() => {}),
  );
  event.respondWith(respond(event.request, network));
});

/** The network's answer if it comes soon; else this cache's copy; a page falls back to the app's own. */
async function respond(request, network) {
  const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_LIMIT_MS));
  const first = await Promise.race([network.catch(() => null), slow]);
  if (first) {
    return first;
  }
  const hit = await caches.match(request, {ignoreSearch: true});
  const page = hit || (request.mode === 'navigate' ? await caches.match('index.html') : null);
  return page || network; // nothing kept: wait for the network, or its error
}
