/* PayStamp app (service worker).
   Pages always come from the network first, so a new index.html shows up straight away.
   The last copy is kept so PayStamp still opens without signal. Your plan itself always
   loads from your account; nothing about it is stored here.
   Requests to other sites (Supabase, fonts) are left alone. */
var CACHE = 'paystamp-app-3.4.1';
var SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok && url.pathname === '/') { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put('/', copy); }); }
      return res;
    }).catch(function () { return caches.match('/'); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
});
