// A sleep timer, smooth transitions between songs, and even volume, all in
// the expanded player's sound row.
//
// Volume moves in ramps (rampVolume) and comes back to the song's level
// (playbackVolume: the listener's own _userVolume from player.js, lowered
// for a loud song when Even volume is on) afterwards, so a fade never
// changes the saved volume. iOS ignores a page setting audio volume, so on
// iPhone the timer pauses without a fade, transitions only preload the next
// song, and Even volume is hidden.

var SLEEP_STEPS = ['off', 15, 30, 45, 60, 'track'];
var SLEEP_FADE_MS = 8000;
var TRANSITION_FADE_S = 4;
var TRANSITION_FADE_IN_MS = 1500;
var PRELOAD_BEFORE_END_S = 25;

var _sleep = { mode:'off', endsAt:0 };
var _sleepTicker = null;
var _rampTimer = null;
var _rampPurpose = '';
var _tailFading = false;
var _preloadAudio = null;
var _preloadedId = '';

// ─── Volume ramps ────────────────────────────────────────────────────────────

function cancelVolumeRamp() {
  clearInterval(_rampTimer);
  _rampTimer = null;
  _rampPurpose = '';
}

function rampVolume(to, ms, purpose, done) {
  cancelVolumeRamp();
  var from = _audio.volume;
  var start = Date.now();
  _rampPurpose = purpose || '';
  _rampTimer = setInterval(function() {
    var t = Math.min(1, (Date.now() - start) / ms);
    try { _audio.volume = Math.max(0, Math.min(1, from + (to - from) * t)); } catch (e) {}
    if (t >= 1) {
      cancelVolumeRamp();
      if (done) done();
    }
  }, 50);
}

// A new song, or playing again after a fade, comes back up to the
// listener's level instead of staying where a fade left it.
_audio.addEventListener('playing', function() {
  if (_rampPurpose === 'sleep') return;
  _tailFading = false;
  var level = playbackVolume();
  if (_audio.volume < level - 0.01) rampVolume(level, TRANSITION_FADE_IN_MS, 'in');
  else if (!_rampTimer && _audio.volume > level + 0.01) setElementVolume(level);
});

// A fade on the old song must not carry on into the next one, and each song
// starts at its own level -- unless it is fading in after the last one
// faded out, which 'playing' above takes care of.
_audio.addEventListener('loadstart', function() {
  var tail = _rampPurpose === 'tail' || _tailFading;
  if (_rampPurpose === 'tail') cancelVolumeRamp();
  if (!tail && _rampPurpose !== 'sleep') setElementVolume(playbackVolume());
});

function setElementVolume(value) {
  try { _audio.volume = Math.max(0, Math.min(1, value)); } catch (e) {}
}

// ─── Even volume ─────────────────────────────────────────────────────────────

function evenVolumeOn() {
  return _playerPrefs.level !== false && volumeControllable();
}

// iOS keeps an audio element at full volume whatever a page sets.
var _volumeControllable = null;
function volumeControllable() {
  if (_volumeControllable === null) {
    try {
      var probe = new Audio();
      probe.volume = .5;
      _volumeControllable = Math.abs(probe.volume - .5) < .01;
    } catch (e) {
      _volumeControllable = false;
    }
  }
  return _volumeControllable;
}

// How far the current song is turned down: its measured loudness against
// the library's (levelTarget in js/data/waveform.js). A song not measured
// yet is taken to be as loud as the library's typical song.
function trackLevelGain(track) {
  if (!track || !evenVolumeOn()) return 1;
  var values = tracks.map(function(item) { return item.lufs; });
  var target = levelTarget(values);
  if (target === null) return 1;
  var own = getVaultTrack(track.id) || track;
  return levelGain(isMeasuredLoudness(own.lufs) && own.lufs > -60 ? own.lufs : typicalLoudness(values), target);
}

function playbackVolume() {
  return _userVolume * trackLevelGain(_currentTrack);
}

function toggleEvenVolume() {
  _playerPrefs.level = !(_playerPrefs.level !== false);
  savePlayerPrefs();
  updateLevelButton();
  applyPlaybackLevel();
  showToast(evenVolumeOn() ? 'Even volume on: loud songs play quieter to match the rest' : 'Even volume off');
}

// Brings a playing song to its level now, gently: after the switch, or
// when its loudness has just been measured.
function applyPlaybackLevel() {
  if (_rampPurpose === 'sleep' || _rampPurpose === 'tail') return;
  if (_isPlaying) rampVolume(playbackVolume(), 600, 'level');
  else setElementVolume(playbackVolume());
}

// From ensureWaveformForTrack (js/features/waveform.js).
function onTrackLoudnessMeasured(trackId) {
  if (_currentTrack && _currentTrack.id === trackId) applyPlaybackLevel();
}

