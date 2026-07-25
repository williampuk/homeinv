/**
 * Find My Item service worker.
 *
 * Protocol v3 is injected after app.js so the existing application can be
 * upgraded without duplicating the large legacy app bundle. The injection is
 * synchronous while the HTML parser is at the app.js script tag, therefore the
 * v3 functions replace the legacy sync functions before DOMContentLoaded.
 */
const CACHE_VERSION = 'v4-sync3';
const APP_SHELL_CACHE = 'fmi-shell-' + CACHE_VERSION;
const STATIC_CACHE = 'fmi-static-' + CACHE_VERSION;
const CDN_CACHE = 'fmi-cdn-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './sync-v3-core.js',
  './sync-v3.js',
  './manifest.json'
];

const CDN_URLS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return caches.open(CDN_CACHE).then(function(cache) {
        return Promise.allSettled(CDN_URLS.map(function(url) {
          return fetch(url, { mode: 'no-cors' }).then(function(resp) {
            if (resp.ok || resp.type === 'opaque') return cache.put(url, resp);
          }).catch(function() {});
        }));
      });
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) {
        return key.indexOf('fmi-') === 0 &&
          key !== APP_SHELL_CACHE && key !== STATIC_CACHE && key !== CDN_CACHE;
      }).map(function(key) { return caches.delete(key); }));
    }).then(function() { return self.clients.claim(); })
  );
});

function appJsResponse(request) {
  return fetch(request).then(function(response) {
    if (response && response.ok) {
      caches.open(APP_SHELL_CACHE).then(function(cache) { cache.put(request, response.clone()); });
      return response;
    }
    throw new Error('app.js network response unavailable');
  }).catch(function() {
    return caches.match(request);
  }).then(function(response) {
    if (!response) return new Response('throw new Error("app.js unavailable");', { headers: { 'Content-Type': 'application/javascript' } });
    return response.text().then(function(source) {
      var loader = '\n;document.write(\'<script src="./sync-v3-core.js?v=3"><\\/script><script src="./sync-v3.js?v=3"><\\/script>\');\n';
      return new Response(source + loader, {
        status: 200,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }
      });
    });
  });
}

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.protocol === 'chrome-extension:') return;

  if (url.origin === self.location.origin && /\/app\.js$/.test(url.pathname)) {
    event.respondWith(appJsResponse(event.request));
    return;
  }

  if (CDN_URLS.some(function(cdn) {
    return url.href.indexOf(cdn) === 0 || url.href.replace(/@[\d.]+/g, '').indexOf(cdn.replace(/@[\d.]+/g, '')) === 0;
  })) {
    event.respondWith(caches.match(event.request).then(function(cached) {
      var network = fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          caches.open(CDN_CACHE).then(function(cache) { cache.put(event.request, response.clone()); });
        }
        return response;
      }).catch(function() { return cached; });
      return cached || network;
    }));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(function(response) {
      if (response && response.ok) {
        caches.open(APP_SHELL_CACHE).then(function(cache) { cache.put('./index.html', response.clone()); });
      }
      return response;
    }).catch(function() {
      return caches.match('./index.html').then(function(cached) {
        return cached || caches.match('./') || new Response('Offline', { status: 503 });
      });
    }));
    return;
  }

  if (APP_SHELL.some(function(path) { return url.pathname.endsWith(path.replace('./', '')); })) {
    event.respondWith(caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        if (response && response.ok) {
          caches.open(APP_SHELL_CACHE).then(function(cache) { cache.put(event.request, response.clone()); });
        }
        return response;
      });
    }));
    return;
  }

  event.respondWith(caches.match(event.request).then(function(cached) {
    var network = fetch(event.request).then(function(response) {
      if (response && response.ok) {
        caches.open(STATIC_CACHE).then(function(cache) { cache.put(event.request, response.clone()); });
      }
      return response;
    }).catch(function() { return cached; });
    return cached || network;
  }));
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
