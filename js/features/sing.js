// Sing it and keep it: karaoke records your voice over the song with the
// singer off, then mixes the two into a take kept on the song (track.takes,
// js/data/takes.js).
//
// Recording: the Record button (#karaoke-record) turns the singer off if it
// isn't, asks for the microphone with the voice processing off (echo
// cancelling, noise suppression and level control would all bend a sung
// note), counts in 3-2-1 and plays the singer's element from where it was.
// The mic is captured in that element's AudioContext by a small
// AudioWorklet (made from a Blob, so there is no extra file to load; a
// ScriptProcessor where there is no AudioWorklet). The element's position
// when it starts playing is the take's start; the voice arrives later by the
// output and mic delays the browser reports, and is moved that much earlier.
// Tap Stop, Space, or reach the end of the song to stop.
//
// Review (#modal-take): the take plays as the music under the voice, live, so
// the voice level and the timing nudge (for whatever delay the browser
// didn't report, Bluetooth headphones especially) are heard as they change.
// Save mixes it (mixTake), makes an MP3 (encodeMp3, js/features/singer.js),
// uploads it and adds it to the song. Closing the review keeps the take
// until the next recording; "Review it" in karaoke reopens it.
//
// Your takes (#modal-takes): play, download, delete. Deleting takes it off
// the song; the file stays on Cloudinary, like a deleted song's audio.

var SING_COUNT_IN = 3;
var _sing = {
  phase:'',          // '' | starting | counting | recording | stopping | review | saving
  trackId:'', stream:null, source:null, recorder:null, chunks:[],
  rate:0, startAt:0, lag:0, mode:'', count:0, startedAt:0, shownSecond:-1,
  voice:null, voiceBuffer:null, music:null, musicNote:'', saveNote:'',
  nudge:0, gain:1, preview:null, previewAt:0, previewCtx:null, previewFrame:0,
  player:null, playingTakeId:''
};
var _singWorkletCtx = null;

// The worklet: collects the mic (its channels averaged) once told to start,
// and posts it in blocks of about 4096 frames.
var SING_WORKLET = [
  'class SvTakeRecorder extends AudioWorkletProcessor {',
  '  constructor() {',
  '    super();',
  '    this.on = false; this.parts = []; this.count = 0;',
  '    this.port.onmessage = (event) => {',
  '      if (event.data === "start") this.on = true;',
  '      if (event.data === "stop") { this.flush(); this.on = false; this.port.postMessage("stopped"); }',
  '    };',
  '  }',
  '  flush() {',
  '    if (!this.count) return;',
  '    const out = new Float32Array(this.count);',
  '    let at = 0;',
  '    for (const part of this.parts) { out.set(part, at); at += part.length; }',
  '    this.parts = []; this.count = 0;',
  '    this.port.postMessage(out, [out.buffer]);',
  '  }',
  '  process(inputs) {',
  '    const input = inputs[0];',
  '    if (this.on && input && input.length) {',
  '      const frame = new Float32Array(input[0].length);',
  '      for (const channel of input) for (let i = 0; i < frame.length; i++) frame[i] += channel[i] / input.length;',
  '      this.parts.push(frame); this.count += frame.length;',
  '      if (this.count >= 4096) this.flush();',
  '    }',
  '    return true;',
  '  }',
  '}',
  'registerProcessor("sv-take-recorder", SvTakeRecorder);'
].join('\n');

function singSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && singerSupported();
}

// Only your own songs: a take is kept on the song in your vault.
function singCanRecord(track) {
  return !!(track && getVaultTrack(track.id) && singSupported());
}

function singRecording() {
  return _sing.phase === 'starting' || _sing.phase === 'counting' || _sing.phase === 'recording';
}

