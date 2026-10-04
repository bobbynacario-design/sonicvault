// Timed lyrics in the expanded player. Suno's files carry the lyrics but no
// timings, so the first time a track plays, the AI worker's POST /transcribe
// listens to it (Whisper on Workers AI) and alignLyricsToWords lines the
// words it heard up against the lyric sheet. The result is saved on the
// track as lyricSync, so it syncs to every device and is paid for once.
//
// A line that came out wrong is fixed by tapping it while it is being sung;
// with no worker configured, the same taps time a song by hand.
//
// track.lyricSync = { key, starts: [s | null...], ends: [e | null...], source, at, heard?, words? }
//   (two flat arrays: Firestore rejects an array inside an array -- see
//   packLyricSync in js/data/lyric-sync.js)
//   key     lyricSyncKey(lyrics) -- editing the lyrics retires the timings
//   source  'audio' | 'audio+fixed' | 'manual' | 'unmatched'
//   heard   what the transcription heard on each sung line, for checking
//           what was sung against what was written (checkSungLyrics)
//   words   when each sheet word was heard, flat, for karaoke
//           (karaokeWords; js/features/karaoke.js)

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

// The track's saved sync, if it still belongs to these lyrics, as
// { lines: [[start, end] | null...], source, at } whatever shape it is
// stored in.
function getLyricSync(track) {
  var sync = track && track.lyricSync;
  if (!sync || !hasLyrics(track)) return null;
  var lines = unpackLyricLines(sync);
  if (!lines) return null;
  if (sync.key !== lyricSyncKey(getTrackLyrics(track))) return null;
  if (sync.source !== 'unmatched' && lines.length !== sungLyricLines(getTrackLyrics(track)).length) return null;
  var heard = Array.isArray(sync.heard) && sync.heard.length === lines.length ? sync.heard : null;
  var words = Array.isArray(sync.words) && sync.words.length === lyricWordOffsets(getTrackLyrics(track)).total ? sync.words : null;
  return { key:sync.key, lines:lines, source:sync.source, at:sync.at, heard:heard, words:words };
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

// The words Whisper heard in the track, as [[word, start, end], ...].
async function transcribeTrack(track) {
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
    return data.words || [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestLyricSync(track) {
  _lyricSyncJobs[track.id] = true;
  renderLyricStatus();
  try {
    var words = await transcribeTrack(track);
    var lyrics = getTrackLyrics(track);
    // The lyrics may have been edited, or timed by hand, while the request
    // was out; either way this result no longer applies.
    if (getLyricSync(track) || !hasLyrics(track)) return;
    var aligned = alignLyricsToWords(lyrics, words);
    var trusted = aligned.matched >= LYRIC_SYNC_MIN_MATCH;
    track.lyricSync = packLyricSync(lyrics, trusted ? aligned.lines : [], trusted ? 'audio' : 'unmatched', new Date().toISOString(), aligned.heard, aligned.words);
    persistTracks();
  } catch (e) {
    _lyricSyncFailed[track.id] = e && e.name === 'AbortError' ? 'timeout' : 'error';
    console.warn('Lyric sync skipped for', track.id, e);
  } finally {
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
  track.lyricSync = packLyricSync(lyrics, fixLyricLine(base, index, _audio.currentTime), source, new Date().toISOString(),
    sync ? sync.heard : null, sync ? sync.words : null);
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
  if (fix.previous) track.lyricSync = cloudSafeLyricSync(fix.previous);
  else delete track.lyricSync;
  _lyricTimesCache = null;
  persistTracks();
  renderLyricStatus();
  updateLyricHighlight(true);
}

function renderLyricStatus() {
  if (typeof renderKaraokeButton === 'function') renderKaraokeButton();
  if (typeof renderTranslatePanel === 'function') renderTranslatePanel();
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


// ── What was sung, against what was written ─────────────────────────────────
// The transcription behind the timings also says what the singer actually
// sang. "Check what was sung" in the lyrics card lays the two side by side:
// lines sung as written, lines sung differently (the words that changed
// marked, with what was heard), and lines not heard at all. Songs timed
// before the heard text was kept are listened to once more on request;
// timings someone corrected by hand are kept as they are.

var _sungCheckOpen = '';          // id of the track whose check is showing
var _sungCheckJobs = {};          // track id -> true while listening
var _sungCheckFailed = {};        // track id -> true, this page load

function getSungCheck(track) {
  var sync = getLyricSync(track);
  if (!sync || !sync.heard) return null;
  return checkSungLyrics(getTrackLyrics(track), sync.heard);
}

function sungCheckTrack() {
  return _currentTrack ? (getVaultTrack(_currentTrack.id) || _currentTrack) : null;
}

function toggleSungCheck() {
  var track = sungCheckTrack();
  if (!track) return;
  _sungCheckOpen = _sungCheckOpen === track.id ? '' : track.id;
  var vault = getVaultTrack(track.id);
  if (_sungCheckOpen && vault && !getSungCheck(vault) && lyricSyncEndpoint()) requestSungCheck(vault);
  renderSungCheck();
}

async function requestSungCheck(track) {
  if (_sungCheckJobs[track.id]) return;
  _sungCheckJobs[track.id] = true;
  delete _sungCheckFailed[track.id];
  renderSungCheck();
  try {
    var words = await transcribeTrack(track);
    var lyrics = getTrackLyrics(track);
    if (!hasLyrics(track)) return;
    var aligned = alignLyricsToWords(lyrics, words);
    var existing = getLyricSync(track);
    if (existing && (existing.source === 'audio+fixed' || existing.source === 'manual')) {
      track.lyricSync = packLyricSync(lyrics, existing.lines, existing.source, existing.at, aligned.heard, aligned.words);
    } else {
      var trusted = aligned.matched >= LYRIC_SYNC_MIN_MATCH;
      track.lyricSync = packLyricSync(lyrics, trusted ? aligned.lines : [], trusted ? 'audio' : 'unmatched', new Date().toISOString(), aligned.heard, aligned.words);
    }
    persistTracks();
  } catch (e) {
    _sungCheckFailed[track.id] = true;
    console.warn('Sung check skipped for', track.id, e);
  } finally {
    delete _sungCheckJobs[track.id];
    _lyricTimesCache = null;
    renderSungCheck();
    if (_currentTrack && _currentTrack.id === track.id) {
      renderLyricStatus();
      updateLyricHighlight(true);
    }
    if (typeof refreshShelfItem === 'function') renderTracks();
  }
}

// A short line about how a song was sung, for the versions list.
function sungCheckSummary(track) {
  var check = getSungCheck(track);
  if (!check || !check.total) return '';
  return check.asWritten + ' of ' + check.total + ' lines as written';
}

function sungLineHTML(line, index, times) {
  var start = times && times[index] ? times[index][0] : null;
  var jump = start !== null && isFinite(start) ? ' role="button" tabindex="0" onclick="jumpToSungLine(' + start + ')"' : '';
  if (line.unheard) {
    return '<div class="sung-line is-unheard"' + jump + '><span class="sung-written">' + esc(line.text) + '</span><span class="sung-tag">Not heard</span></div>';
  }
  if (!line.differs) return '<div class="sung-line"' + jump + '><span class="sung-written">' + esc(line.text) + '</span></div>';
  var written = line.tokens.map(function(token) {
    if (token.status === 'changed') return '<mark class="sung-changed" title="' + attr('Heard \u201c' + token.heard + '\u201d') + '">' + esc(token.text) + '</mark>';
    if (token.status === 'missing') return '<mark class="sung-missing" title="Not heard">' + esc(token.text) + '</mark>';
    return esc(token.text);
  }).join(' ');
  var heard = line.heard.map(function(word) {
    return word.status === 'ok' ? esc(word.text) : '<mark class="sung-' + (word.status === 'extra' ? 'extra' : 'changed') + '">' + esc(word.text) + '</mark>';
  }).join(' ');
  return '<div class="sung-line is-diff"' + jump + '><span class="sung-written">' + written + '</span><span class="sung-heard"><span class="sung-heard-label">Heard</span> ' + heard + '</span></div>';
}

function jumpToSungLine(t) {
  if (!_audio.duration) return;
  _audio.currentTime = Math.max(0, Number(t) - .3);
  if (!_isPlaying) togglePlayback();
}

function renderSungCheck() {
  var btn = document.getElementById('xp-check-btn');
  var panel = document.getElementById('xp-sung-check');
  var lyricsEl = document.getElementById('xp-lyrics');
  if (!btn || !panel || !lyricsEl) return;
  var track = sungCheckTrack();
  var vault = track && getVaultTrack(track.id);
  var check = track ? getSungCheck(track) : null;
  var canCheck = !!(track && hasLyrics(track) && (check || (vault && lyricSyncEndpoint())));
  var open = canCheck && _sungCheckOpen === track.id;
  btn.hidden = !canCheck;
  btn.textContent = open ? 'Back to lyrics' : 'Check what was sung';
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  panel.hidden = !open;
  lyricsEl.hidden = open;
  if (!open) return;
  if (_sungCheckJobs[track.id]) {
    panel.innerHTML = '<div class="sung-summary"><span class="create-take-pulse" aria-hidden="true"></span>Listening to what was sung\u2026 about half a minute.</div>';
    return;
  }
  if (!check) {
    panel.innerHTML = '<div class="sung-summary">' + (_sungCheckFailed[track.id]
      ? 'Couldn\u2019t listen to the song just now. <button type="button" class="lyric-undo" onclick="requestSungCheck(getVaultTrack(' + jsq(track.id) + '))">Try again</button>'
      : 'Connect the AI worker to check what was sung.') + '</div>';
    return;
  }
  var parts = ['<strong>' + check.asWritten + ' of ' + check.total + '</strong> lines sung as written'];
  if (check.differ) parts.push(check.differ + ' sung differently');
  if (check.unheard) parts.push(check.unheard + ' not heard');
  var times = getCurrentLyricTimes();
  panel.innerHTML = '<div class="sung-summary">' + parts.join(' \u00b7 ') + '</div>'
    + '<div class="sung-note">From the transcription, which can mishear words under a loud mix. Tap a line to hear it.</div>'
    + '<div class="sung-lines">' + check.lines.map(function(line, i) { return sungLineHTML(line, i, times); }).join('') + '</div>';
}
