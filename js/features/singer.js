// Karaoke with the singer off. Karaoke then plays the song through its own
// audio element: the instrumental attached to the song (Suno's stem,
// uploaded once as track.instrumentalURL -- clean, and the same length, so
// the lyric timings hold), or failing that the song itself with the voice
// turned down in the browser (buildVocalReducer). The main player waits,
// paused and muted, at the same moment, and carries on from wherever the
// singer comes back or karaoke closes. Its own element keeps the Web Audio
// routing that the reducer needs away from the main player, which has to
// keep playing with the screen locked.

var _singer = { off:false, mode:'', audio:null, ctx:null, source:null, reducer:null, direct:null, trackId:'', uploading:false };

// The voice usually sits in the middle of a stereo mix, and so do the bass
// and kick. Everything in the middle (L + R) except the bass is taken out;
// the sides (L - R) -- guitars, keys, reverb panned wide -- stay, a little
// louder to make up for it. A faint voice remains wherever the mix put
// echo or doubling on the sides.
function buildVocalReducer(ctx, input, output) {
  var splitter = ctx.createChannelSplitter(2);
  var merger = ctx.createChannelMerger(2);
  var gain = function(v) { var g = ctx.createGain(); g.gain.value = v; return g; };
  var lMid = gain(.5), rMid = gain(.5), lSide = gain(.5), rSide = gain(-.5);
  var mid = gain(1), side = gain(1.4), invert = gain(-1);
  var bass = ctx.createBiquadFilter();
  bass.type = 'lowpass';
  bass.frequency.value = 160;
  bass.Q.value = .7;
  input.connect(splitter);
  splitter.connect(lMid, 0);
  splitter.connect(rMid, 1);
  splitter.connect(lSide, 0);
  splitter.connect(rSide, 1);
  lMid.connect(mid);
  rMid.connect(mid);
  lSide.connect(side);
  rSide.connect(side);
  mid.connect(bass);
  bass.connect(merger, 0, 0);
  bass.connect(merger, 0, 1);
  side.connect(merger, 0, 0);
  side.connect(invert);
  invert.connect(merger, 0, 1);
  merger.connect(output);
  return merger;
}

function singerSupported() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

// The element karaoke plays through with the singer off, routed once:
// straight out for an instrumental, through the reducer for the song.
function singerAudio() {
  if (_singer.audio) return _singer.audio;
  var audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  audio.addEventListener('ended', onSingerEnded);
  _singer.audio = audio;
  return audio;
}

function routeSinger(mode) {
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!_singer.ctx) {
    _singer.ctx = new Ctx();
    _singer.source = _singer.ctx.createMediaElementSource(singerAudio());
    _singer.direct = _singer.ctx.createGain();
    _singer.reduced = _singer.ctx.createGain();
    _singer.source.connect(_singer.direct);
    _singer.direct.connect(_singer.ctx.destination);
    buildVocalReducer(_singer.ctx, _singer.source, _singer.reduced);
    _singer.reduced.connect(_singer.ctx.destination);
  }
  _singer.direct.gain.value = mode === 'instrumental' ? 1 : 0;
  _singer.reduced.gain.value = mode === 'reduced' ? 1 : 0;
  try { _singer.ctx.resume(); } catch (e) {}
}

// What karaoke times, plays and seeks: its own element with the singer off.
function singerClock() {
  return _singer.off && _singer.audio ? _singer.audio : _audio;
}

function karaokeTogglePlay() {
  if (!_singer.off) { togglePlayback(); return; }
  var audio = _singer.audio;
  if (audio.paused) {
    try { _singer.ctx.resume(); } catch (e) {}
    audio.play().catch(function() {});
  } else {
    audio.pause();
  }
}

function singerSourceFor(track) {
  return track.instrumentalURL ? { url:track.instrumentalURL, mode:'instrumental' } : { url:track.audioURL || track.audioData || '', mode:'reduced' };
}

// Loads `track` into the singer's element at `at` seconds, playing or not.
function loadSingerTrack(track, at, play) {
  var pick = singerSourceFor(track);
  if (!pick.url) return false;
  var audio = singerAudio();
  routeSinger(pick.mode);
  _singer.mode = pick.mode;
  _singer.trackId = track.id;
  try { audio.volume = typeof playbackVolume === 'function' ? Math.max(0, Math.min(1, playbackVolume())) : 1; } catch (e) {}
  var start = function() {
    try { audio.currentTime = Math.min(at, Math.max(0, (audio.duration || at + 1) - .5)); } catch (e) {}
    if (play) audio.play().catch(function() {});
  };
  if (audio.getAttribute('src') === pick.url && audio.readyState >= 1) start();
  else {
    audio.src = pick.url;
    audio.addEventListener('loadedmetadata', start, { once:true });
    audio.load();
  }
  return true;
}

function setSingerOff(off) {
  var track = karaokeTrack();
  if (!track || off === _singer.off) return;
  if (off) {
    if (!singerSupported()) { showToast('This browser can’t take the singer out.'); return; }
    var at = _audio.currentTime || 0;
    var playing = !_audio.paused;
    _audio.muted = true;
    if (playing) pauseMainForSinger();
    _singer.off = true;
    if (!loadSingerTrack(track, at, playing)) { setSingerOff(false); return; }
  } else {
    var audio = _singer.audio;
    var resumeAt = audio ? audio.currentTime || 0 : _audio.currentTime;
    var wasPlaying = audio && !audio.paused;
    if (audio) audio.pause();
    _singer.off = false;
    _audio.muted = false;
    try { _audio.currentTime = resumeAt; } catch (e) {}
    if (wasPlaying && _audio.paused) togglePlayback();
  }
  renderSingerControls();
}

