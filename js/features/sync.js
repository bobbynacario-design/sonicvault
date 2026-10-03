// The write-ahead queue between localStorage and Firestore, the per-track
// diff that feeds it, and the banner that owns up to unsaved changes.

var _offlineQueue = JSON.parse(localStorage.getItem('sv_offline_queue') || '{}');
// A queue left by the single-document build holds the entire tracks array
// under one key. Fan it out to per-track entries so nothing queued before
// this upgrade is lost.
(function migrateQueuedTracks() {
  var legacy = _offlineQueue.tracks;
  if (!Array.isArray(legacy)) return;
  delete _offlineQueue.tracks;
  legacy.forEach(function(track) {
    if (!track || !track.id) return;
    _offlineQueue['track:' + track.id] = { kind: 'track', op: 'set', id: track.id, value: track };
  });
  try { localStorage.setItem('sv_offline_queue', JSON.stringify(_offlineQueue)); } catch (e) {}
})();
var _isOnline = navigator.onLine;

window.addEventListener('online', function() {
  _isOnline = true;
  flushOfflineQueue();
  updateOnlineStatus();
  renderSyncBanner();
});
window.addEventListener('offline', function() {
  _isOnline = false;
  updateOnlineStatus();
  renderSyncBanner();
});

// Pending writes are the one state the transient pill cannot carry: it is
// overwritten by the next operation, and the queue can outlive a reload.
function renderSyncBanner() {
  var el = document.getElementById('sync-banner');
  if (!el) return;
  var count = getPendingWriteKeys().length;
  if (!count) {
    el.hidden = true;
    syncBannerHeightVar();
    return;
  }
  var textEl = el.querySelector('.sync-banner-text');
  var btn = el.querySelector('.sync-banner-btn');
  var label = count + (count !== 1 ? ' changes' : ' change') + ' not saved to the cloud';
  if (!_isOnline) {
    textEl.textContent = label + ' · offline';
    btn.textContent = 'Retry now';
    btn.onclick = retrySyncNow;
  } else if (!window.fbOwnerUser) {
    textEl.textContent = label + ' · sign in to sync';
    btn.textContent = 'Sign in';
    btn.onclick = function() { toggleOwnerAuth(); };
  } else {
    textEl.textContent = label;
    btn.textContent = 'Retry now';
    btn.onclick = retrySyncNow;
  }
  el.hidden = false;
  syncBannerHeightVar();
}

// The banner wraps to more lines as the viewport narrows, so its height has to
// be re-read on resize just like the player's -- a value measured once goes
// stale the moment the window changes and leaves the shell mis-sized.
function syncBannerHeightVar() {
  var el = document.getElementById('sync-banner');
  if (!el) return;
  // Fractional height: offsetHeight rounds, which left the shell a pixel off.
  var h = el.hidden ? 0 : el.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--sync-banner-h', h + 'px');
}

function updateOnlineStatus() {
  if (_isOnline || !window.setSyncStatus) return;
  window.setSyncStatus('offline', 'Local only');
}

// The queue is a write-ahead log, not just an offline buffer. Every write
// enters it and only leaves once the server confirms that exact write, so a
// failure online -- permission denied, the 1MiB document ceiling, a dropped
// request -- is retried instead of vanishing with a status pill for company.
var _writeSeq = 0;
var _queuedSeq = {};   // key -> seq of the value currently sitting in the queue
var _retryTimer = null;

function persistOfflineQueue() {
  try {
    localStorage.setItem('sv_offline_queue', JSON.stringify(_offlineQueue));
  } catch (e) {
    console.error('offline queue persist failed:', e);
  }
}

function queueWrite(key, val, seq) {
  _offlineQueue[key] = val;
  _queuedSeq[key] = seq;
  persistOfflineQueue();
  renderSyncBanner();
}

// Only clear the entry if it is still the write we just confirmed. A newer
// save for the same key while this one was in flight must stay queued.
function confirmWrite(key, seq) {
  if (_queuedSeq[key] !== seq) return;
  delete _offlineQueue[key];
  delete _queuedSeq[key];
  persistOfflineQueue();
  renderSyncBanner();
}

function getPendingWriteKeys() {
  return Object.keys(_offlineQueue);
}

// Sync listeners use this so a confirmed-stale server copy cannot overwrite
// local work that has not been accepted yet.
window.svHasPendingWrite = function(key) {
  return Object.prototype.hasOwnProperty.call(_offlineQueue, key);
};

// ── Per-track sync ─────────────────────────────────────────────────────
// Tracks live in their own Firestore collection, one document each, so a
// play writes ~1KB instead of rewriting the whole library. persistTracks()
// stays the single choke point every caller already uses: it diffs the array
// against the last state the server confirmed and queues only what changed.
var _trackShadow = {};   // id -> fingerprint of the last server-confirmed state

