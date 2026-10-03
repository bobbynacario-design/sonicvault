// Real waveforms: decoding peaks from each track's audio, the device-local
// peak cache, and the waveform bars drawn on cards.

var _waveformExtractionJobs = {};
var _audioContext = null;

// Decoded peaks are derived data -- reconstructible from the audio at any
// time -- but they were living in the synced settings document at ~681 bytes
// per track, which put a second 1MiB ceiling about 1,500 tracks away in the
// document written most often. They are device-local now and never sync.
var _waveformCache = null;

function getWaveformCache() {
  if (_waveformCache) return _waveformCache;
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('sv_waveforms') || 'null'); } catch (e) { stored = null; }
  _waveformCache = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
  // One-time lift of anything left in the old synced location.
  var legacy = (window.appSettings || {}).waveformCache;
  if (legacy && typeof legacy === 'object') {
    Object.keys(legacy).forEach(function(id) {
      if (!_waveformCache[id] && Array.isArray(legacy[id])) _waveformCache[id] = legacy[id];
    });
    saveWaveformCache();
  }
  return _waveformCache;
}

function saveWaveformCache() {
  if (!_waveformCache) return;
  try {
    localStorage.setItem('sv_waveforms', JSON.stringify(_waveformCache));
  } catch (e) {
    // A full quota is not worth losing a save over; peaks re-decode on demand.
    console.warn('waveform cache not persisted:', e);
  }
}

function getRealPeaksForTrack(track) {
  if (!track) return [];
  var cache = getWaveformCache()[track.id];
  if (Array.isArray(cache) && cache.length) return cache.slice();
  if (Array.isArray(track.peaks) && track.peaks.length) return track.peaks.slice();
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
  // Real decoded peaks only: the extraction cache, then peaks stored on the
  // track itself. Legacy track.waveform is random data and is never used.
  var cache = getWaveformCache()[track.id];
  var source = (Array.isArray(cache) && cache.length) ? cache
    : (Array.isArray(track.peaks) && track.peaks.length ? track.peaks : null);
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

  _waveformExtractionJobs[track.id] = true;
  var extracted = false;
  try {
    var response = await fetch(src, { mode:'cors' });
    if (!response.ok) throw new Error('Waveform fetch failed');
    var bufferData = await response.arrayBuffer();
    if (!_audioContext) _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var decoded = await _audioContext.decodeAudioData(bufferData.slice(0));
    var peaks = extractWaveformPeaks(decoded, 72);
    getWaveformCache()[track.id] = peaks;
    invalidateVisualWaveform(track.id);
    window.appSettings = appSettings;
    // Stamp real peaks onto the private track too so share payloads carry them.
    var privateTrack = tracks.find(function(item) { return item.id === track.id; });
    if (privateTrack) privateTrack.peaks = peaks.slice();
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

// One-time backfill: decode real peaks for every track that still lacks
// them, one at a time so playback and UI stay responsive. Firestore writes
// are batched into a single save at the end.
var _waveformSweepStarted = false;
async function sweepWaveformBackfill() {
  if (_waveformSweepStarted) return;
  _waveformSweepStarted = true;
  var cache = getWaveformCache();
  var missing = tracks.filter(function(t) {
    return (t.audioURL || t.audioData)
      && !(Array.isArray(cache[t.id]) && cache[t.id].length)
      && !(Array.isArray(t.peaks) && t.peaks.length);
  });
  var extracted = 0;
  for (var i = 0; i < missing.length; i++) {
    if (navigator.onLine === false) break;
    if (await ensureWaveformForTrack(missing[i], { skipSave: true })) extracted++;
    await new Promise(function(resolve) { setTimeout(resolve, 600); });
  }
  if (extracted) {
    saveWaveformCache();
    persistTracks();
  }
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