function singWait(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// The singer's element, loaded far enough to play from where it is.
function singAudioReady(audio) {
  if (audio.readyState >= 2) return Promise.resolve();
  return new Promise(function(resolve) {
    var done = function() { audio.removeEventListener('canplay', done); resolve(); };
    audio.addEventListener('canplay', done);
    setTimeout(done, 8000);
  });
}

async function makeSingRecorder(ctx) {
  var sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  if (ctx.audioWorklet && window.AudioWorkletNode) {
    if (_singWorkletCtx !== ctx) {
      var url = URL.createObjectURL(new Blob([SING_WORKLET], { type:'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      _singWorkletCtx = ctx;
    }
    var node = new AudioWorkletNode(ctx, 'sv-take-recorder', { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1] });
    var stopped = null;
    node.port.onmessage = function(event) {
      if (event.data === 'stopped') { if (stopped) stopped(); }
      else if (event.data instanceof Float32Array) _sing.chunks.push(event.data);
    };
    node.connect(sink);
    return {
      input:node,
      start:function() { node.port.postMessage('start'); },
      stop:function() {
        return new Promise(function(resolve) { stopped = resolve; node.port.postMessage('stop'); setTimeout(resolve, 600); });
      },
      disconnect:function() { try { node.disconnect(); sink.disconnect(); } catch (e) {} }
    };
  }
  var proc = ctx.createScriptProcessor(4096, 1, 1);
  var on = false;
  proc.onaudioprocess = function(event) { if (on) _sing.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
  proc.connect(sink);
  return {
    input:proc,
    start:function() { on = true; },
    stop:function() { on = false; return Promise.resolve(); },
    disconnect:function() { try { proc.disconnect(); sink.disconnect(); } catch (e) {} }
  };
}

function releaseSingInput() {
  if (_sing.recorder) _sing.recorder.disconnect();
  if (_sing.source) { try { _sing.source.disconnect(); } catch (e) {} }
  if (_sing.stream) _sing.stream.getTracks().forEach(function(track) { track.stop(); });
  _sing.recorder = null;
  _sing.source = null;
  _sing.stream = null;
}

function toggleSingRecording() {
  if (singRecording()) stopSingRecording();
  else startSingRecording();
}

async function startSingRecording() {
  var track = karaokeTrack();
  if (!singCanRecord(track) || singRecording() || _sing.phase === 'stopping' || _sing.phase === 'saving') return;
  // A new recording replaces a take that was never saved.
  if (_sing.phase === 'review') discardSingTake();
  _sing.phase = 'starting';
  renderSingControls();
  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } });
  } catch (e) {
    _sing.phase = '';
    renderSingControls();
    showToast(e && e.name === 'NotAllowedError'
      ? 'Recording needs the microphone. Allow it for SonicVault in the browser’s site settings.'
      : 'Couldn’t start the microphone.');
    return;
  }
  // Closed, or stopped, while the browser asked.
  if (_sing.phase !== 'starting' || !_karaoke) {
    stream.getTracks().forEach(function(t) { t.stop(); });
    if (_sing.phase === 'starting') _sing.phase = '';
    renderSingControls();
    return;
  }
  _sing.stream = stream;
  if (!_singer.off) setSingerOff(true);
  var audio = _singer.audio;
  if (!_singer.off || !audio || !_singer.ctx) {
    releaseSingInput();
    _sing.phase = '';
    renderSingControls();
    return;
  }
  audio.pause();
  var ctx = _singer.ctx;
  try {
    try { await ctx.resume(); } catch (e) {}
    await singAudioReady(audio);
    _sing.chunks = [];
    _sing.recorder = await makeSingRecorder(ctx);
    _sing.source = ctx.createMediaStreamSource(stream);
    _sing.source.connect(_sing.recorder.input);
  } catch (e) {
    console.warn('Recording failed to start:', e);
    releaseSingInput();
    _sing.phase = '';
    renderSingControls();
    showToast('Couldn’t start recording in this browser.');
    return;
  }
  _sing.trackId = track.id;
  _sing.rate = ctx.sampleRate;
  _sing.mode = _singer.mode;
  _sing.phase = 'counting';
  for (var n = SING_COUNT_IN; n > 0; n--) {
    _sing.count = n;
    renderSingControls();
    await singWait(1000);
    if (_sing.phase !== 'counting') return;
  }
  _sing.count = 0;
  await audio.play().catch(function() {});
  if (_sing.phase !== 'counting') return;
  if (audio.paused) {
    releaseSingInput();
    _sing.phase = '';
    renderSingControls();
    showToast('The song wouldn’t play, so nothing was recorded.');
    return;
  }
  var micTrack = stream.getAudioTracks()[0];
  var settings = micTrack && micTrack.getSettings ? micTrack.getSettings() : {};
  _sing.startAt = audio.currentTime || 0;
  _sing.lag = (Number(ctx.outputLatency) || Number(ctx.baseLatency) || 0) + (Number(settings.latency) || 0);
  _sing.recorder.start();
  _sing.phase = 'recording';
  _sing.startedAt = performance.now();
  _sing.shownSecond = -1;
  renderSingControls();
}

