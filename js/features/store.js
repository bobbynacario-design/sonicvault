// IndexedDB, for what outgrows localStorage. The browser gives localStorage
// about 5MB, and a song carrying its lyrics, word timings, translations and
// story is around 10KB, so a few hundred songs would fill it and the local
// copy would stop saving. From 2026-10-06 the track cache and the
// meaning-search vectors live here instead: one database, one key-value
// store. Small settings stay in localStorage, which can be read before the
// first paint.
//
// The local copy is a cache: Firestore holds the vault, and unsaved changes
// wait in localStorage's write queue (js/features/sync.js) until it takes
// them.

var _svIdb = null;
var _svIdbPending = {};
var _svIdbTimer = null;

function svIdb() {
  if (_svIdb) return _svIdb;
  _svIdb = new Promise(function(resolve, reject) {
    if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
    var request = indexedDB.open('sonicvault', 1);
    request.onupgradeneeded = function() { request.result.createObjectStore('kv'); };
    request.onsuccess = function() { resolve(request.result); };
    request.onerror = function() { reject(request.error); };
  });
  return _svIdb;
}

function svIdbGet(key) {
  return svIdb().then(function(db) {
    return new Promise(function(resolve, reject) {
      var request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      request.onsuccess = function() { resolve(request.result); };
      request.onerror = function() { reject(request.error); };
    });
  });
}

function svIdbSet(key, value) {
  return svIdb().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
      tx.onabort = function() { reject(tx.error); };
    });
  });
}

// The latest value for each key goes out a moment after the last change,
// so a burst of edits is one write; leaving the page writes at once.
function svIdbSave(key, value) {
  _svIdbPending[key] = value;
  clearTimeout(_svIdbTimer);
  _svIdbTimer = setTimeout(svIdbFlush, 300);
}

function svIdbFlush() {
  clearTimeout(_svIdbTimer);
  var batch = _svIdbPending;
  _svIdbPending = {};
  Object.keys(batch).forEach(function(key) {
    svIdbSet(key, batch[key]).catch(function(e) { console.warn('Local copy of ' + key + ' not saved:', e); });
  });
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') svIdbFlush();
});
window.addEventListener('pagehide', svIdbFlush);

// ── The track cache ─────────────────────────────────────────────────────
// Read once at start (hydrateTrackCache, from js/features/vault.js). Until
// that read finishes, nothing is written: an empty start-up list must never
// replace the saved library. A server snapshot that lands first wins, as
// the newer copy.

var _trackCacheReady = false;
var _tracksFromServer = false;

// Until the cache has been read, the library says it is loading rather
// than that the vault is empty (js/app.js keeps this up until the first
// sync settles).
window.svBootPending = true;

function cacheTracks(list) {
  if (!_trackCacheReady) return;
  svIdbSave('tracks', list);
}

function hydrateTrackCache() {
  var legacy = null;
  try { legacy = JSON.parse(localStorage.getItem('sv_tracks') || 'null'); } catch (e) { legacy = null; }
  return svIdbGet('tracks').then(function(saved) {
    var cached = Array.isArray(saved) ? saved : (Array.isArray(legacy) ? legacy : null);
    if (cached && !_tracksFromServer && !tracks.length) {
      tracks = cached.map(function(track) {
        if (track && track.lyricSync) track.lyricSync = cloudSafeLyricSync(track.lyricSync);
        return track;
      });
      window.tracks = tracks;
      invalidateFilterCache();
      if (window.refreshAll) window.refreshAll();
    }
    _trackCacheReady = true;
    // Moving from localStorage: copy the library across, then free the space.
    if (Array.isArray(legacy)) {
      return svIdbSet('tracks', tracks.length ? tracks : legacy).then(function() {
        try { localStorage.removeItem('sv_tracks'); } catch (e) {}
      });
    }
  }).catch(function(e) {
    // No IndexedDB (a locked-down browser): keep the old localStorage copy.
    console.warn('Track cache unavailable, using localStorage:', e);
    _trackCacheReady = true;
    cacheTracks = function(list) {
      try { localStorage.setItem('sv_tracks', JSON.stringify(list)); } catch (err) { console.warn('local track cache not written:', err); }
    };
  });
}