function trackQueueKey(id) { return 'track:' + id; }

function hasPendingTrackWrite(id) {
  return Object.prototype.hasOwnProperty.call(_offlineQueue, trackQueueKey(id));
}

function queueTrackOp(op, id, track) {
  var key = trackQueueKey(id);
  var seq = ++_writeSeq;
  _queuedSeq[key] = seq;
  _offlineQueue[key] = { kind: 'track', op: op, id: id, value: op === 'set' ? stripAudioData(track) : null };
  persistOfflineQueue();
  renderSyncBanner();
  pushQueued(key, _offlineQueue[key], seq);
}

// Diff the live array against server-confirmed state: writes for anything
// new or changed, deletes for anything that has gone.
function syncTrackDocs() {
  var seen = {};
  tracks.forEach(function(track) {
    if (!track || !track.id) return;
    seen[track.id] = 1;
    if (_trackShadow[track.id] === trackFingerprint(track)) return;
    queueTrackOp('set', track.id, track);
  });
  Object.keys(_trackShadow).forEach(function(id) {
    if (!seen[id]) queueTrackOp('delete', id, null);
  });
}

// Server state for the tracks collection. Anything with an unconfirmed local
// write wins, so a snapshot cannot wipe an edit still sitting in the queue.
window.svApplyRemoteTracks = function(remoteList) {
  var byId = {};
  (remoteList || []).forEach(function(track) {
    if (track && track.id) {
      byId[track.id] = track;
      _trackShadow[track.id] = trackFingerprint(track);
    }
  });
  Object.keys(_trackShadow).forEach(function(id) {
    if (!byId[id] && !hasPendingTrackWrite(id)) delete _trackShadow[id];
  });
  tracks.forEach(function(track) {
    if (track && track.id && hasPendingTrackWrite(track.id)) byId[track.id] = track;
  });
  var next = Object.keys(byId).map(function(id) { return byId[id]; });
  next.sort(compareNewestFirst);
  window.tracks = next;
  tracks = next;
  try { localStorage.setItem('sv_tracks', JSON.stringify(tracks)); } catch (e) {}
  invalidateFilterCache();
};

function pushQueued(key, entry, seq) {
  if (!_isOnline) { scheduleRetry(); return; }
  var promise;
  if (entry && entry.kind === 'track') {
    if (!window.fbSaveTrack || !window.fbDeleteTrack) { scheduleRetry(); return; }
    promise = entry.op === 'delete' ? window.fbDeleteTrack(entry.id) : window.fbSaveTrack(entry.value);
  } else {
    if (!window.fbSave) { scheduleRetry(); return; }
    promise = window.fbSave(key, entry);
  }
  promise.then(function(ok) {
    if (!ok) { scheduleRetry(); return; }
    if (entry && entry.kind === 'track') {
      if (entry.op === 'delete') delete _trackShadow[entry.id];
      else _trackShadow[entry.id] = trackFingerprint(entry.value);
    }
    confirmWrite(key, seq);
  }).catch(function(err) {
    console.error('write rejected:', err);
    scheduleRetry();
  });
}

function pushWrite(key, val, seq) {
  pushQueued(key, val, seq);
}

function flushOfflineQueue() {
  var keys = getPendingWriteKeys();
  if (!keys.length) return;
  if (!_isOnline || !window.fbSave) { scheduleRetry(); return; }
  keys.forEach(function(k) {
    var seq = _queuedSeq[k];
    if (seq == null) { seq = ++_writeSeq; _queuedSeq[k] = seq; }
    pushQueued(k, _offlineQueue[k], seq);
  });
}

function scheduleRetry() {
  if (_retryTimer || !getPendingWriteKeys().length) return;
  _retryTimer = setTimeout(function() {
    _retryTimer = null;
    if (getPendingWriteKeys().length) flushOfflineQueue();
  }, 30000);
}

function retrySyncNow() {
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  flushOfflineQueue();
}
// Sign-in happens in the module script; it drains anything queued from a
// signed-out session or a previous visit.
window.svFlushQueue = function() { retrySyncNow(); };

function save(key, val) {
  localStorage.setItem('sv_' + key, JSON.stringify(val));
  var cleanVal = val;
  if (key === 'tracks' && Array.isArray(val)) {
    cleanVal = val.map(function(t) {
      var copy = Object.assign({}, t);
      delete copy.audioData;
      return copy;
    });
  }
  // Decoded peaks are device-local. Strip them on the way out so an old
  // settings object can never re-upload the cache this build just retired.
  if (key === 'settings' && val && typeof val === 'object' && val.waveformCache) {
    cleanVal = Object.assign({}, val);
    delete cleanVal.waveformCache;
  }
  var seq = ++_writeSeq;
  queueWrite(key, cleanVal, seq);
  pushWrite(key, cleanVal, seq);
}
