// Playback: the one Audio element, the queue with shuffle and repeat, the
// player prefs, and the docked now-playing bar.

var _audio = new Audio();
var _currentTrack = null;
var _isPlaying = false;
var _playQueueIds = [];
var _playQueueLabel = 'Vault';

var PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];
var _playerPrefs = loadPlayerPrefs();
var _shuffleMode = _playerPrefs.shuffle === true;
var _repeatMode = (_playerPrefs.repeat === 'all' || _playerPrefs.repeat === 'one') ? _playerPrefs.repeat : 'off';
var _playbackRate = PLAYBACK_RATES.indexOf(Number(_playerPrefs.rate)) !== -1 ? Number(_playerPrefs.rate) : 1;
var _shuffleOrder = [];
// The listener's own level. Fades (js/features/playback-extras.js) move
// _audio.volume and come back to this, so it is what gets saved and shown.
var _userVolume = (typeof _playerPrefs.volume === 'number' && _playerPrefs.volume >= 0 && _playerPrefs.volume <= 1) ? _playerPrefs.volume : 1;
_audio.volume = _userVolume;
_audio.defaultPlaybackRate = _playbackRate;
_audio.playbackRate = _playbackRate;

function setPlaybackQueue(ids, label) {
  var next = (ids || []).slice();
  var changed = next.length !== _playQueueIds.length || next.some(function(id, i) { return id !== _playQueueIds[i]; });
  _playQueueIds = next;
  _playQueueLabel = label || 'Vault';
  if (_shuffleMode && (changed || _shuffleOrder.length !== _playQueueIds.length)) rebuildShuffleOrder();
  if (_currentTrack) updateMediaSession();
}

// Fisher-Yates over the canonical queue. The current track is pinned to
// the front so toggling shuffle mid-listen never causes an instant skip.
function rebuildShuffleOrder() {
  var ids = _playQueueIds.slice();
  for (var i = ids.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = ids[i];
    ids[i] = ids[j];
    ids[j] = temp;
  }
  if (_currentTrack) {
    var idx = ids.indexOf(_currentTrack.id);
    if (idx > 0) {
      ids.splice(idx, 1);
      ids.unshift(_currentTrack.id);
    }
  }
  _shuffleOrder = ids;
}

// Queue in the order playback will actually walk it: shuffled when
// shuffle is on, canonical otherwise.
function getOrderedQueueTracks() {
  var ids = _shuffleMode && _shuffleOrder.length === _playQueueIds.length ? _shuffleOrder : _playQueueIds;
  return ids.map(function(id) { return getTrackById(id); }).filter(Boolean);
}

// Reorder the live queue by one slot. Mutates whichever order is actually
// driving playback (shuffle order when shuffled, canonical queue otherwise),
// so next/prev follow the new sequence immediately.
function moveQueueTrack(id, dir) {
  var useShuffle = _shuffleMode && _shuffleOrder.length === _playQueueIds.length;
  var arr = (useShuffle ? _shuffleOrder : _playQueueIds).slice();
  var idx = arr.indexOf(id);
  if (idx === -1) return;
  var target = idx + dir;
  if (target < 0 || target >= arr.length) return;
  var tmp = arr[target]; arr[target] = arr[idx]; arr[idx] = tmp;
  if (useShuffle) _shuffleOrder = arr; else _playQueueIds = arr;
  if (_currentTrack) updateMediaSession();
  updateExpandedPlayer();
}

function getNextTrack() {
  if (!_currentTrack) return null;
  var queue = getOrderedQueueTracks();
  if (!queue.length) return null;
  var idx = queue.findIndex(function(track) { return track.id === _currentTrack.id; });
  if (idx === -1) return null;
  if (idx >= queue.length - 1) return _repeatMode === 'all' ? queue[0] : null;
  return queue[idx + 1];
}

function getPreviousTrack() {
  if (!_currentTrack) return null;
  var queue = getOrderedQueueTracks();
  if (!queue.length) return null;
  var idx = queue.findIndex(function(track) { return track.id === _currentTrack.id; });
  if (idx === -1) return null;
  if (idx <= 0) return _repeatMode === 'all' ? queue[queue.length - 1] : null;
  return queue[idx - 1];
}

function loadPlayerPrefs() {
  try { return JSON.parse(localStorage.getItem('sv_player_prefs')) || {}; } catch (e) { return {}; }
}

function savePlayerPrefs() {
  localStorage.setItem('sv_player_prefs', JSON.stringify({
    shuffle: _shuffleMode,
    repeat: _repeatMode,
    volume: _userVolume,
    rate: _playbackRate,
    smooth: _playerPrefs.smooth === true,
    level: _playerPrefs.level !== false
  }));
}

