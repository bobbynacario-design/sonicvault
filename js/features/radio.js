// Radio from any song ("Start radio" in the expanded player and the track
// menus): the song, then the songs most like it (pickRadioBatch in
// js/data/radio.js), topped up a batch at a time before the queue runs out,
// so it never stops. Playing something else from a shelf or a playlist
// replaces the queue, and with it the radio.

var _radio = null;           // { seedId, label }
var RADIO_TOP_UP_AT = 3;     // songs left in the queue when more are added
var RADIO_KEEP_BEHIND = 20;  // songs already played kept in the queue

function radioPool() {
  return tracks.filter(function(track) { return track.audioURL || track.audioData; });
}

// Search by meaning's vectors, when the songs have been read for it.
function radioVector(id) {
  return typeof songVector === 'function' ? songVector(id) : null;
}

function radioActive() {
  return !!(_radio && _playQueueLabel === _radio.label);
}

function startRadio(id) {
  var seed = getVaultTrack(id);
  if (!seed || !(seed.audioURL || seed.audioData)) { showToast('This song has no audio to start a radio from.'); return; }
  var batch = pickRadioBatch(seed, radioPool(), [], RADIO_BATCH, radioVector);
  if (!batch.length) { showToast('Radio needs a few more songs in the vault.'); return; }
  // A shuffled radio would replay what it already played each time it grows.
  var shuffleWasOn = _shuffleMode;
  if (shuffleWasOn) {
    _shuffleMode = false;
    savePlayerPrefs();
    updatePlayerModeUI();
  }
  _radio = { seedId:seed.id, label:'Radio · ' + (seed.title || 'Untitled') };
  var ids = [seed.id].concat(batch);
  if (_currentTrack && _currentTrack.id === seed.id && _isPlaying) {
    // Already playing it: carry on, with the radio queued after it.
    setPlaybackQueue(ids, _radio.label);
    updateNowPlaying();
    if (typeof updateExpandedPlayer === 'function') updateExpandedPlayer();
  } else {
    startPlayback(seed.id, ids, _radio.label);
  }
  showToast('Radio from ' + (seed.title || 'this song') + ': songs like it, one after another.' + (shuffleWasOn ? ' Shuffle is off while it plays.' : ''));
  // The vectors make the matches better; read the songs once if they haven't been.
  if (typeof meaningAvailable === 'function' && meaningAvailable() && songsNeedingMeaning().length) indexSongsForMeaning();
}

function radioFromCurrentTrack() {
  if (_currentTrack) startRadio(_currentTrack.id);
}

// Each new song: when only a few are left, add the next batch.
function topUpRadio() {
  if (!radioActive() || !_currentTrack) return;
  var ids = _playQueueIds.slice();
  var at = ids.indexOf(_currentTrack.id);
  if (at === -1 || ids.length - 1 - at > RADIO_TOP_UP_AT) return;
  var seed = getVaultTrack(_radio.seedId);
  if (!seed) return;
  var pool = radioPool();
  var recent = ids.slice(-Math.max(8, Math.floor(pool.length * .6)));
  var more = pickRadioBatch(seed, pool, recent, RADIO_BATCH, radioVector);
  var next = appendRadioBatch(ids, at, more, RADIO_KEEP_BEHIND);
  if (next.length === ids.length && next.every(function(id, i) { return id === ids[i]; })) return;
  setPlaybackQueue(next, _radio.label);
  if (typeof updateExpandedPlayer === 'function') updateExpandedPlayer();
}

_audio.addEventListener('loadstart', topUpRadio);
