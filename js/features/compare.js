// Compare takes: every take of a song in one dialog, one playing at a time,
// and a tap on another switches to it at the same place in the song -- the
// same line, as far through it, when both are timed (mapTakeTime in
// js/data/versions.js) -- so two performances can be judged moment by
// moment. Takes play equally loud (matchTakeLoudness), or the louder one
// would win for being louder. Each shows its sung check and can be made the
// main take. The main player pauses while the dialog is open.

var _compare = null;   // { takes: [{ track, audio, times, gain }], active, playing, frame }

function openCompareTakes(id) {
  var track = getVaultTrack(id);
  var group = track && getVersionGroup(track);
  if (!group || group.length < 2) { showToast('This song has only one take.'); return; }
  closeCompareAudio();
  if (_isPlaying) togglePlayback();
  var gains = matchTakeLoudness(group.map(function(take) { return take.lufs; }));
  var takes = group.slice(0, 4).map(function(take, i) {
    var audio = new Audio();
    audio.preload = 'auto';
    audio.src = take.audioURL || take.audioData || '';
    audio.addEventListener('ended', function() {
      if (_compare && _compare.takes[_compare.active] && _compare.takes[_compare.active].audio === audio) {
        _compare.playing = false;
        renderCompare();
      }
    });
    return { track:take, audio:audio, gain:gains[i], times:null };
  });
  var start = Math.max(0, takes.findIndex(function(take) { return take.track.id === id; }));
  _compare = { takes:takes, active:start, playing:false, frame:0, song:baseSongTitle(track.title) || track.title || 'Untitled' };
  applyCompareVolumes();
  openModal('modal-compare');
  renderCompare();
  compareFrame();
}

function compareCurrentTrack() {
  if (_currentTrack) openCompareTakes(_currentTrack.id);
}

// Called by closeModal however the dialog closes.
function onCompareClosed() {
  closeCompareAudio();
}

function closeCompareAudio() {
  if (!_compare) return;
  cancelAnimationFrame(_compare.frame);
  _compare.takes.forEach(function(take) {
    take.audio.pause();
    take.audio.removeAttribute('src');
    take.audio.load();
  });
  _compare = null;
}

function applyCompareVolumes() {
  if (!_compare) return;
  _compare.takes.forEach(function(take) {
    try { take.audio.volume = Math.max(0, Math.min(1, _userVolume * take.gain)); } catch (e) {}
  });
}

// A take's line timings, once its length is known.
function compareTimes(take) {
  if (take.times) return take.times;
  var duration = take.audio.duration || Number(take.track.duration) || 0;
  if (!duration || !hasUsableLyricTimes(take.track)) return null;
  take.times = resolveLyricTimes(getLyricSync(take.track).lines, duration);
  return take.times;
}

function switchCompareTake(index) {
  if (!_compare || index === _compare.active || !_compare.takes[index]) return;
  var from = _compare.takes[_compare.active];
  var to = _compare.takes[index];
  var at = mapTakeTime(compareTimes(from), compareTimes(to), from.audio.currentTime || 0, to.audio.duration || to.track.duration);
  from.audio.pause();
  try { to.audio.currentTime = at; } catch (e) {}
  _compare.active = index;
  if (_compare.playing) to.audio.play().catch(function() {});
  renderCompare();
}

function toggleComparePlayback() {
  if (!_compare) return;
  var take = _compare.takes[_compare.active];
  if (_compare.playing) {
    take.audio.pause();
    _compare.playing = false;
  } else {
    if (_isPlaying) togglePlayback();
    take.audio.play().catch(function() {});
    _compare.playing = true;
  }
  renderCompare();
}

function seekCompare(event) {
  if (!_compare) return;
  var take = _compare.takes[_compare.active];
  var rect = event.currentTarget.getBoundingClientRect();
  if (!take.audio.duration || !rect.width) return;
  take.audio.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * take.audio.duration;
}

function makeCompareMain(index) {
  if (!_compare || !_compare.takes[index]) return;
  setMainVersion(_compare.takes[index].track.id);
  renderCompare();
}

