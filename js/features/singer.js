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
// and kick. The middle (L + R) is turned well down except the bass, and the
// sides (L - R) -- guitars, keys, reverb panned wide -- stay, a little
// louder to make up for it. The middle is kept at 30% rather than taken
// out: Suno puts instruments there too, and taking it all out left the
// music hollow. So the voice is quieter, not gone; stems do it properly.
function buildVocalReducer(ctx, input, output) {
  var splitter = ctx.createChannelSplitter(2);
  var merger = ctx.createChannelMerger(2);
  var gain = function(v) { var g = ctx.createGain(); g.gain.value = v; return g; };
  var lMid = gain(.5), rMid = gain(.5), lSide = gain(.5), rSide = gain(-.5);
  var mid = gain(1), midKeep = gain(.3), bassRest = gain(.7), side = gain(1.4), invert = gain(-1);
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
  // The bass gets the rest of the middle, so with the 30% it's whole again.
  mid.connect(bass);
  bass.connect(bassRest);
  bassRest.connect(merger, 0, 0);
  bassRest.connect(merger, 0, 1);
  mid.connect(midKeep);
  midKeep.connect(merger, 0, 0);
  midKeep.connect(merger, 0, 1);
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
    if (input.files && input.files.length) handleInstrumentalFiles(track.id, input.files);
  };
  input.click();
}

async function uploadInstrumental(id, file, label) {
  var track = getVaultTrack(id);
  if (!track || _singer.uploading) return;
  _singer.uploading = true;
  renderSingerControls('Uploading the instrumental… 0%');
  try {
    var url = await uploadToCloudinary(file, function(pct) { renderSingerControls('Uploading the instrumental… ' + Math.round(pct) + '%'); });
    track.instrumentalURL = url;
    track.instrumentalName = label || file.name;
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
    html = 'Singer turned down in the browser, not gone.'
      + (mine ? ' For a clean one, download the stems from Suno (⋯ → Get Stems) and <button type="button" class="karaoke-link" onclick="attachInstrumental()">attach the zip</button>.' : '');
  } else if (mine && track && track.instrumentalURL) {
    html = 'Instrumental attached for Singer off.';
  }
  note.innerHTML = html;
  note.hidden = !html;
}

// ── A karaoke track from Suno's stems ────────────────────────────────────
// "attach it" takes one instrumental, or Suno's stems zip (or several
// parts): the parts are listed with every voice unticked, and the ticked
// ones are decoded, added together, made into an MP3 (lamejs, loaded on
// demand from cdnjs with its integrity hash) and attached like any
// instrumental. Done in the browser, a part at a time, so only the mix and
// one part are in memory at once.

var LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
var LAME_SRI = 'sha512-xT0S/xXvkrfkRXGBPlzZPCAncnMK5c1N7slRkToUbv8Z901aUEuKO84tLy8dWU+3ew4InFEN7TebPaVMy2npZw==';
var _lamePromise = null;
var _stems = null;   // { trackId, parts: [{ name, label, voice, keep, read }], busy, note }

function loadLame() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (!_lamePromise) {
    _lamePromise = new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.src = LAME_URL;
      script.integrity = LAME_SRI;
      script.crossOrigin = 'anonymous';
      script.onload = function() {
        if (window.lamejs && window.lamejs.Mp3Encoder) resolve(window.lamejs);
        else reject(new Error('The MP3 encoder didn’t start.'));
      };
      script.onerror = function() {
        _lamePromise = null;
        reject(new Error('Couldn’t load the MP3 encoder. Check the connection and try again.'));
      };
      document.head.appendChild(script);
    });
  }
  return _lamePromise;
}

function isZipFile(file) {
  return /\.zip$/i.test(file.name) || /zip/.test(file.type || '');
}

// What was picked: one plain audio file is the instrumental itself;
// anything else is parts to choose from.
async function handleInstrumentalFiles(trackId, files) {
  var list = Array.prototype.slice.call(files || []);
  if (list.length === 1 && !isZipFile(list[0])) { uploadInstrumental(trackId, list[0]); return; }
  var parts = [];
  try {
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (isZipFile(file)) {
        (await readZipEntries(file)).filter(function(entry) { return isAudioFileName(entry.name); }).forEach(function(entry) {
          parts.push({ name:entry.name, read:entry.read });
        });
      } else if (isAudioFileName(file.name) || /^audio\//.test(file.type)) {
        parts.push({ name:file.name, read:(function(f) { return function() { return Promise.resolve(f); }; })(file) });
      }
    }
  } catch (e) {
    showToast((e && e.message) || 'Couldn’t open that file.');
    return;
  }
  if (!parts.length) { showToast('No audio files in there.'); return; }
  if (parts.length === 1) {
    var only = await parts[0].read();
    uploadInstrumental(trackId, new File([only], parts[0].name, { type:'audio/mpeg' }));
    return;
  }
  parts.sort(function(a, b) { return a.name.localeCompare(b.name, undefined, { numeric:true }); });
  var keep = defaultStemPick(parts.map(function(part) { return part.name; }));
  _stems = {
    trackId:trackId,
    parts:parts.map(function(part, i) { var kind = classifyStem(part.name); return { name:part.name, label:kind.label, voice:kind.voice, keep:keep[i], read:part.read }; }),
    busy:false,
    note:''
  };
  openModal('modal-stems');
  renderStems();
}