function toggleShuffle() {
  _shuffleMode = !_shuffleMode;
  if (_shuffleMode) rebuildShuffleOrder();
  savePlayerPrefs();
  updatePlayerModeUI();
  if (_currentTrack) updateNowPlaying();
  showToast(_shuffleMode ? 'Shuffle on' : 'Shuffle off');
}

function cycleRepeat() {
  _repeatMode = _repeatMode === 'off' ? 'all' : (_repeatMode === 'all' ? 'one' : 'off');
  savePlayerPrefs();
  updatePlayerModeUI();
  if (_currentTrack) updateNowPlaying();
  showToast(_repeatMode === 'off' ? 'Repeat off' : (_repeatMode === 'all' ? 'Repeat queue' : 'Repeat one'));
}

function setPlayerVolume(value) {
  var vol = Math.max(0, Math.min(1, Number(value) || 0));
  if (typeof cancelVolumeRamp === 'function') cancelVolumeRamp();
  _userVolume = vol;
  _audio.volume = typeof playbackVolume === 'function' ? playbackVolume() : vol;
  savePlayerPrefs();
  updatePlayerModeUI();
}

function applyPlaybackRate() {
  _audio.defaultPlaybackRate = _playbackRate;
  _audio.playbackRate = _playbackRate;
}

function cyclePlaybackRate() {
  var idx = PLAYBACK_RATES.indexOf(_playbackRate);
  _playbackRate = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
  applyPlaybackRate();
  savePlayerPrefs();
  updatePlayerModeUI();
  updateMediaSessionPosition();
  showToast('Speed ' + _playbackRate + 'x');
}

function updatePlayerModeUI() {
  var npShuffle = document.getElementById('np-shuffle-btn');
  var npRepeat = document.getElementById('np-repeat-btn');
  var xpShuffle = document.getElementById('xp-shuffle-btn');
  var xpRepeat = document.getElementById('xp-repeat-btn');
  var xpVolume = document.getElementById('xp-volume');
  var xpVolumePct = document.getElementById('xp-volume-pct');
  var xpRate = document.getElementById('xp-rate-btn');
  var repeatLabel = _repeatMode === 'off' ? 'Repeat: off' : (_repeatMode === 'all' ? 'Repeat: queue' : 'Repeat: one track');
  [npShuffle, xpShuffle].forEach(function(btn) {
    if (!btn) return;
    btn.classList.toggle('mode-on', _shuffleMode);
    btn.setAttribute('aria-pressed', _shuffleMode ? 'true' : 'false');
  });
  [npRepeat, xpRepeat].forEach(function(btn) {
    if (!btn) return;
    btn.innerHTML = icon(_repeatMode === 'one' ? 'repeat-one' : 'repeat');
    btn.classList.toggle('mode-on', _repeatMode !== 'off');
    btn.title = repeatLabel;
    btn.setAttribute('aria-label', repeatLabel);
  });
  var volPct = Math.round((_userVolume || 0) * 100);
  if (xpVolume && Number(xpVolume.value) !== volPct) xpVolume.value = volPct;
  if (xpVolumePct) xpVolumePct.textContent = volPct + '%';
  if (xpRate) xpRate.textContent = _playbackRate + 'x';
  if (typeof renderPlaybackExtras === 'function') renderPlaybackExtras();
}

function applyTrackTint(track) {
  var palette = getCoverPalette(track || {});
  document.documentElement.style.setProperty('--accent-dynamic', palette.accent);
  document.documentElement.style.setProperty('--accent-dynamic-soft', palette.soft);
  document.documentElement.style.setProperty('--accent-dynamic-deep', palette.deep);
}

function rememberPlayback(track) {
  // Demo songs live in memory: playing one must not write the vault's
  // settings (a signed-out visitor's write would sit unsaved in the queue).
  if (!track || (typeof _coverDemoActive !== 'undefined' && _coverDemoActive)) return;
  appSettings = window.appSettings || {};
  var history = Array.isArray(appSettings.playHistory) ? appSettings.playHistory.slice() : [];
  history = history.filter(function(id) { return id !== track.id; });
  history.unshift(track.id);
  appSettings.lastPlayedTrackId = track.id;
  appSettings.lastPlayedAt = Date.now();
  appSettings.playHistory = history.slice(0, 24);
  window.appSettings = appSettings;
  save('settings', appSettings);
}