function renderComparePlay() {
  var btn = document.getElementById('compare-play');
  if (btn && _compare) setPlayButton(btn, _compare.playing);
}

function renderCompare() {
  if (!_compare) return;
  var group = _compare.takes.map(function(take) { return take.track; });
  var main = primaryVersion(group);
  document.getElementById('compare-song').textContent = _compare.song;
  document.getElementById('compare-takes').innerHTML = _compare.takes.map(function(take, i) {
    var active = i === _compare.active;
    var check = sungCheckSummary(take.track);
    var isMain = take.track === main;
    return '<div class="compare-take' + (active ? ' active' : '') + '">'
      + '<button type="button" class="compare-pick" aria-pressed="' + active + '" onclick="switchCompareTake(' + i + ')">'
      +   buildCoverArt(take.track, 'xs', false)
      +   '<span class="compare-name">' + esc(versionLabel(take.track, group)) + (active ? ' <span class="compare-now">' + (_compare.playing ? 'Playing' : 'Selected') + '</span>' : '') + '</span>'
      +   '<span class="compare-facts">' + fmtTime(take.audio.duration || take.track.duration || 0) + ' · ' + fmtCompactNumber(take.track.plays || 0) + (Number(take.track.plays) === 1 ? ' play' : ' plays') + '</span>'
      +   '<span class="compare-check">' + esc(check || (hasLyrics(take.track) ? 'Sung check not run yet' : 'Instrumental')) + '</span>'
      + '</button>'
      + (isMain ? '<span class="version-main">Main</span>' : '<button type="button" class="sec-action compare-main" onclick="makeCompareMain(' + i + ')">Make main</button>')
      + '</div>';
  }).join('');
  var measured = _compare.takes.filter(function(take) { return isMeasuredLoudness(take.track.lufs) && take.track.lufs > -60; }).length;
  document.getElementById('compare-note').textContent = !volumeControllable()
    ? 'Tap a take to switch to it at the same place in the song. (This device plays each take at its own loudness.)'
    : 'Tap a take to switch to it at the same place in the song.'
      + (measured === _compare.takes.length ? ' ' + (_compare.takes.length === 2 ? 'Both' : 'All ' + _compare.takes.length) + ' play equally loud, so a louder take doesn’t win for being louder.' : '');
  renderComparePlay();
  compareFrame(true);
}

// The playhead, the time, and the line being sung in the take playing.
function compareFrame(once) {
  if (!_compare) return;
  var take = _compare.takes[_compare.active];
  var t = take.audio.currentTime || 0;
  var duration = take.audio.duration || Number(take.track.duration) || 0;
  document.getElementById('compare-fill').style.width = duration ? Math.min(100, t / duration * 100).toFixed(2) + '%' : '0%';
  document.getElementById('compare-time').textContent = fmtTime(t) + ' / ' + fmtTime(duration);
  var times = compareTimes(take);
  var idx = times ? currentLyricIndex(times, t) : -1;
  var line = idx >= 0 ? sungLyricLines(getTrackLyrics(take.track))[idx] : '';
  var lineEl = document.getElementById('compare-line');
  var text = line ? '♪ ' + line : '';
  if (lineEl.textContent !== text) lineEl.textContent = text;
  if (once === true) return;
  _compare.frame = requestAnimationFrame(function() { compareFrame(); });
}

// Space plays and pauses; the arrow keys move between takes.
document.addEventListener('keydown', function(e) {
  if (!_compare || e.metaKey || e.ctrlKey || e.altKey) return;
  var overlay = document.getElementById('modal-compare');
  if (!overlay || !overlay.classList.contains('open')) return;
  var tag = (e.target && e.target.tagName || '').toUpperCase();
  if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'INPUT') {
    e.preventDefault();
    toggleComparePlayback();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    var n = _compare.takes.length;
    switchCompareTake((_compare.active + (e.key === 'ArrowRight' ? 1 : n - 1)) % n);
  }
});

// The "Compare takes" item in the menu of a song with more than one take.
function compareMenuItem(track) {
  var group = getVersionGroup(track);
  if (!group || group.length < 2) return '';
  return '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();openCompareTakes(' + jsq(track.id) + ')">Compare takes</button>';
}
