// Playlists kept offline. Their songs are downloaded into their own cache
// (sv-offline-v1), which sw.js checks before the network and never trims --
// unlike the audio cache, which keeps only the last 30 songs played. Which
// playlists are kept, and what is saved, is this device's alone
// (localStorage sv_offline): a phone keeps what a phone needs.

var OFFLINE_CACHE_NAME = 'sv-offline-v1';   // sw.js keeps and serves this cache
var OFFLINE_PROBE_PARAM = 'sv-offline';      // sw.js passes these downloads straight through
var OFFLINE_TOPUP_DELAY_MS = 20000;
var _offline = loadOfflineState();
var _offlineRun = null;                      // { playlistId, total, index, stopped }
var _offlineTopUpTimer = null;

function loadOfflineState() {
  try {
    var saved = JSON.parse(localStorage.getItem('sv_offline') || 'null') || {};
    return { playlists: saved.playlists || {}, files: saved.files || {} };
  } catch (e) {
    return { playlists:{}, files:{} };
  }
}

function saveOfflineState() {
  try { localStorage.setItem('sv_offline', JSON.stringify(_offline)); } catch (e) {}
}

function offlineSupported() {
  return 'caches' in window && 'serviceWorker' in navigator;
}

function isPlaylistOffline(id) {
  return !!_offline.playlists[id];
}

function offlineTracksOf(pl) {
  return getPlaylistTracks(pl).filter(function(track) { return /^https?:/.test(track.audioURL || ''); });
}

// How much of a kept playlist is on this device: songs and bytes.
function offlineProgress(pl) {
  var list = offlineTracksOf(pl);
  var saved = list.filter(function(track) { return _offline.files[track.audioURL]; });
  var bytes = saved.reduce(function(sum, track) { return sum + Number(_offline.files[track.audioURL] || 0); }, 0);
  return { total:list.length, saved:saved.length, bytes:bytes };
}

async function downloadForOffline(cache, track) {
  if (_offline.files[track.audioURL] && await cache.match(track.audioURL)) return true;
  var url = track.audioURL + (track.audioURL.indexOf('?') === -1 ? '?' : '&') + OFFLINE_PROBE_PARAM + '=1';
  var response = await fetch(url);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  var blob = await response.blob();
  await cache.put(track.audioURL, new Response(blob, {
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg', 'Content-Length': String(blob.size) }
  }));
  _offline.files[track.audioURL] = blob.size;
  saveOfflineState();
  return true;
}

async function savePlaylistOffline(id, quiet) {
  var pl = getPlaylistById(id);
  if (!pl || _offlineRun || !offlineSupported()) return;
  if (navigator.onLine === false) {
    if (!quiet) showToast('You’re offline. Connect to save this playlist.');
    return;
  }
  if (!isPlaylistOffline(id)) {
    _offline.playlists[id] = true;
    saveOfflineState();
    // Ask the browser not to clear these files when space runs low.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function() {});
  }
  var list = offlineTracksOf(pl).filter(function(track) { return !_offline.files[track.audioURL]; });
  if (!list.length) { renderOfflineControls(id); return; }
  _offlineRun = { playlistId:id, total:list.length, index:0, stopped:false, failed:0 };
  renderOfflineControls(id);
  var cache = await caches.open(OFFLINE_CACHE_NAME);
  for (var i = 0; i < list.length; i++) {
    if (_offlineRun.stopped || navigator.onLine === false) break;
    _offlineRun.index = i;
    renderOfflineControls(id);
    try {
      await downloadForOffline(cache, list[i]);
    } catch (e) {
      _offlineRun.failed++;
      console.warn('Offline save skipped for', list[i].id, e);
    }
  }
  var run = _offlineRun;
  _offlineRun = null;
  renderOfflineControls(id);
  renderPlaylists();
  if (!quiet) {
    var progress = offlineProgress(pl);
    showToast(run.stopped ? 'Stopped. ' + progress.saved + ' of ' + progress.total + ' songs saved.'
      : run.failed ? progress.saved + ' of ' + progress.total + ' songs saved. Try again for the rest.'
      : '“' + pl.name + '” is ready offline');
  }
}

