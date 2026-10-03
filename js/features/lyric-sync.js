// Timed lyrics in the expanded player. Suno's files carry the lyrics but no
// timings, so the first time a track plays, the AI worker's POST /transcribe
// listens to it (Whisper on Workers AI) and alignLyricsToWords lines the
// words it heard up against the lyric sheet. The result is saved on the
// track as lyricSync, so it syncs to every device and is paid for once.
//
// A line that came out wrong is fixed by tapping it while it is being sung;
// with no worker configured, the same taps time a song by hand.
//
// track.lyricSync = { key, lines: [[start, end] | null, ...], source, at }
//   key     lyricSyncKey(lyrics) -- editing the lyrics retires the timings
//   source  'audio' | 'audio+fixed' | 'manual' | 'unmatched'

var LYRIC_SYNC_MIN_MATCH = .3;   // below this share of words matched, timings are not trusted
var LYRIC_SYNC_TIMEOUT_MS = 120000;
var _lyricSyncJobs = {};         // track id -> true while a request is out
var _lyricSyncFailed = {};       // track id -> reason, for this page load only
var _lyricTimesCache = null;
var _lastLyricFix = null;        // { trackId, previous, line, time, at } -- for Undo
var LYRIC_UNDO_MS = 10000;

function getVaultTrack(id) {
  return (tracks || []).find(function(item) { return item.id === id; }) || null;
}

// The track's saved sync, if it still belongs to these lyrics.
function getLyricSync(track) {
  var sync = track && track.lyricSync;
  if (!sync || !Array.isArray(sync.lines) || !hasLyrics(track)) return null;
  if (sync.key !== lyricSyncKey(getTrackLyrics(track))) return null;
  if (sync.source !== 'unmatched' && sync.lines.length !== sungLyricLines(getTrackLyrics(track)).length) return null;
  return sync;
}

function hasUsableLyricTimes(track) {
  var sync = getLyricSync(track);
  return !!(sync && sync.source !== 'unmatched' && sync.lines.some(Boolean));
}

function lyricSyncEndpoint() {
  if (!_aiConfig || !_aiConfig.endpoint) return '';
  try { return new URL('/transcribe', _aiConfig.endpoint).toString(); } catch (e) { return ''; }
}

