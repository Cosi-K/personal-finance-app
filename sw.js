/* PayStamp app (service worker), v4.3.1.
   Keeps everything PayStamp needs to open on this device, so it works with no signal:
   the page itself, the app code (/app-4.3.1.js), the fonts, the Supabase library (/supabase.js) and the app icons.
   - Pages: tries the internet first (so a new version shows straight away), but gives up after a few
     seconds on a weak signal and opens the copy kept here instead.
   - Other PayStamp files: opened from the copy kept here, and quietly refreshed in the background.
   Your plan isn't stored here: the page keeps its own copy on the device and sends changes when it can.
   Requests to other sites (Supabase, Lemon Squeezy) are left alone. */
var CACHE = 'paystamp-app-4.3.1';
// v4.3: the app code and the fonts are their own files now (so the home page opens faster); they're kept here too, for offline.
var SHELL = ['/', '/app-4.3.1.js', '/fonts/besley-400.woff2', '/fonts/besley-700.woff2', '/fonts/hanken-grotesk.woff2', '/supabase.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/privacy.html', '/terms.html'];

self.addEventListener('install', function (e) {
  // Each file on its own, so one missing file can't stop the rest being kept.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return fetch(u, { cache: 'reload' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromNetworkOrCopy(req, key) {
  return new Promise(function (resolve) {
    var done = false;
    var useCopy = function () { caches.match(key).then(function (hit) { if (!done && hit) { done = true; resolve(hit); } }); };
    var timer = setTimeout(useCopy, navigator.onLine === false ? 0 : 1500);   // v4.1: no or weak signal: open the copy almost at once
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      if (!done) { done = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      caches.match(key).then(function (hit) { if (!done) { done = true; resolve(hit || new Response('<!doctype html><meta charset="utf-8"><title>PayStamp</title><p style="font:16px system-ui;padding:24px">PayStamp needs an internet connection the first time it opens on this device.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })); } });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Every PayStamp address opens the same app page (/, /#debt, /?pro=thanks and so on).
    var key = url.pathname === '/privacy.html' ? '/privacy.html' : '/';
    e.respondWith(fromNetworkOrCopy(req, key));
    return;
  }
  // Other PayStamp files: the copy kept here straight away, refreshed in the background.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
    if (hit) { net.catch(function () {}); return hit; }
    return net;
  }));
});