// Stop, however it stops: the button, Space, the song ending, karaoke closing,
// the singer coming back or the song changing. The music stops at once, so
// nothing plays on while the take is put together.
async function stopSingRecording() {
  if (_sing.phase === 'starting' || _sing.phase === 'counting') {
    releaseSingInput();
    _sing.phase = '';
    _sing.count = 0;
    renderSingControls();
    return;
  }
  if (_sing.phase !== 'recording') return;
  _sing.phase = 'stopping';
  if (_singer.audio && !_singer.audio.paused) _singer.audio.pause();
  renderSingControls();
  try { await _sing.recorder.stop(); } catch (e) {}
  releaseSingInput();
  var total = _sing.chunks.reduce(function(n, part) { return n + part.length; }, 0);
  var voice = new Float32Array(total);
  var at = 0;
  _sing.chunks.forEach(function(part) { voice.set(part, at); at += part.length; });
  _sing.chunks = [];
  if (total < _sing.rate) {
    _sing.phase = '';
    renderSingControls();
    showToast('That was too short to keep. Record for at least a second.');
    return;
  }
  _sing.voice = voice;
  _sing.voiceBuffer = null;
  _sing.music = null;
  _sing.nudge = 0;
  _sing.gain = 1;
  _sing.previewAt = 0;
  _sing.saveNote = '';
  _sing.phase = 'review';
  renderSingControls();
  openTakeReview();
  loadTakeMusic(voice);
}

// The music under the take: the same file karaoke played, cut to the take,
// through the browser's voice reducer if that is what was playing.
async function loadTakeMusic(voice) {
  var track = getVaultTrack(_sing.trackId);
  if (!track) return;
  var url = _sing.mode === 'instrumental' ? track.instrumentalURL : (track.audioURL || track.audioData);
  _sing.musicNote = 'Getting the music ready…';
  renderTakeReview();
  try {
    var data = await (await fetch(url)).arrayBuffer();
    var rate = _sing.rate;
    var decoded = await new Promise(function(resolve, reject) {
      var pending = new OfflineAudioContext(2, 1, rate).decodeAudioData(data, resolve, reject);
      if (pending && pending.then) pending.then(resolve, reject);
    });
    var octx = new OfflineAudioContext(2, voice.length, rate);
    var source = octx.createBufferSource();
    source.buffer = decoded;
    if (_sing.mode === 'reduced') buildVocalReducer(octx, source, octx.destination);
    else source.connect(octx.destination);
    source.start(0, Math.min(_sing.startAt, Math.max(0, decoded.duration - .01)));
    var music = await octx.startRendering();
    if (_sing.voice !== voice) return;
    _sing.music = music;
    _sing.musicNote = '';
  } catch (e) {
    console.warn('Take music failed:', e);
    if (_sing.voice !== voice) return;
    _sing.musicNote = 'Couldn’t get the music for the take. Check the connection, then try Review it again.';
  }
  renderTakeReview();
}

function discardSingTake() {
  stopSingTakePreview(false);
  _sing.voice = null;
  _sing.voiceBuffer = null;
  _sing.music = null;
  _sing.musicNote = '';
  _sing.saveNote = '';
  if (_sing.phase === 'review') _sing.phase = '';
}

// ── Review ───────────────────────────────────────────────────────────────

function openTakeReview() {
  if (!_sing.voice) return;
  if (!_sing.music && !_sing.musicNote) loadTakeMusic(_sing.voice);
  else if (/Couldn/.test(_sing.musicNote)) loadTakeMusic(_sing.voice);
  openModal('modal-take');
  document.getElementById('take-gain').value = Math.round(_sing.gain * 100);
  document.getElementById('take-nudge').value = _sing.nudge;
  renderTakeReview();
}

function takeDuration() {
  return _sing.voice && _sing.rate ? _sing.voice.length / _sing.rate : 0;
}