function updateNowPlaying() {
  var bar = document.getElementById('now-playing');
  var art = document.getElementById('np-art');
  var mobileNav = document.getElementById('mobile-nav');
  if (!_currentTrack) {
    bar.classList.remove('active');
    if (mobileNav) mobileNav.classList.remove('player-active');
    art.innerHTML = '';
    art.removeAttribute('data-cover');
    document.getElementById('np-name').textContent = 'Choose a track';
    document.getElementById('np-genre').textContent = 'Your private AI label is ready.';
    document.getElementById('np-queue').textContent = 'Queue awareness activates when playback starts.';
    setPlayButton(document.getElementById('np-play-btn'), false);
    document.getElementById('np-current').textContent = '0:00';
    document.getElementById('np-total').textContent = '0:00';
    document.getElementById('np-bar-fill').style.width = '0%';
    clearMediaSession();
    updateExpandedPlayer();
    syncPlayerHeightVar();
    if (_routeState.mode !== 'app') renderRouteAwareView(true);
    return;
  }

  bar.classList.add('active');
  if (mobileNav) mobileNav.classList.add('player-active');
  swapCover(art, _currentTrack, 'sm', false);
  syncPlayerLiveState();
  document.getElementById('np-name').textContent = _currentTrack.title;
  document.getElementById('np-genre').textContent = (_currentTrack.genre || 'Other') + ' / ' + (_currentTrack.mood || 'Mood') + ' / ' + (_currentTrack.source || 'Suno');
  var next = _repeatMode === 'one' ? null : getNextTrack();
  var orderedQueue = getOrderedQueueTracks();
  var queueCount = orderedQueue.length;
  var queueLine = _playQueueLabel + ' queue';
  if (_shuffleMode) queueLine += ' / Shuffle';
  if (queueCount) queueLine += ' / ' + (orderedQueue.findIndex(function(track) { return track.id === _currentTrack.id; }) + 1) + ' of ' + queueCount;
  if (next) queueLine += ' / Next: ' + next.title;
  document.getElementById('np-queue').textContent = queueLine;
  setPlayButton(document.getElementById('np-play-btn'), _isPlaying);
  applyTrackTint(_currentTrack);
  updateMobileNavPulse();
  updateMediaSession();
  updateExpandedPlayer();
  syncPlayerHeightVar();
  if (_routeState.mode !== 'app') renderRouteAwareView(true);
}

function updateMobileNavPulse() {
  var nav = document.getElementById('mobile-nav');
  if (!nav) return;
  if (_currentTrack && _isPlaying) nav.classList.add('is-playing');
  else nav.classList.remove('is-playing');
}

// The player is fluid -- at 375px the title, metadata and queue line all wrap
// and it renders ~243px tall, not the 118px the layout used to assume. The
// mobile nav, page bottom padding and the toast all position off this
// variable, so a stale constant buried the nav underneath the player.
// Layout height plus the bar's own bottom inset, so the value covers all the
// space it occupies. Deliberately uses offsetHeight rather than
// getBoundingClientRect(): the bar slides in on a 220ms transform, and a rect
// read during that slide reports the off-screen position, which nothing would
// ever correct -- ResizeObserver does not fire for a transform.
function syncPlayerHeightVar() {
  var bar = document.getElementById('now-playing');
  if (!bar) return;
  var occupied = 0;
  if (bar.classList.contains('active')) {
    var inset = parseFloat(getComputedStyle(bar).bottom) || 0;
    occupied = Math.ceil(bar.offsetHeight + inset);
  }
  document.documentElement.style.setProperty('--player-height', occupied + 'px');
}

// Throttle the expensive expanded-waveform DOM rebuild to ~5fps.
// timeupdate fires ~60x/sec; rebuilding 72 bars on each tick caused
// noticeable layout cost during long tracks.
var _lastWaveDraw = 0;
var WAVE_DRAW_INTERVAL_MS = 200;
_audio.addEventListener('timeupdate', function() {
  if (!_currentTrack) return;
  var pct = _audio.duration ? (_audio.currentTime / _audio.duration) * 100 : 0;
  document.getElementById('np-bar-fill').style.width = pct + '%';
  document.getElementById('np-current').textContent = fmtTime(_audio.currentTime);
  updateWaveformProgress(_currentTrack.id, pct / 100);
  document.getElementById('xp-current').textContent = fmtTime(_audio.currentTime);
  document.getElementById('xp-total').textContent = fmtTime(_audio.duration || _currentTrack.duration || 0);
  document.getElementById('xp-progress-fill').style.width = pct + '%';
  var now = Date.now();
  if (now - _lastWaveDraw >= WAVE_DRAW_INTERVAL_MS) {
    var xpWave = document.getElementById('xp-wave');
    if (xpWave && document.getElementById('modal-now-playing').classList.contains('open')) {
      xpWave.innerHTML = renderExpandedWaveform(_currentTrack);
      syncPlayerLiveState();
      updateLyricHighlight(false);
      _lastWaveDraw = now;
    }
  }
  updateMediaSessionPosition();
  maybeSyncLyrics();
  if (typeof smoothTransitionTick === 'function') smoothTransitionTick();
});

_audio.addEventListener('loadedmetadata', function() {
  document.getElementById('np-total').textContent = fmtTime(_audio.duration);
  document.getElementById('xp-total').textContent = fmtTime(_audio.duration);
  updateMediaSession();
});

