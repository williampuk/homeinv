/**
 * Find My Item service worker.
 *
 * The legacy UI remains in app.js. For controlled pages, the service worker
 * returns a deterministic concatenation of app.js and the protocol-v3 modules
 * so overrides are installed synchronously before DOMContentLoaded.
 */
const CACHE_VERSION = 'v6-sync3-review2';
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
  './sync-v3-import-adapter.js',
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
          return fetch(url, { mode: 'no-cors' }).then(function(response) {
            if (response.ok || response.type === 'opaque') return cache.put(url, response);
          }).catch(function() {});
        }));
      });
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) {
        return key.indexOf('fmi-') === 0 &&
          key !== APP_SHELL_CACHE && key !== STATIC_CACHE && key !== CDN_CACHE;
      }).map(function(key) {
        return caches.delete(key);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

function networkThenCache(request, cacheName) {
  return fetch(request).then(function(response) {
    if (response && response.ok) {
      caches.open(cacheName).then(function(cache) {
        cache.put(request, response.clone());
      });
      return response;
    }
    throw new Error('Network response unavailable');
  }).catch(function() {
    return caches.match(request);
  });
}

function getScriptText(path) {
  var request = new Request(path, { method: 'GET', credentials: 'same-origin' });
  return networkThenCache(request, APP_SHELL_CACHE).then(function(response) {
    if (!response) throw new Error(path + ' unavailable');
    return response.text();
  });
}

function bundledAppResponse() {
  return Promise.all([
    getScriptText('./app.js'),
    getScriptText('./sync-v3-core.js'),
    getScriptText('./sync-v3.js'),
    getScriptText('./sync-v3-import-adapter.js')
  ]).then(function(parts) {
    var source = parts[0] +
      '\n;/* bundled sync-v3-core.js */\n' + parts[1] +
      '\n;/* bundled sync-v3.js */\n' + parts[2] +
      '\n;/* bundled sync-v3-import-adapter.js */\n' + parts[3] + '\n';
    return new Response(source, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    });
  }).catch(function(error) {
    return new Response('console.error(' + JSON.stringify('[SW] Application bundle unavailable: ' + error.message) + ');', {
      status: 503,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
    });
  });
}

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.protocol === 'chrome-extension:') return;

  if (url.origin === self.location.origin && /\/app\.js$/.test(url.pathname)) {
    event.respondWith(bundledAppResponse());
    return;
  }

  if (CDN_URLS.some(function(cdn) {
    return url.href.indexOf(cdn) === 0 ||
      url.href.replace(/@[\d.]+/g, '').indexOf(cdn.replace(/@[\d.]+/g, '')) === 0;
  })) {
    event.respondWith(caches.match(event.request).then(function(cached) {
      var network = fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          caches.open(CDN_CACHE).then(function(cache) {
            cache.put(event.request, response.clone());
          });
        }
        return response;
      }).catch(function() {
        return cached;
      });
      return cached || network;
    }));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(function(response) {
      if (response && response.ok) {
        caches.open(APP_SHELL_CACHE).then(function(cache) {
          cache.put('./index.html', response.clone());
        });
      }
      return response;
    }).catch(function() {
      return caches.match('./index.html').then(function(cached) {
        if (cached) return cached;
        return caches.match('./').then(function(root) {
          return root || new Response('Offline', { status: 503 });
        });
      });
    }));
    return;
  }

  if (APP_SHELL.some(function(path) {
    return url.pathname.endsWith(path.replace('./', ''));
  })) {
    event.respondWith(caches.match(event.request).then(function(cached) {
      return cached || networkThenCache(event.request, APP_SHELL_CACHE);
    }));
    return;
  }

  event.respondWith(caches.match(event.request).then(function(cached) {
    var network = fetch(event.request).then(function(response) {
      if (response && response.ok) {
        caches.open(STATIC_CACHE).then(function(cache) {
          cache.put(event.request, response.clone());
        });
      }
      return response;
    }).catch(function() {
      return cached;
    });
    return cached || network;
  }));
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