function renderTakeReview() {
  var track = getVaultTrack(_sing.trackId);
  if (!document.getElementById('modal-take')) return;
  document.getElementById('take-sub').textContent = (track ? track.title || 'Untitled' : '')
    + (_sing.voice ? ' · ' + takeSummary({ start:_sing.startAt, duration:takeDuration() }) : '');
  var ready = !!_sing.music && _sing.phase === 'review';
  var play = document.getElementById('take-play');
  setPlayButton(play, !!_sing.preview);
  play.disabled = !ready;
  play.setAttribute('aria-label', _sing.preview ? 'Pause your take' : 'Play your take');
  document.getElementById('take-gain').disabled = _sing.phase !== 'review';
  document.getElementById('take-nudge').disabled = _sing.phase !== 'review';
  document.getElementById('take-gain-label').textContent = Math.round(_sing.gain * 100) + '%';
  document.getElementById('take-nudge-label').textContent = _sing.nudge === 0 ? 'as recorded'
    : Math.abs(_sing.nudge) + ' ms ' + (_sing.nudge > 0 ? 'later' : 'earlier');
  renderTakeTime();
  document.getElementById('take-note').textContent = _sing.saveNote || _sing.musicNote
    || 'Headphones on? Then the take is just you and the music. If your voice sounds early or late, move Timing.';
  var busy = _sing.phase === 'saving';
  document.getElementById('take-actions').innerHTML =
    '<button class="sec-action" onclick="retakeSing()"' + (busy ? ' disabled' : '') + '>Retake</button>'
    + '<button class="sec-action primary" onclick="saveSingTake()"' + (ready ? '' : ' disabled') + '>' + (busy ? 'Saving…' : 'Save take') + '</button>';
}

function renderTakeTime() {
  var at = takePreviewPosition();
  var duration = takeDuration();
  document.getElementById('take-fill').style.width = duration ? Math.min(100, at / duration * 100).toFixed(2) + '%' : '0%';
  document.getElementById('take-time').textContent = fmtTime(at) + ' / ' + fmtTime(duration);
}

function takePreviewPosition() {
  var p = _sing.preview;
  if (!p) return _sing.previewAt || 0;
  return Math.min(takeDuration(), p.at + Math.max(0, p.ctx.currentTime - p.t0));
}

function toggleSingTakePreview() {
  if (_sing.preview) { stopSingTakePreview(true); renderTakeReview(); return; }
  if (!_sing.music || _sing.phase !== 'review') return;
  playSingTakePreview(_sing.previewAt >= takeDuration() - .05 ? 0 : _sing.previewAt);
}