function toggleStem(index, keep) {
  if (!_stems || _stems.busy || !_stems.parts[index]) return;
  _stems.parts[index].keep = !!keep;
  renderStems();
}

function renderStems() {
  if (!_stems) return;
  var track = getVaultTrack(_stems.trackId);
  document.getElementById('stems-sub').textContent = track ? track.title || 'Untitled' : '';
  var kept = _stems.parts.filter(function(part) { return part.keep; }).length;
  document.getElementById('stems-list').innerHTML = _stems.parts.map(function(part, i) {
    return '<label class="stem-row' + (part.keep ? ' is-kept' : '') + '">'
      + '<input type="checkbox"' + (part.keep ? ' checked' : '') + (_stems.busy ? ' disabled' : '') + ' onchange="toggleStem(' + i + ', this.checked)">'
      + '<span class="stem-name">' + esc(part.label) + '</span>'
      + (part.voice ? '<span class="stem-voice">' + (part.voice === 'lead' ? 'Lead voice' : 'Backing voice') + '</span>' : '')
      + '</label>';
  }).join('');
  document.getElementById('stems-note').textContent = _stems.note
    || 'The ticked parts are mixed into the karaoke track. Voices start unticked; tick Backing Vocals to keep the harmonies.';
  document.getElementById('stems-actions').innerHTML =
    '<button class="sec-action" onclick="closeModal(\'modal-stems\')"' + (_stems.busy ? ' disabled' : '') + '>Cancel</button>'
    + '<button class="sec-action primary" onclick="makeKaraokeTrack()"' + (_stems.busy || !kept ? ' disabled' : '') + '>'
    + (_stems.busy ? 'Working…' : 'Make it') + '</button>';
}

function stemsProgress(text) {
  if (!_stems) return;
  _stems.note = text;
  var note = document.getElementById('stems-note');
  if (note) note.textContent = text;
}

function decodeAudioBlob(ctx, blob) {
  return blob.arrayBuffer().then(function(data) {
    return new Promise(function(resolve, reject) {
      var pending = ctx.decodeAudioData(data, resolve, reject);
      if (pending && pending.then) pending.then(resolve, reject);
    });
  });
}

async function makeKaraokeTrack() {
  if (!_stems || _stems.busy) return;
  var job = _stems;
  var kept = job.parts.filter(function(part) { return part.keep; });
  if (!kept.length) return;
  job.busy = true;
  renderStems();
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!_audioContext) _audioContext = new Ctx();
    var ctx = _audioContext;
    var left = null, right = null, length = 0, rate = ctx.sampleRate;
    for (var i = 0; i < kept.length; i++) {
      stemsProgress('Reading the parts… ' + (i + 1) + ' of ' + kept.length + ' (' + kept[i].label + ')');
      var buffer = await decodeAudioBlob(ctx, await kept[i].read());
      if (buffer.length > length) {
        var grownL = new Float32Array(buffer.length);
        var grownR = new Float32Array(buffer.length);
        if (left) { grownL.set(left); grownR.set(right); }
        left = grownL; right = grownR; length = buffer.length;
      }
      var a = buffer.getChannelData(0);
      var b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
      for (var s = 0; s < buffer.length; s++) { left[s] += a[s]; right[s] += b[s]; }
    }
    // Parts added together can run past full scale; bring the peak just under it.
    var peak = 0;
    for (s = 0; s < length; s++) peak = Math.max(peak, Math.abs(left[s]), Math.abs(right[s]));
    var scale = peak > .98 ? .98 / peak : 1;
    stemsProgress('Making the MP3… 0%');
    var lame = await loadLame();
    var encoder = new lame.Mp3Encoder(2, rate, 192);
    var chunks = [];
    var block = 1152 * 40;
    var l16 = new Int16Array(block), r16 = new Int16Array(block);
    for (var at = 0; at < length; at += block) {
      var n = Math.min(block, length - at);
      for (s = 0; s < n; s++) {
        l16[s] = Math.max(-32768, Math.min(32767, Math.round(left[at + s] * scale * 32767)));
        r16[s] = Math.max(-32768, Math.min(32767, Math.round(right[at + s] * scale * 32767)));
      }
      var out = encoder.encodeBuffer(n === block ? l16 : l16.subarray(0, n), n === block ? r16 : r16.subarray(0, n));
      if (out.length) chunks.push(new Uint8Array(out));
      stemsProgress('Making the MP3… ' + Math.round(Math.min(1, (at + n) / length) * 100) + '%');
      await new Promise(function(resolve) { setTimeout(resolve, 0); });
    }
    var tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    var track = getVaultTrack(job.trackId);
    var base = (track && track.title || 'Song').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Song';
    var file = new File(chunks, base + ' (karaoke).mp3', { type:'audio/mpeg' });
    job.busy = false;
    _stems = null;
    closeModal('modal-stems');
    uploadInstrumental(job.trackId, file, 'Made from ' + kept.length + ' stems (' + kept.map(function(part) { return part.label; }).join(', ') + ')');
  } catch (e) {
    console.warn('Karaoke track failed:', e);
    job.busy = false;
    stemsProgress('Couldn’t make it: ' + ((e && e.message) || 'try again.'));
    renderStems();
  }
}
