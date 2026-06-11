/* SonicVault service worker.
   Shell is network-first, so normal deploys propagate on the next online
   load without touching this file. Bump VERSION only when the caching
   logic itself changes and old caches must be discarded. */
var VERSION = 'v1';
var SHELL_CACHE = 'sv-shell-' + VERSION;
var STATIC_CACHE = 'sv-static-' + VERSION;
var AUDIO_CACHE = 'sv-audio-' + VERSION;
var AUDIO_MAX_ENTRIES = 30;

var SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icons/sonicvault-mark.svg',
  './assets/icons/favicon-32.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function(cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) {
        return key.indexOf('sv-') === 0 && [SHELL_CACHE, STATIC_CACHE, AUDIO_CACHE].indexOf(key) === -1;
      }).map(function(key) { return caches.delete(key); }));
    }).then(function() { return self.clients.claim(); })
  );
});

function isAudioRequest(url, request) {
  if (url.hostname !== 'res.cloudinary.com') return false;
  // Cloudinary stores audio uploaded with resource_type:auto under /video/upload/.
  return request.destination === 'audio' || url.pathname.indexOf('/video/upload/') !== -1;
}

function isStaticCdn(url) {
  return url.hostname === 'fonts.googleapis.com'
    || url.hostname === 'fonts.gstatic.com'
    || url.hostname === 'www.gstatic.com';
}

function isShellNavigation(url) {
  return url.pathname.slice(-1) === '/' || url.pathname.slice(-11) === '/index.html';
}

// FIFO cap so the audio cache cannot grow unbounded.
function enforceAudioLimit(cache) {
  return cache.keys().then(function(keys) {
    if (keys.length <= AUDIO_MAX_ENTRIES) return undefined;
    return cache.delete(keys[0]).then(function() { return enforceAudioLimit(cache); });
  });
}

// Serve a cached full response, honouring Range requests with a real 206 —
// Safari rejects media when a ranged request gets an un-ranged response.
function buildRangeResponse(request, response) {
  var rangeHeader = request.headers.get('range');
  if (!rangeHeader) return Promise.resolve(response);
  return response.arrayBuffer().then(function(buffer) {
    var total = buffer.byteLength;
    var match = /bytes=(\d*)-(\d*)/.exec(rangeHeader) || [];
    var start = match[1] ? parseInt(match[1], 10) : 0;
    var end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
    }
    return new Response(buffer.slice(start, end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

// Cache-first for audio: Cloudinary URLs are immutable per upload. On miss,
// fetch the FULL file (a bare GET, no Range header) so the cached copy is
// complete, then answer the original request — sliced if it was ranged.
function audioStrategy(request) {
  return caches.open(AUDIO_CACHE).then(function(cache) {
    return cache.match(request.url).then(function(cached) {
      if (cached) return buildRangeResponse(request, cached);
      return fetch(request.url).then(function(response) {
        if (!response || response.status !== 200) return response;
        var copy = response.clone();
        return cache.put(request.url, copy).then(function() {
          return enforceAudioLimit(cache);
        }).then(function() {
          return buildRangeResponse(request, response);
        });
      }).catch(function() {
        // CORS or network failure: fall back to a plain passthrough.
        return fetch(request);
      });
    });
  });
}

// Cache-first for versioned CDN assets (fonts, Firebase SDK modules).
function cdnStrategy(request) {
  return caches.match(request).then(function(cached) {
    if (cached) return cached;
    return fetch(request).then(function(response) {
      if (response && (response.status === 200 || response.type === 'opaque')) {
        var copy = response.clone();
        caches.open(STATIC_CACHE).then(function(cache) { cache.put(request, copy); });
      }
      return response;
    });
  });
}

// Network-first for navigations so deploys land immediately; cached shell
// only when the network is unreachable. /track/:id and /playlist/:id 404
// responses are passed through online (GitHub Pages 404.html handles the
// redirect) and fall back to the shell offline.
function navigationStrategy(request, url) {
  return fetch(request).then(function(response) {
    if (response && response.status === 200 && isShellNavigation(url)) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function(cache) { cache.put('./index.html', copy); });
    }
    return response;
  }).catch(function() {
    return caches.match(request).then(function(cached) {
      return cached || caches.match('./index.html');
    });
  });
}

// Cache-first for same-origin static files (icons, manifest).
function sameOriginStrategy(request) {
  return caches.match(request).then(function(cached) {
    if (cached) return cached;
    return fetch(request).then(function(response) {
      if (response && response.status === 200) {
        var copy = response.clone();
        caches.open(SHELL_CACHE).then(function(cache) { cache.put(request, copy); });
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function(event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);

  if (isAudioRequest(url, request)) {
    event.respondWith(audioStrategy(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request, url));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(sameOriginStrategy(request));
    return;
  }
  if (isStaticCdn(url)) {
    event.respondWith(cdnStrategy(request));
    return;
  }
  // Everything else (Firestore, Cloudinary uploads, auth) passes through.
});
