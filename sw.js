/* SonicVault service worker.
   Shell is network-first, so normal deploys propagate on the next online
   load without touching this file. Bump VERSION only when the caching
   logic itself changes and old caches must be discarded. */
var VERSION = 'v2';
var SHELL_CACHE = 'sv-shell-' + VERSION;
var STATIC_CACHE = 'sv-static-' + VERSION;
var AUDIO_CACHE = 'sv-audio-' + VERSION;
var AUDIO_MAX_ENTRIES = 30;
// Written by the page (js/features/artwork.js), never by this worker; listed
// so activate does not discard it.
var ART_CACHE = 'sv-art-v1';

var SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/app.css',
  './js/app.js',
  './js/data/util.js',
  './js/data/tracks.js',
  './js/data/covers.js',
  './js/data/artwork.js',
  './js/data/metadata.js',
  './js/data/waveform.js',
  './js/data/routes.js',
  './js/data/backup-format.js',
  './js/features/vault.js',
  './js/features/sync.js',
  './js/features/shell.js',
  './js/features/modals.js',
  './js/features/routes.js',
  './js/features/covers.js',
  './js/features/artwork.js',
  './js/features/waveform.js',
  './js/features/media-session.js',
  './js/features/player.js',
  './js/features/expanded-player.js',
  './js/features/library.js',
  './js/features/home.js',
  './js/features/insights.js',
  './js/features/playlists.js',
  './js/features/share.js',
  './js/features/edit-track.js',
  './js/features/ai-metadata.js',
  './js/features/upload.js',
  './js/features/backup.js',
  './js/features/keyboard.js',
  './js/boot.js',
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
        return key.indexOf('sv-') === 0 && [SHELL_CACHE, STATIC_CACHE, AUDIO_CACHE, ART_CACHE].indexOf(key) === -1;
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

// The redirect 404.html performs for /track/:id and /playlist/:id: back to
// the app base, carrying the route in ?sv-route.
function shareRouteRedirect(url) {
  var parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  var routeIndex = parts.indexOf('track');
  if (routeIndex === -1) routeIndex = parts.indexOf('playlist');
  if (routeIndex === -1) return null;
  var prefix = routeIndex > 0 ? '/' + parts.slice(0, routeIndex).join('/') : '';
  var route = '/' + parts.slice(routeIndex).join('/');
  return Response.redirect(url.origin + prefix + '/?sv-route=' + encodeURIComponent(route), 302);
}

// Network-first for navigations so deploys land immediately; cached shell
// only when the network is unreachable. /track/:id and /playlist/:id 404
// responses are passed through online (GitHub Pages 404.html handles the
// redirect). Offline they get the same redirect from here: serving the shell
// at the deep URL would resolve its relative js/ and styles/ paths under
// /track/ and boot a page with no code.
function navigationStrategy(request, url) {
  return fetch(request).then(function(response) {
    if (response && response.status === 200 && isShellNavigation(url)) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function(cache) { cache.put('./index.html', copy); });
    }
    return response;
  }).catch(function() {
    var redirect = shareRouteRedirect(url);
    if (redirect) return redirect;
    return caches.match(request).then(function(cached) {
      return cached || caches.match('./index.html');
    });
  });
}

// Cache-first for same-origin static files (icons, manifest).
// Code and styles are requested with a ?v= token (index.html), so an exact
// match is safe to serve cache-first: a new deploy changes the URL and misses.
// SHELL_ASSETS precaches them without the token, though, so offline the exact
// versioned URL is often absent -- fall back to any cached copy of the same
// file rather than failing, or offline boot loads the page without its CSS.
function sameOriginStrategy(request) {
  return caches.match(request).then(function(cached) {
    if (cached) return cached;
    return fetch(request).then(function(response) {
      if (response && response.status === 200) {
        var copy = response.clone();
        caches.open(SHELL_CACHE).then(function(cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function(err) {
      return caches.match(request, { ignoreSearch: true }).then(function(fallback) {
        if (fallback) return fallback;
        throw err;
      });
    });
  });
}

// The page asks before its tagged reads of audio files, because a worker
// without the handling below would turn each one into a cached download.
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'sv-capabilities' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ artProbe: true, waveProbe: true });
  }
});

// Waveform backfill downloads a whole song to measure it. Use the copy the
// audio cache already holds when there is one; otherwise fetch it without
// caching, so measuring the library cannot evict the songs actually played.
function waveStrategy(request, url) {
  var plain = new URL(url.href);
  plain.searchParams.delete('sv-wave');
  return caches.open(AUDIO_CACHE).then(function(cache) {
    return cache.match(plain.href);
  }).then(function(cached) {
    return cached || fetch(request);
  });
}

self.addEventListener('fetch', function(event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);

  // Artwork probes read the first few KB of a song for its embedded cover.
  // Through audioStrategy they would fetch and cache the whole file, and
  // push recently played songs out of the audio cache.
  if (url.searchParams.has('sv-art')) return;
  if (url.searchParams.has('sv-wave')) {
    event.respondWith(waveStrategy(request, url));
    return;
  }

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