function playSingTakePreview(at) {
  stopSingTakePreview(false);
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!_sing.previewCtx) _sing.previewCtx = new Ctx();
  var ctx = _sing.previewCtx;
  try { ctx.resume(); } catch (e) {}
  // Nothing else plays over the take.
  if (_singer.audio && !_singer.audio.paused) _singer.audio.pause();
  if (!_singer.off && _isPlaying) togglePlayback();
  stopTakePlayer();
  if (!_sing.voiceBuffer) {
    _sing.voiceBuffer = ctx.createBuffer(1, _sing.voice.length, _sing.rate);
    _sing.voiceBuffer.getChannelData(0).set(_sing.voice);
  }
  var music = ctx.createBufferSource();
  music.buffer = _sing.music;
  music.connect(ctx.destination);
  var voice = ctx.createBufferSource();
  voice.buffer = _sing.voiceBuffer;
  var gain = ctx.createGain();
  gain.gain.value = _sing.gain;
  voice.connect(gain);
  gain.connect(ctx.destination);
  var t0 = ctx.currentTime + .05;
  var voiceStart = takeVoiceStart(_sing.lag, _sing.nudge);
  music.start(t0, at);
  if (at >= voiceStart) voice.start(t0, at - voiceStart);
  else voice.start(t0 + (voiceStart - at), 0);
  music.onended = function() {
    if (!_sing.preview || _sing.preview.music !== music) return;
    _sing.preview = null;
    _sing.previewAt = 0;
    renderTakeReview();
  };
  _sing.preview = { ctx:ctx, music:music, voice:voice, gain:gain, t0:t0, at:at };
  renderTakeReview();
  var tick = function() {
    if (!_sing.preview || _sing.preview.music !== music) return;
    renderTakeTime();
    _sing.previewFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopSingTakePreview(keepPlace) {
  var p = _sing.preview;
  if (!p) return;
  _sing.previewAt = keepPlace ? takePreviewPosition() : 0;
  _sing.preview = null;
  cancelAnimationFrame(_sing.previewFrame);
  p.music.onended = null;
  try { p.music.stop(); } catch (e) {}
  try { p.voice.stop(); } catch (e) {}
}

function seekSingTakePreview(event) {
  var rect = event.currentTarget.getBoundingClientRect();
  var duration = takeDuration();
  if (!duration || !rect.width || !_sing.music) return;
  var at = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
  if (_sing.preview) playSingTakePreview(at);
  else { _sing.previewAt = at; renderTakeTime(); }
}

function setTakeGain(value) {
  _sing.gain = Math.max(0, Math.min(2, Number(value) / 100));
  if (_sing.preview) _sing.preview.gain.gain.value = _sing.gain;
  renderTakeReview();
}

// Timing moves the voice against the music; heard straight away.
function setTakeNudge(value) {
  _sing.nudge = Math.max(-300, Math.min(300, Math.round(Number(value) || 0)));
  if (_sing.preview) playSingTakePreview(takePreviewPosition());
  else renderTakeReview();
}

// Again, from the same place.
function retakeSing() {
  if (_sing.phase === 'saving') return;
  var at = _sing.startAt;
  discardSingTake();
  closeModal('modal-take');
  if (_singer.off && _singer.audio) {
    try { _singer.audio.currentTime = at; } catch (e) {}
  }
  startSingRecording();
}

async function saveSingTake() {
  if (_sing.phase !== 'review' || !_sing.music) return;
  var track = getVaultTrack(_sing.trackId);
  if (!track) return;
  stopSingTakePreview(true);
  _sing.phase = 'saving';
  _sing.saveNote = 'Mixing your voice in…';
  renderTakeReview();
  try {
    var music = _sing.music;
    var right = music.numberOfChannels > 1 ? music.getChannelData(1) : music.getChannelData(0);
    var mix = mixTake(music.getChannelData(0), right, _sing.voice, _sing.rate, takeVoiceStart(_sing.lag, _sing.nudge), _sing.gain);
    var chunks = await encodeMp3(mix.left, mix.right, _sing.rate, function(pct) {
      _sing.saveNote = 'Making the MP3… ' + pct + '%';
      document.getElementById('take-note').textContent = _sing.saveNote;
    });
    var created = new Date().toISOString();
    var file = new File(chunks, takeFileName(track.title, created), { type:'audio/mpeg' });
    var url = await uploadToCloudinary(file, function(pct) {
      _sing.saveNote = 'Uploading… ' + Math.round(pct) + '%';
      document.getElementById('take-note').textContent = _sing.saveNote;
    });
    track.takes = addTake(track.takes, {
      id:'take-' + Date.now(),
      url:url,
      start:Math.round(_sing.startAt * 100) / 100,
      duration:Math.round(takeDuration() * 100) / 100,
      created:created
    });
    persistTracks();
    _sing.phase = 'review';
    discardSingTake();
    closeModal('modal-take');
    renderSingControls();
    showToast('Take saved. It’s under Your takes in karaoke.');
  } catch (e) {
    console.warn('Saving the take failed:', e);
    _sing.phase = 'review';
    _sing.saveNote = 'Couldn’t save it: ' + ((e && e.message) || 'try again.');
    renderTakeReview();
  }
}

// Called by closeModal however the review closes: the take waits.
function onTakeReviewClosed() {
  stopSingTakePreview(true);
  renderSingControls();
}

// ── Your takes ───────────────────────────────────────────────────────────

function openTakesList() {
  var track = karaokeTrack();
  if (!track) return;
  openModal('modal-takes');
  renderTakesList();
}

function renderTakesList() {
  var track = karaokeTrack();
  var takes = track && Array.isArray(track.takes) ? track.takes : [];
  document.getElementById('takes-sub').textContent = track ? track.title || 'Untitled' : '';
  document.getElementById('takes-list').innerHTML = takes.length ? takes.map(function(take) {
    var playing = _sing.playingTakeId === take.id;
    var when = '';
    try { when = new Date(take.created).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' }); } catch (e) {}
    return '<div class="take-row">'
      + '<button type="button" class="take-row-play" aria-label="' + (playing ? 'Pause' : 'Play') + ' the take from ' + esc(when) + '" onclick="playTake(\'' + esc(take.id) + '\')">' + icon(playing ? 'pause' : 'play') + '</button>'
      + '<div class="take-row-text"><div class="take-row-when">' + esc(when || 'Take') + '</div><div class="take-row-sub">' + esc(takeSummary(take)) + '</div></div>'
      + '<a class="take-row-link" href="' + esc(takeDownloadURL(take.url)) + '" download>' + icon('download') + '<span>Download</span></a>'
      + '<button type="button" class="take-row-link take-row-delete" onclick="deleteTake(\'' + esc(take.id) + '\', this)">Delete</button>'
      + '</div>';
  }).join('') : '<p class="stems-note">No takes yet. Tap the record button in karaoke to sing one.</p>';
}

function takePlayer() {
  if (_sing.player) return _sing.player;
  var audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('ended', function() { _sing.playingTakeId = ''; renderTakesList(); });
  _sing.player = audio;
  return audio;
}

function playTake(id) {
  var track = karaokeTrack();
  var take = track && (track.takes || []).filter(function(item) { return item.id === id; })[0];
  if (!take) return;
  var audio = takePlayer();
  if (_sing.playingTakeId === id) {
    stopTakePlayer();
    renderTakesList();
    return;
  }
  stopSingTakePreview(true);
  if (_singer.off && _singer.audio && !_singer.audio.paused) _singer.audio.pause();
  if (!_singer.off && _isPlaying) togglePlayback();
  audio.src = take.url;
  audio.play().catch(function() { showToast('Couldn’t play the take.'); });
  _sing.playingTakeId = id;
  renderTakesList();
}

function stopTakePlayer() {
  if (_sing.player) _sing.player.pause();
  _sing.playingTakeId = '';
}

// Two taps: Delete, then Delete? within three seconds.
function deleteTake(id, btn) {
  var track = karaokeTrack();
  if (!track || !getVaultTrack(track.id)) return;
  if (!btn.dataset.sure) {
    btn.dataset.sure = '1';
    btn.textContent = 'Delete?';
    setTimeout(function() { if (btn.isConnected) { delete btn.dataset.sure; btn.textContent = 'Delete'; } }, 3000);
    return;
  }
  if (_sing.playingTakeId === id) stopTakePlayer();
  track.takes = removeTake(track.takes, id);
  persistTracks();
  renderTakesList();
  renderSingControls();
  showToast('Take deleted.');
}

function onTakesListClosed() {
  stopTakePlayer();
}

// ── In karaoke ───────────────────────────────────────────────────────────

// Called by closeModal for karaoke, before the singer comes back.
function onSingKaraokeClosed() {
  if (singRecording()) stopSingRecording();
}

// The record button and the line about takes.
function renderSingControls() {
  var btn = document.getElementById('karaoke-record');
  var note = document.getElementById('karaoke-sing-note');
  var count = document.getElementById('karaoke-countdown');
  if (!btn || !note) return;
  var track = karaokeTrack();
  var can = singCanRecord(track);
  var live = singRecording() || _sing.phase === 'stopping';
  btn.hidden = !can && !live;
  btn.classList.toggle('is-recording', _sing.phase === 'recording' || _sing.phase === 'counting');
  btn.innerHTML = icon(live ? 'stop' : 'record');
  btn.setAttribute('aria-label', live ? 'Stop recording' : 'Record yourself singing');
  btn.title = live ? 'Stop recording' : 'Record yourself singing (headphones on)';
  btn.disabled = _sing.phase === 'stopping' || _sing.phase === 'saving';
  count.hidden = _sing.phase !== 'counting' || !_sing.count;
  count.textContent = _sing.count || '';
  var html = '';
  var takes = track && Array.isArray(track.takes) ? track.takes.length : 0;
  if (_sing.phase === 'starting') html = 'Starting the microphone…';
  else if (_sing.phase === 'counting') html = 'Get ready…';
  else if (_sing.phase === 'recording') html = '<span class="sing-dot" aria-hidden="true"></span>Recording ' + fmtTime((performance.now() - _sing.startedAt) / 1000) + ' · tap stop when you’re done';
  else if (_sing.phase === 'stopping') html = 'Putting your take together…';
  else if ((_sing.phase === 'review' || _sing.phase === 'saving') && _sing.trackId === (track && track.id)) {
    html = 'You have a take you haven’t saved. <button type="button" class="karaoke-link" onclick="openTakeReview()">Review it</button>';
  } else if (can && takes) {
    html = '<button type="button" class="karaoke-link" onclick="openTakesList()">Your takes (' + takes + ')</button>';
  } else if (can) {
    html = 'Tap the red button to sing it yourself. Put headphones on, so the mic hears only you.';
  }
  note.innerHTML = html;
  note.hidden = !html;
}

// Each karaoke frame: the recording clock, once a second.
function singFrame() {
  if (_sing.phase !== 'recording') return;
  var second = Math.floor((performance.now() - _sing.startedAt) / 1000);
  if (second === _sing.shownSecond) return;
  _sing.shownSecond = second;
  renderSingControls();
}