// Keep the mobile-nav pulse in sync with native audio play/pause events,
// in addition to updateNowPlaying() which already runs on most state changes.
_audio.addEventListener('play', function() { if (typeof updateMobileNavPulse === 'function') updateMobileNavPulse(); syncPlayerLiveState(); });
_audio.addEventListener('pause', function() { if (typeof updateMobileNavPulse === 'function') updateMobileNavPulse(); syncPlayerLiveState(); });

_audio.addEventListener('ended', function() {
  _isPlaying = false;
  // The sleep timer set to "end of song" stops here, whatever comes next.
  if (typeof consumeSleepAtTrackEnd === 'function' && consumeSleepAtTrackEnd()) {
    updateNowPlaying();
    renderTracks();
    return;
  }
  if (_repeatMode === 'one' && _currentTrack) {
    _audio.currentTime = 0;
    _audio.play().catch(function(e) { console.error('Repeat playback error:', e); });
    _isPlaying = true;
    updateNowPlaying();
    return;
  }
  var next = getNextTrack();
  if (next) {
    startPlayback(next.id, _playQueueIds, _playQueueLabel);
  } else {
    document.querySelectorAll('.track-card.playing').forEach(function(card) {
      card.classList.remove('playing');
    });
    updateNowPlaying();
  }
});

_audio.addEventListener('play', function() {
  _isPlaying = true;
  updateMediaSession();
});

_audio.addEventListener('pause', function() {
  _isPlaying = false;
  updateMediaSession();
});

function startPlayback(id, queueIds, queueLabel) {
  var track = getTrackById(id);
  if (!track) return;
  var privateTrack = tracks.find(function(item) { return item.id === id; }) || null;

  if (queueIds && queueIds.length) {
    setPlaybackQueue(queueIds, queueLabel);
  } else {
    var filtered = getShelfQueueTracks().map(function(item) { return item.id; });
    if (filtered.length && filtered.indexOf(id) === -1) filtered = queueWithVersion(filtered, track);
    setPlaybackQueue(filtered.length ? filtered : tracks.map(function(item) { return item.id; }), 'Filtered shelf');
  }

  document.querySelectorAll('.track-card.playing').forEach(function(card) {
    card.classList.remove('playing');
  });

  if (_currentTrack && _currentTrack.id === id && _isPlaying) {
    _audio.pause();
    _isPlaying = false;
    updateNowPlaying();
    renderTracks();
    return;
  }

  _currentTrack = track;
  if (track.audioURL) {
    _audio.src = track.audioURL;
  } else if (track.audioData) {
    _audio.src = track.audioData;
  } else {
    showToast('No audio source found for this track');
    return;
  }
  ensureWaveformForTrack(track);

  applyPlaybackRate();
  _audio.play().catch(function(e) {
    console.error('Playback error:', e);
    showToast('Playback failed in this browser');
  });
  _isPlaying = true;
  if (privateTrack) {
    privateTrack.plays = Number(privateTrack.plays || 0) + 1;
    if (track !== privateTrack) track.plays = Number(track.plays || 0) + 1;
    persistTracks();
    rememberPlayback(privateTrack);
  } else {
    track.plays = Number(track.plays || 0) + 1;
  }
  updateNowPlaying();
  renderTracks(); // already refreshes the hero — no second renderLibraryHome()
}

function playTrack(id) {
  startPlayback(id, null, null);
}

function playPlaylist(playlistId) {
  var pl = getPlaylistById(playlistId);
  if (!pl || !pl.trackIds || !pl.trackIds.length) return;
  startPlayback(pl.trackIds[0], pl.trackIds.slice(), pl.name);
}

function playPlaylistTrack(playlistId, trackId) {
  var pl = getPlaylistById(playlistId);
  if (!pl) return;
  startPlayback(trackId, pl.trackIds.slice(), pl.name);
}

function playNext() {
  var next = getNextTrack();
  if (next) startPlayback(next.id, _playQueueIds, _playQueueLabel);
}

function playPrevious() {
  var prev = getPreviousTrack();
  if (prev) startPlayback(prev.id, _playQueueIds, _playQueueLabel);
}

function togglePlayback() {
  if (!_currentTrack) {
    var featured = getFeaturedTrack();
    if (featured) playTrack(featured.id);
    return;
  }
  if (_isPlaying) {
    _audio.pause();
    _isPlaying = false;
  } else {
    _audio.play();
    _isPlaying = true;
  }
  updateNowPlaying();
  renderTracks();
}

function seekAudio(e, targetId) {
  if (!_audio.duration) return;
  var rect = document.getElementById(targetId || 'np-bar-wrap').getBoundingClientRect();
  var pct = (e.clientX - rect.left) / rect.width;
  _audio.currentTime = Math.max(0, Math.min(1, pct)) * _audio.duration;
  updateMediaSessionPosition();
}