function stopSavingOffline() {
  if (_offlineRun) _offlineRun.stopped = true;
}

// Removing a playlist's offline copy keeps any song another kept playlist
// still needs.
async function removePlaylistOffline(id) {
  var pl = getPlaylistById(id);
  delete _offline.playlists[id];
  var needed = {};
  Object.keys(_offline.playlists).forEach(function(otherId) {
    var other = getPlaylistById(otherId);
    if (other) offlineTracksOf(other).forEach(function(track) { needed[track.audioURL] = true; });
  });
  var cache = offlineSupported() ? await caches.open(OFFLINE_CACHE_NAME) : null;
  var urls = Object.keys(_offline.files).filter(function(url) { return !needed[url]; });
  for (var i = 0; i < urls.length; i++) {
    if (cache) await cache.delete(urls[i]);
    delete _offline.files[urls[i]];
  }
  saveOfflineState();
  renderOfflineControls(id);
  renderPlaylists();
  showToast(pl ? 'Removed the offline copy of “' + pl.name + '”' : 'Offline copy removed');
}

// Songs added to a kept playlist since it was saved come down on their own,
// a while after a sync, while online.
function scheduleOfflineTopUp() {
  clearTimeout(_offlineTopUpTimer);
  _offlineTopUpTimer = setTimeout(async function() {
    if (_offlineRun || navigator.onLine === false || !offlineSupported()) return;
    var ids = Object.keys(_offline.playlists);
    for (var i = 0; i < ids.length; i++) {
      var pl = getPlaylistById(ids[i]);
      if (!pl) continue;
      var progress = offlineProgress(pl);
      if (progress.saved < progress.total) await savePlaylistOffline(ids[i], true);
    }
  }, OFFLINE_TOPUP_DELAY_MS);
}

window.addEventListener('online', scheduleOfflineTopUp);

// The button and line in the playlist dialog (#offline-<id>).
function offlineControlsHTML(pl) {
  if (!offlineSupported()) return '';
  return '<div class="offline-controls" id="offline-' + attr(pl.id) + '">' + offlineControlsInner(pl) + '</div>';
}

function offlineControlsInner(pl) {
  var id = pl.id;
  if (_offlineRun && _offlineRun.playlistId === id) {
    return '<span class="offline-status">Saving ' + Math.min(_offlineRun.index + 1, _offlineRun.total) + ' of ' + _offlineRun.total + ' songs for offline…</span>'
      + '<button type="button" class="sec-action" onclick="stopSavingOffline()">Stop</button>';
  }
  if (!isPlaylistOffline(id)) {
    var count = offlineTracksOf(pl).length;
    return '<button type="button" class="sec-action has-icon" onclick="savePlaylistOffline(' + jsq(id) + ')"' + (count ? '' : ' disabled') + '>' + icon('download') + 'Keep offline</button>'
      + '<span class="offline-status">' + (count ? 'Saves its ' + count + ' song' + (count === 1 ? '' : 's') + ' to this device.' : 'No songs to save yet.') + '</span>';
  }
  var progress = offlineProgress(pl);
  var done = progress.saved >= progress.total;
  return '<span class="offline-status' + (done ? ' is-ready' : '') + '">' + (done
      ? 'Offline on this device · ' + progress.total + ' song' + (progress.total === 1 ? '' : 's') + ' · ' + formatFileSize(progress.bytes)
      : progress.saved + ' of ' + progress.total + ' songs saved for offline') + '</span>'
    + (done ? '' : '<button type="button" class="sec-action" onclick="savePlaylistOffline(' + jsq(id) + ')">Save the rest</button>')
    + '<button type="button" class="sec-action" onclick="removePlaylistOffline(' + jsq(id) + ')">Remove offline copy</button>';
}

function renderOfflineControls(id) {
  var el = document.getElementById('offline-' + id);
  var pl = getPlaylistById(id);
  if (el && pl) el.innerHTML = offlineControlsInner(pl);
}