// Called on every timeupdate: cheap until a track has played a few seconds
// and actually needs timing, so skipping through the queue costs nothing.
function maybeSyncLyrics() {
  var track = _currentTrack;
  if (!track || _audio.currentTime < 4 || _audio.paused) return;
  if (_lyricSyncJobs[track.id] || _lyricSyncFailed[track.id]) return;
  var vaultTrack = getVaultTrack(track.id);
  if (!vaultTrack || !hasLyrics(vaultTrack) || getLyricSync(vaultTrack)) return;
  if (!/^https:\/\/res\.cloudinary\.com\//.test(vaultTrack.audioURL || '')) return;
  if (Number(vaultTrack.duration) > 900) return;
  if (!lyricSyncEndpoint() || navigator.onLine === false) return;
  requestLyricSync(vaultTrack);
}

async function requestLyricSync(track) {
  _lyricSyncJobs[track.id] = true;
  renderLyricStatus();
  var controller = window.AbortController ? new AbortController() : null;
  var timer = controller ? setTimeout(function() { controller.abort(); }, LYRIC_SYNC_TIMEOUT_MS) : null;
  try {
    var headers = { 'Content-Type':'application/json' };
    if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
    var response = await fetch(lyricSyncEndpoint(), {
      method:'POST',
      headers:headers,
      body:JSON.stringify({ audioURL:track.audioURL }),
      signal:controller ? controller.signal : undefined
    });
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    var lyrics = getTrackLyrics(track);
    // The lyrics may have been edited, or timed by hand, while the request
    // was out; either way this result no longer applies.
    if (getLyricSync(track) || !hasLyrics(track)) return;
    var aligned = alignLyricsToWords(lyrics, data.words || []);
    var trusted = aligned.matched >= LYRIC_SYNC_MIN_MATCH;
    track.lyricSync = {
      key:lyricSyncKey(lyrics),
      lines:trusted ? aligned.lines : [],
      source:trusted ? 'audio' : 'unmatched',
      at:new Date().toISOString()
    };
    persistTracks();
  } catch (e) {
    _lyricSyncFailed[track.id] = e && e.name === 'AbortError' ? 'timeout' : 'error';
    console.warn('Lyric sync skipped for', track.id, e);
  } finally {
    if (timer) clearTimeout(timer);
    delete _lyricSyncJobs[track.id];
    _lyricTimesCache = null;
    if (_currentTrack && _currentTrack.id === track.id) {
      renderLyricStatus();
      updateLyricHighlight(true);
    }
  }
}

// Start times for the current track's sung lines: the saved sync when there
// is one, else an even spread over the track as a placeholder.
function getCurrentLyricTimes() {
  var track = _currentTrack;
  if (!track) return null;
  var source = getVaultTrack(track.id) || track;
  var sync = getLyricSync(source);
  var count = sungLyricLines(getTrackLyrics(source)).length;
  var duration = _audio.duration || source.duration || 0;
  var spans = sync && sync.source !== 'unmatched' ? sync.lines : new Array(count).fill(null);
  var cacheKey = track.id + '|' + duration + '|' + (sync ? sync.at + sync.source + JSON.stringify(sync.lines).length : 'none') + '|' + count;
  if (_lyricTimesCache && _lyricTimesCache.key === cacheKey) return _lyricTimesCache.times;
  var times = resolveLyricTimes(spans, duration);
  _lyricTimesCache = { key:cacheKey, times:times, timed:!!(sync && sync.source !== 'unmatched') };
  return times;
}

// A tap on a lyric line. While the song plays, it means "this line starts
// now": the line is re-timed and saved. While paused, it jumps the song to
// that line instead.
function onLyricLineTap(index) {
  var track = _currentTrack && getVaultTrack(_currentTrack.id);
  if (!track || !hasLyrics(track)) return;
  if (_audio.paused) {
    var times = getCurrentLyricTimes();
    if (times && times[index]) {
      _audio.currentTime = Math.max(0, times[index][0] - .2);
      updateMediaSessionPosition();
      updateLyricHighlight(true);
    }
    return;
  }
  var lyrics = getTrackLyrics(track);
  var sync = getLyricSync(track);
  var count = sungLyricLines(lyrics).length;
  var base = sync && sync.source !== 'unmatched' ? sync.lines : new Array(count).fill(null);
  var source = sync && sync.source.indexOf('audio') === 0 ? 'audio+fixed' : 'manual';
  // A stray tap re-times a line that was right, so the last change can be
  // undone for a few seconds from the status line.
  _lastLyricFix = {
    trackId:track.id,
    previous:track.lyricSync ? JSON.parse(JSON.stringify(track.lyricSync)) : null,
    line:index,
    time:_audio.currentTime,
    at:Date.now()
  };
  track.lyricSync = {
    key:lyricSyncKey(lyrics),
    lines:fixLyricLine(base, index, _audio.currentTime),
    source:source,
    at:new Date().toISOString()
  };
  _lyricTimesCache = null;
  persistTracks();
  renderLyricStatus();
  updateLyricHighlight(true);
  setTimeout(renderLyricStatus, LYRIC_UNDO_MS + 50);
}

function undoLyricFix() {
  var fix = _lastLyricFix;
  _lastLyricFix = null;
  var track = fix && getVaultTrack(fix.trackId);
  if (!track || Date.now() - fix.at > LYRIC_UNDO_MS) { renderLyricStatus(); return; }
  if (fix.previous) track.lyricSync = fix.previous;
  else delete track.lyricSync;
  _lyricTimesCache = null;
  persistTracks();
  renderLyricStatus();
  updateLyricHighlight(true);
}

function renderLyricStatus() {
  var el = document.getElementById('xp-lyrics-status');
  if (!el) return;
  var track = _currentTrack && (getVaultTrack(_currentTrack.id) || _currentTrack);
  if (!track || !hasLyrics(track)) { el.textContent = ''; return; }
  var sync = getLyricSync(track);
  var fix = _lastLyricFix;
  if (fix && fix.trackId === track.id && Date.now() - fix.at <= LYRIC_UNDO_MS) {
    el.innerHTML = 'Line ' + (fix.line + 1) + ' now starts at ' + esc(fmtTime(fix.time)) + '. <button type="button" class="lyric-undo" onclick="undoLyricFix()">Undo</button>';
    return;
  }
  var text;
  if (_lyricSyncJobs[track.id]) text = 'Listening to the song to time the lyrics…';
  else if (sync && sync.source === 'audio') text = 'Timed from the audio. Tap a line as it’s sung to correct it.';
  else if (sync && sync.source === 'audio+fixed') text = 'Timed from the audio, with your corrections. Tap a line as it’s sung to adjust it.';
  else if (sync && sync.source === 'manual') text = 'Timed by hand. Tap each line as it’s sung to time the rest.';
  else if (sync && sync.source === 'unmatched') text = 'Couldn’t match these lyrics to the vocals. Tap a line as it’s sung to time it.';
  else if (_lyricSyncFailed[track.id]) text = 'Couldn’t reach the AI worker, so timing is estimated. Tap a line as it’s sung to set it.';
  else if (!getVaultTrack(track.id)) text = '';
  else if (!lyricSyncEndpoint()) text = 'Timing is estimated. Set up the AI worker on the Import page to time lyrics from the audio, or tap a line as it’s sung.';
  else text = 'Timing is estimated until the song has played a few seconds.';
  el.textContent = text;
}