function pauseMainForSinger() {
  if (_isPlaying) togglePlayback();
  else _audio.pause();
}

function toggleSinger() {
  setSingerOff(!_singer.off);
}

// The end of a song with the singer off: on to the next one, still off.
// The main player starts it muted and is paused again once it plays.
function onSingerEnded() {
  if (!_singer.off) return;
  var before = _currentTrack && _currentTrack.id;
  playNext();
  if (!_currentTrack || _currentTrack.id === before) return;
  _audio.addEventListener('playing', function() { if (_singer.off) pauseMainForSinger(); }, { once:true });
  loadSingerTrack(getVaultTrack(_currentTrack.id) || _currentTrack, 0, true);
}

// A different song while the singer is off (Next, or the queue): follow it.
function singerFollowTrack(track) {
  if (!_singer.off || !track || _singer.trackId === track.id) return;
  _audio.muted = true;
  pauseMainForSinger();
  loadSingerTrack(track, _audio.currentTime || 0, true);
}

// Called when karaoke closes: the singer comes back where karaoke left off.
function onSingerKaraokeClosed() {
  if (_singer.off) setSingerOff(false);
}

// ── Attaching the instrumental ──────────────────────────────────────────

function attachInstrumental() {
  var track = karaokeTrack();
  if (!track || !getVaultTrack(track.id)) return;
  var input = document.getElementById('karaoke-instrumental-file');
  input.value = '';
  input.onchange = function() {
    if (input.files && input.files[0]) uploadInstrumental(track.id, input.files[0]);
  };
  input.click();
}

async function uploadInstrumental(id, file) {
  var track = getVaultTrack(id);
  if (!track || _singer.uploading) return;
  _singer.uploading = true;
  renderSingerControls('Uploading the instrumental… 0%');
  try {
    var url = await uploadToCloudinary(file, function(pct) { renderSingerControls('Uploading the instrumental… ' + Math.round(pct) + '%'); });
    track.instrumentalURL = url;
    track.instrumentalName = file.name;
    persistTracks();
    showToast('Instrumental attached. Singer off now plays it.');
    // Already singing along with the voice turned down: switch to the clean one, same moment.
    if (_singer.off && _singer.trackId === id) {
      var audio = _singer.audio;
      loadSingerTrack(track, audio.currentTime || 0, !audio.paused);
    }
    checkInstrumentalLength(track, url);
  } catch (e) {
    showToast('Couldn’t upload the instrumental: ' + ((e && e.message) || 'try again.'));
  } finally {
    _singer.uploading = false;
    renderSingerControls();
  }
}

// Suno's stems run exactly as long as the song; anything else won't line up.
function checkInstrumentalLength(track, url) {
  var probe = new Audio();
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', function() {
    var songLength = Number(track.duration) || 0;
    if (songLength && Math.abs(probe.duration - songLength) > 2) {
      showToast('This instrumental is ' + fmtTime(Math.abs(probe.duration - songLength)) + (probe.duration > songLength ? ' longer' : ' shorter') + ' than the song, so the words may not line up.');
    }
    probe.removeAttribute('src');
  }, { once:true });
  probe.src = url;
}

function removeInstrumental() {
  var track = karaokeTrack();
  if (!track || !getVaultTrack(track.id) || !track.instrumentalURL) return;
  delete track.instrumentalURL;
  delete track.instrumentalName;
  persistTracks();
  if (_singer.off) {
    var audio = _singer.audio;
    loadSingerTrack(track, audio.currentTime || 0, !audio.paused);
  }
  renderSingerControls();
  showToast('Instrumental removed. Singer off turns the voice down instead.');
}

// The Singer pill by the background pill, and the line about it.
function renderSingerControls(progress) {
  var btn = document.getElementById('karaoke-singer-btn');
  var note = document.getElementById('karaoke-singer-note');
  if (!btn || !note) return;
  var track = karaokeTrack();
  btn.hidden = !track || !singerSupported();
  btn.setAttribute('aria-pressed', _singer.off ? 'true' : 'false');
  btn.classList.toggle('is-off', _singer.off);
  document.getElementById('karaoke-singer-label').textContent = _singer.off ? 'Singer off' : 'Singer on';
  btn.title = _singer.off ? 'Bring the singer back' : 'Take the singer out, to sing it yourself';
  var mine = !!(track && getVaultTrack(track.id));
  var html = '';
  if (progress) {
    html = esc(progress);
  } else if (_singer.off && _singer.mode === 'instrumental') {
    html = 'Singer off: the instrumental' + (track.instrumentalName ? ' (' + esc(track.instrumentalName) + ')' : '') + '.'
      + (mine ? ' <button type="button" class="karaoke-link" onclick="removeInstrumental()">Remove it</button>' : '');
  } else if (_singer.off) {
    html = 'Singer turned down in the browser; a little of the voice stays.'
      + (mine ? ' For a clean one, get the instrumental from Suno (⋯ → Get Stems) and <button type="button" class="karaoke-link" onclick="attachInstrumental()">attach it</button>.' : '');
  } else if (mine && track && track.instrumentalURL) {
    html = 'Instrumental attached for Singer off.';
  }
  note.innerHTML = html;
  note.hidden = !html;
}