function updateLevelButton() {
  var btn = document.getElementById('xp-level-btn');
  if (!btn) return;
  btn.hidden = !volumeControllable();
  var on = evenVolumeOn();
  btn.classList.toggle('mode-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Even volume: on. Loud songs play quieter to match the rest.' : 'Even volume: off';
}

// ─── Sleep timer ─────────────────────────────────────────────────────────────

function cycleSleepTimer() {
  var idx = SLEEP_STEPS.indexOf(_sleep.mode === 'minutes' ? _sleep.minutes : _sleep.mode);
  var next = SLEEP_STEPS[(idx + 1) % SLEEP_STEPS.length];
  clearInterval(_sleepTicker);
  _sleepTicker = null;
  if (next === 'off') {
    _sleep = { mode:'off', endsAt:0 };
    showToast('Sleep timer off');
  } else if (next === 'track') {
    _sleep = { mode:'track', endsAt:0 };
    showToast('Stopping when this song ends');
  } else {
    _sleep = { mode:'minutes', minutes:next, endsAt:Date.now() + next * 60000 };
    _sleepTicker = setInterval(sleepTick, 1000);
    showToast('Sleep timer: ' + next + ' minutes');
  }
  updateSleepButton();
}

function sleepRemainingLabel() {
  if (_sleep.mode === 'track') return 'End';
  if (_sleep.mode !== 'minutes') return '';
  var left = Math.max(0, _sleep.endsAt - Date.now());
  return left >= 60000 ? Math.ceil(left / 60000) + 'm' : Math.ceil(left / 1000) + 's';
}

function sleepTick() {
  if (_sleep.mode !== 'minutes') return;
  if (Date.now() >= _sleep.endsAt) {
    clearInterval(_sleepTicker);
    _sleepTicker = null;
    _sleep = { mode:'off', endsAt:0 };
    fadeOutAndPause();
  }
  updateSleepButton();
}

// Time up: down to silence, pause, and the level put back for next time.
function fadeOutAndPause() {
  if (!_isPlaying) { updateSleepButton(); return; }
  rampVolume(0, SLEEP_FADE_MS, 'sleep', function() {
    if (_isPlaying) togglePlayback();
    setElementVolume(playbackVolume());
    showToast('Sleep timer: paused');
  });
}

// Called by the 'ended' handler in player.js: whether this song's end is
// where the sleep timer stops playback.
function consumeSleepAtTrackEnd() {
  if (_sleep.mode !== 'track') return false;
  _sleep = { mode:'off', endsAt:0 };
  updateSleepButton();
  showToast('Sleep timer: stopped after the song');
  return true;
}

function updateSleepButton() {
  var btn = document.getElementById('xp-sleep-btn');
  if (!btn) return;
  var label = sleepRemainingLabel();
  var on = _sleep.mode !== 'off';
  btn.classList.toggle('mode-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  var text = btn.querySelector('.player-pill-text');
  if (text) text.textContent = on ? label : 'Sleep';
  var title = !on ? 'Sleep timer: off' : (_sleep.mode === 'track' ? 'Sleep timer: stop after this song' : 'Sleep timer: ' + label + ' left');
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

// ─── Smooth transitions ──────────────────────────────────────────────────────

function smoothTransitionsOn() {
  return _playerPrefs.smooth === true;
}

function toggleSmoothTransitions() {
  _playerPrefs.smooth = !smoothTransitionsOn();
  savePlayerPrefs();
  updateSmoothButton();
  showToast(smoothTransitionsOn() ? 'Songs fade into each other' : 'Fades between songs off');
}

function updateSmoothButton() {
  var btn = document.getElementById('xp-smooth-btn');
  if (!btn) return;
  var on = smoothTransitionsOn();
  btn.classList.toggle('mode-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Fade between songs: on' : 'Fade between songs: off';
}

// Warm the next song a little before the end: the service worker caches the
// whole file on first fetch, so the switch then plays from cache.
function preloadNextTrack() {
  var next = getNextTrack();
  if (!next || !next.audioURL || next.id === _preloadedId || (_currentTrack && next.id === _currentTrack.id)) return;
  _preloadedId = next.id;
  if (!_preloadAudio) {
    _preloadAudio = new Audio();
    _preloadAudio.preload = 'auto';
    _preloadAudio.muted = true;
  }
  _preloadAudio.src = next.audioURL;
  try { _preloadAudio.load(); } catch (e) {}
}

// From timeupdate in player.js. The last seconds of a song fade down when
// another follows; the next one fades in from 'playing' above.
function smoothTransitionTick() {
  if (!smoothTransitionsOn() || !_audio.duration || !_isPlaying) return;
  var left = _audio.duration - _audio.currentTime;
  if (left <= PRELOAD_BEFORE_END_S) preloadNextTrack();
  if (_tailFading || _repeatMode === 'one' || _sleep.mode === 'track' || _rampPurpose === 'sleep') return;
  if (left <= TRANSITION_FADE_S && left > 0.2 && getNextTrack()) {
    _tailFading = true;
    rampVolume(0, left * 1000 / (_audio.playbackRate || 1), 'tail');
  }
}

function renderPlaybackExtras() {
  updateSleepButton();
  updateSmoothButton();
  updateLevelButton();
}
