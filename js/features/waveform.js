// Real waveforms: measuring loudness levels from each track's audio, the
// device-local level cache, and the waveform bars drawn on cards.

var _waveformExtractionJobs = {};
var _audioContext = null;

// Levels are derived data -- reconstructible from the audio at any time.
// Each device keeps its own in localStorage; the first device to measure a
// track also stamps them on the track as `loudness`, so other devices and
// share pages read them instead of downloading the song.
//
// `loudness` replaces the old `peaks` field (and `sv_loudness` the old
// `sv_waveforms` cache), which held near-flat values for every loud track.
// A new name rather than a version flag: an out-of-date build still writes
// `peaks`, and can never pass old values off as new ones.
var _waveformCache = null;

function getWaveformCache() {
  if (_waveformCache) return _waveformCache;
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('sv_loudness') || 'null'); } catch (e) { stored = null; }
  _waveformCache = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
  try { localStorage.removeItem('sv_waveforms'); } catch (e) {}
  return _waveformCache;
}

function saveWaveformCache() {
  if (!_waveformCache) return;
  try {
    localStorage.setItem('sv_loudness', JSON.stringify(_waveformCache));
  } catch (e) {
    // A full quota is not worth losing a save over; levels re-measure on demand.
    console.warn('waveform cache not persisted:', e);
  }
}

function getRealPeaksForTrack(track) {
  if (!track) return [];
  var cache = getWaveformCache()[track.id];
  if (Array.isArray(cache) && cache.length) return cache.slice();
  if (Array.isArray(track.loudness) && track.loudness.length) return track.loudness.slice();
  return [];
}

// Memoize the normalized bar array per track+count. The expanded player
// throttles redraws to ~5fps but every redraw used to slice/normalize the
// peak array; this returns the same cached array reference when nothing
// changed. Bust via invalidateVisualWaveform(trackId).
var _visualWaveformCache = {};
function invalidateVisualWaveform(trackId) {
  if (!trackId) { _visualWaveformCache = {}; return; }
  Object.keys(_visualWaveformCache).forEach(function(k) {
    if (k.indexOf(trackId + '|') === 0) delete _visualWaveformCache[k];
  });
}

function getVisualWaveform(track, count) {
  if (!track) return buildFallbackWaveform(null, count || 48);
  var n = count || 48;
  var key = track.id + '|' + n;
  if (_visualWaveformCache[key]) return _visualWaveformCache[key];
  // Real measured levels only: this device's cache, then levels stored on the
  // track itself. Legacy track.waveform (random) and track.peaks (flat) are
  // never used.
  var cache = getWaveformCache()[track.id];
  var source = (Array.isArray(cache) && cache.length) ? cache
    : (Array.isArray(track.loudness) && track.loudness.length ? track.loudness : null);
  var bars = source ? normalizeWaveform(source, n) : buildFallbackWaveform(track, n);
  _visualWaveformCache[key] = bars;
  return bars;
}

async function ensureWaveformForTrack(track, opts) {
  var src = track && (track.audioURL || track.audioData);
  if (!track || !src || _waveformExtractionJobs[track.id]) return false;
  if (Array.isArray(getWaveformCache()[track.id]) && getWaveformCache()[track.id].length) return false;
  if (!(window.AudioContext || window.webkitAudioContext)) return false;
  var skipSave = !!(opts && opts.skipSave);
  // The sweep tags its downloads so sw.js serves a cached copy if it has one
  // and otherwise passes the request through without caching: run through
  // the audio cache, re-measuring the library would evict every song played.
  if (opts && opts.sweep && /^https?:/.test(src)) {
    src += (src.indexOf('?') === -1 ? '?' : '&') + 'sv-wave=1';
  }

  _waveformExtractionJobs[track.id] = true;
  var extracted = false;
  try {
    var response = await fetch(src, { mode:'cors' });
    if (!response.ok) throw new Error('Waveform fetch failed');
    var bufferData = await response.arrayBuffer();
    if (!_audioContext) _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var decoded = await _audioContext.decodeAudioData(bufferData.slice(0));
    var levels = extractWaveformLevels(decoded, 72);
    getWaveformCache()[track.id] = levels;
    invalidateVisualWaveform(track.id);
    // Stamp the levels onto the private track too, so other devices and share
    // payloads carry them, and drop the superseded peaks.
    var privateTrack = tracks.find(function(item) { return item.id === track.id; });
    if (privateTrack) {
      privateTrack.loudness = levels.slice();
      delete privateTrack.peaks;
    }
    saveWaveformCache();
    if (!skipSave && privateTrack) persistTracks();
    renderTracks();
    updateExpandedPlayer();
    extracted = true;
  } catch (e) {
    console.warn('Waveform extraction skipped for', track.id, e);
  }
  delete _waveformExtractionJobs[track.id];
  return extracted;
}

// Backfill: measure every track that has no levels yet, one at a time so
// playback and the UI stay responsive. Levels that another device already
// measured arrive on the track and skip the download. Saved every ten
// tracks rather than once at the end, so closing the tab mid-sweep loses
// little. Skipped under Data Saver; playing a track still measures it.
var _waveformSweepStarted = false;
async function sweepWaveformBackfill() {
  if (_waveformSweepStarted) return;
  if (navigator.connection && navigator.connection.saveData) return;
  _waveformSweepStarted = true;
  if (!(await workerSupports('waveProbe'))) {
    _waveformSweepStarted = false;
    return;
  }
  var cache = getWaveformCache();
  var missing = tracks.filter(function(t) {
    return (t.audioURL || t.audioData)
      && !(Array.isArray(cache[t.id]) && cache[t.id].length)
      && !(Array.isArray(t.loudness) && t.loudness.length);
  });
  var unsaved = 0;
  for (var i = 0; i < missing.length; i++) {
    if (navigator.onLine === false) break;
    if (await ensureWaveformForTrack(missing[i], { skipSave: true, sweep: true })) unsaved++;
    if (unsaved >= 10) {
      persistTracks();
      unsaved = 0;
    }
    await new Promise(function(resolve) { setTimeout(resolve, 600); });
  }
  if (unsaved) persistTracks();
}

function updateWaveformProgress(trackId, pct) {
  var container = document.getElementById('waveform-' + trackId);
  if (!container) return;
  var bars = container.querySelectorAll('.wbar');
  var total = bars.length;
  bars.forEach(function(bar, i) {
    var barPct = i / total;
    bar.className = 'wbar ' + (barPct <= pct ? 'wbar-active' : 'wbar-inactive');
  });
}

// aria-hidden: this is a pointer shortcut for an action the card already
// exposes through a labelled Play button, so exposing it again would just
// add a second unlabelled tab stop per track.
function renderWaveformHTML(trackId, waveform) {
  var html = '<div class="track-waveform" aria-hidden="true" id="waveform-' + esc(trackId) + '" onclick="event.stopPropagation();playTrack(' + jsq(trackId) + ')">';
  waveform.forEach(function(v) {
    html += '<div class="wbar wbar-inactive" style="height:' + Math.round(v * 100) + '%"></div>';
  });
  html += '</div>';
  return html;
}
