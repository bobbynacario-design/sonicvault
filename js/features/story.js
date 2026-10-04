// Story clips: a song as a 15- or 30-second vertical video to post as a
// story -- the cover, the lines as they are sung, the sound moving under
// them, and the SonicVault mark. Drawn on a canvas and recorded with
// MediaRecorder while the song plays silently into it, so a 15-second clip
// takes 15 seconds to make. Which part of the song, text wrapping and the
// recording format are worked out in js/data/story.js.
//
// Every finished clip is also kept on this device -- the last STORY_KEEP of
// them, in Cache Storage (STORY_CLIP_CACHE, which sw.js leaves alone) with
// a list in localStorage.sv_clips -- and listed in the dialog to open,
// share, save or delete. Nothing goes to the vault or the cloud.

var STORY_FONT_DISPLAY = 'Syne, sans-serif';
var STORY_FONT_SANS = '"Space Grotesk", "DM Sans", sans-serif';
var STORY_BARS = 28;
var STORY_COVER = 640;       // the cover's side on the 1080-wide frame
var STORY_COVER_TOP = 250;   // below the name and avatar a story app lays over the top
var STORY_TEXT_WIDTH = 920;

var _story = null;           // the open dialog: { trackId, length, start, best, phase, ... }
var _storyScene = null;      // pictures and pre-painted layers for the open song
var _storyBuffer = null;     // { id, buffer }: the open song, decoded once
var _storyRun = null;        // the recording in progress: { cancel }
var STORY_CLIP_CACHE = 'sv-clips-v1';
var _storyClips = null;      // [{ id, trackId, title, start, length, ext, type, size, at }], newest first
var _storyStills = {};       // clip id -> object URL of its still

function storyClipsSupported() {
  var Ctx = window.AudioContext || window.webkitAudioContext;
  var canvas = document.createElement('canvas');
  return !!(window.MediaRecorder && canvas.captureStream && Ctx && Ctx.prototype.createMediaStreamDestination
    && pickStoryFormat(function(type) { return MediaRecorder.isTypeSupported(type); }));
}

function storyTrack() {
  return _story ? getVaultTrack(_story.trackId) : null;
}

function storyDuration(track) {
  if (_storyBuffer && track && _storyBuffer.id === track.id) return _storyBuffer.buffer.duration;
  return Number(track && track.duration) || 0;
}

// Real timings only: words shown at the wrong moment are worse than none.
function storyTimes(track) {
  var sync = getLyricSync(track);
  if (!sync || sync.source === 'unmatched' || !sync.lines.some(Boolean)) return null;
  return resolveLyricTimes(sync.lines, storyDuration(track));
}

function openStoryClip(id) {
  var track = getVaultTrack(id);
  if (!track) { showToast('Only songs in your vault can be made into clips.'); return; }
  if (!track.audioURL && !track.audioData) { showToast('This song has no audio to make a clip from.'); return; }
  if (!storyClipsSupported()) { showToast('This browser can’t record video. Try Chrome or Safari.'); return; }
  resetStoryClip();
  _story = { trackId:id, length:STORY_LENGTHS[0], start:0, best:null, phase:'setup', timing:false, progress:0, url:'', file:null, error:'' };
  pickBestStoryStart();
  openModal('modal-story');
  renderStoryDialog();
  syncKeptStoryClips();
  prepareStoryScene(track).then(drawStoryPreview);
  timeStoryLyrics(track);
}

function storyClipCurrentTrack() {
  if (_currentTrack) openStoryClip(_currentTrack.id);
}

function closeStoryClip() {
  closeModal('modal-story');
}

// Called by closeModal however the dialog closes (button, Escape, backdrop).
function onStoryClipClosed() {
  resetStoryClip();
}

function resetStoryClip() {
  if (_storyRun) _storyRun.cancel();
  _storyRun = null;
  releaseStoryResult();
  var video = document.getElementById('story-video');
  if (video && video.getAttribute('src')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  _story = null;
  _storyScene = null;
  _storyBuffer = null;
}

// Lets go of the clip on show: its video, and its still when this dialog
// made it (a kept clip's still belongs to the list).
function releaseStoryResult() {
  if (!_story) return;
  if (_story.url) URL.revokeObjectURL(_story.url);
  if (_story.poster && _story.ownPoster) URL.revokeObjectURL(_story.poster);
  _story.url = '';
  _story.file = null;
  _story.poster = '';
  _story.ownPoster = false;
  _story.clipId = '';
  _story.viewing = null;
}

function pickBestStoryStart() {
  var track = storyTrack();
  if (!track) return;
  _story.best = pickStoryStart(parseLyricSheet(getTrackLyrics(track)), storyTimes(track), storyDuration(track), _story.length);
  _story.start = _story.best.start;
}

// Length and start can be changed before a clip is made, or after one failed.
function storyEditable() {
  return !!(_story && (_story.phase === 'setup' || _story.phase === 'error'));
}

function isBestStoryStart() {
  return !!(_story && _story.best && Math.abs(_story.start - _story.best.start) < .25);
}

// Lyrics with no timings yet are timed first (the same request playing the
// song makes), so the words land when they are sung.
async function timeStoryLyrics(track) {
  if (!hasLyrics(track) || getLyricSync(track) || !lyricSyncEndpoint() || _lyricSyncFailed[track.id]) return;
  if (!/^https:\/\/res\.cloudinary\.com\//.test(track.audioURL || '') || navigator.onLine === false) return;
  _story.timing = true;
  renderStoryDialog();
  if (!_lyricSyncJobs[track.id]) {
    await requestLyricSync(track);
  } else {
    for (var waited = 0; _lyricSyncJobs[track.id] && waited < LYRIC_SYNC_TIMEOUT_MS; waited += 500) {
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }
  }
  if (!_story || _story.trackId !== track.id) return;
  _story.timing = false;
  pickBestStoryStart();
  renderStoryDialog();
  await prepareStoryScene(track);
  drawStoryPreview();
}

// ── Painting ──────────────────────────────────────────────────────────

function storyCanvas(w, h) {
  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function loadStoryImage(src) {
  return new Promise(function(resolve) {
    if (!src) { resolve(null); return; }
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { resolve(null); };
    img.src = src;
  });
}

// The page's own fonts, so the clip matches the app. A font that doesn't
// load in time falls back to the system's.
function loadStoryFonts() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  var loads = Promise.all(['800 80px Syne', '700 60px "Space Grotesk"', '500 40px "Space Grotesk"'].map(function(font) {
    return document.fonts.load(font).catch(function() {});
  }));
  return Promise.race([loads, new Promise(function(resolve) { setTimeout(resolve, 2500); })]);
}

function storyRoundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function storyBloom(g, x, y, r, color, alpha) {
  var grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, hslWithAlpha(color, alpha));
  grad.addColorStop(1, hslWithAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

// The backdrop, painted once a song: the cover blown up and blurred (or the
// generated cover's colours), darkened so white words read on any art. The
// blur is the art shrunk to a few pixels and stretched back, because canvas
// filters are missing in Safari.
function paintStoryBackground(art, palette) {
  var W = STORY_WIDTH;
  var H = STORY_HEIGHT;
  var c = storyCanvas(W, H);
  var g = c.getContext('2d');
  g.fillStyle = palette.c;
  g.fillRect(0, 0, W, H);
  if (art) {
    var w = art.naturalWidth || art.width;
    var h = art.naturalHeight || art.height;
    var sw = Math.min(w, h * 9 / 16);
    var mid = storyCanvas(54, 96);
    mid.getContext('2d').drawImage(art, (w - sw) / 2, 0, sw, h, 0, 0, 54, 96);
    var small = storyCanvas(14, 24);
    small.getContext('2d').drawImage(mid, 0, 0, 14, 24);
    var up = storyCanvas(135, 240);
    var ug = up.getContext('2d');
    ug.imageSmoothingQuality = 'high';
    ug.drawImage(small, 0, 0, 135, 240);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(up, 0, 0, W, H);
  }
  storyBloom(g, W * .18, H * .2, W * .95, palette.a, art ? .28 : .6);
  storyBloom(g, W * .9, H * .72, W * 1.05, palette.b, art ? .22 : .5);
  var shade = g.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, 'rgba(5, 6, 12, .28)');
  shade.addColorStop(.45, 'rgba(5, 6, 12, .42)');
  shade.addColorStop(1, 'rgba(5, 6, 12, .86)');
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
  return c;
}

// The cover with its shadow, painted once and drawn every frame. Without
// real art, the generated cover's blooms and monogram.
function paintStoryCover(track, art, palette) {
  var pad = 90;
  var size = STORY_COVER;
  var c = storyCanvas(size + pad * 2, size + pad * 2);
  var g = c.getContext('2d');
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, .55)';
  g.shadowBlur = 80;
  g.shadowOffsetY = 34;
  storyRoundRect(g, pad, pad, size, size, 40);
  g.fillStyle = palette.c;
  g.fill();
  g.restore();
  g.save();
  storyRoundRect(g, pad, pad, size, size, 40);
  g.clip();
  if (art) {
    g.drawImage(art, pad, pad, size, size);
  } else {
    storyBloom(g, pad + size * .25, pad + size * .22, size * .95, palette.a, .9);
    storyBloom(g, pad + size * .88, pad + size * .82, size * .85, palette.b, .8);
    g.font = '800 210px ' + STORY_FONT_DISPLAY;
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255, 255, 255, .92)';
    g.fillText(getTrackMonogram(track.title), pad + 58, pad + size - 62);
  }
  g.restore();
  storyRoundRect(g, pad + 1, pad + 1, size - 2, size - 2, 39);
  g.strokeStyle = 'rgba(255, 255, 255, .14)';
  g.lineWidth = 2;
  g.stroke();
  return c;
}

async function prepareStoryScene(track) {
  var palette = getCoverPalette(track);
  var images = await Promise.all([loadStoryImage(getArtURL(track.id)), loadStoryImage('assets/icons/sonicvault-mark.svg'), loadStoryFonts()]);
  if (!_story || _story.trackId !== track.id) return;
  var art = images[0];
  var times = storyTimes(track);
  var lines = sungLyricLines(getTrackLyrics(track));
  _storyScene = {
    trackId:track.id,
    palette:palette,
    logo:images[1],
    background:paintStoryBackground(art, palette),
    cover:paintStoryCover(track, art, palette),
    title:String(track.title || 'Untitled'),
    sub:[track.genre, track.mood].filter(Boolean).join(' · '),
    lines:lines,
    times:times && times.length === lines.length ? times : null,
    // Untimed lyrics can't follow the singer, so the clip carries what the
    // song is about instead.
    caption:times ? '' : getTrackSummary(track),
    wrapped:{}
  };
}

function storyWrap(g, scene, text, font, maxLines) {
  var key = font + '|' + maxLines + '|' + text;
  if (!scene.wrapped[key]) {
    g.font = font;
    scene.wrapped[key] = wrapStoryText(text, function(s) { return g.measureText(s).width; }, STORY_TEXT_WIDTH, maxLines);
  }
  return scene.wrapped[key];
}

// Lines of text centred on the frame; returns the last baseline.
function drawStoryLines(g, scene, text, font, y, lineHeight, alpha, maxLines) {
  var lines = storyWrap(g, scene, text, font, maxLines);
  g.font = font;
  g.globalAlpha = Math.max(0, Math.min(1, alpha));
  g.fillStyle = '#fff';
  lines.forEach(function(line, n) { g.fillText(line, STORY_WIDTH / 2, y + n * lineHeight); });
  g.globalAlpha = 1;
  return y + Math.max(0, lines.length - 1) * lineHeight;
}

// The line being sung, rising in as it starts while the one before rises
// out, and the next line waiting underneath.
function drawStoryWords(g, scene, songT, clipEnd, top) {
  if (!scene.times) {
    if (scene.caption) drawStoryLines(g, scene, scene.caption, '500 46px ' + STORY_FONT_SANS, top, 62, .86, 4);
    return;
  }
  var times = scene.times;
  var lineFont = '700 62px ' + STORY_FONT_SANS;
  var nextFont = '500 42px ' + STORY_FONT_SANS;
  var i = currentLyricIndex(times, songT, .15);
  var appear = 1;
  var bottom = top;
  if (i >= 0) {
    appear = Math.min(1, Math.max(0, (songT + .15 - times[i][0]) / .3));
    if (appear < 1 && i > 0 && songT - times[i - 1][1] < 1.5) {
      drawStoryLines(g, scene, scene.lines[i - 1], lineFont, top - 56 * appear, 76, Math.pow(1 - appear, 2), 3);
    }
    bottom = drawStoryLines(g, scene, scene.lines[i], lineFont, top + 24 * (1 - appear), 76, appear, 3);
  }
  var k = i + 1;
  if (i < 0) {
    k = 0;
    while (k < times.length && times[k][0] <= songT) k++;
  }
  if (k < times.length && times[k][0] < clipEnd - .3 && times[k][0] - songT < 6) {
    drawStoryLines(g, scene, scene.lines[k], nextFont, i >= 0 ? bottom + 76 : top, 56, .42 * appear, 2);
  }
}

// Bars that move with the music, low notes in the middle.
function drawStoryBars(g, scene, levels, mid) {
  var n = levels.length;
  var total = n * 2;
  var width = 800;
  var step = width / total;
  var x0 = (STORY_WIDTH - width) / 2 + step / 2;
  if (scene.barCtx !== g) {
    var fill = g.createLinearGradient(x0, 0, x0 + width, 0);
    fill.addColorStop(0, scene.palette.b);
    fill.addColorStop(.5, scene.palette.accent || scene.palette.a);
    fill.addColorStop(1, scene.palette.b);
    scene.barFill = fill;
    scene.barCtx = g;
  }
  g.strokeStyle = scene.barFill;
  g.lineWidth = step * .56;
  g.lineCap = 'round';
  g.beginPath();
  for (var b = 0; b < total; b++) {
    var level = levels[b < n ? n - 1 - b : b - n] || 0;
    var h = 6 + level * 120;
    var x = x0 + b * step;
    g.moveTo(x, mid - h / 2);
    g.lineTo(x, mid + h / 2);
  }
  g.stroke();
}

function drawStoryMark(g, scene, baseline) {
  var label = 'SonicVault';
  var size = 54;
  var gap = 16;
  g.font = '700 34px ' + STORY_FONT_DISPLAY;
  var x = (STORY_WIDTH - (size + gap + g.measureText(label).width)) / 2;
  g.globalAlpha = .82;
  if (scene.logo) g.drawImage(scene.logo, x, baseline - 39, size, size);
  g.textAlign = 'left';
  g.fillStyle = '#fff';
  g.fillText(label, x + size + gap, baseline);
  g.textAlign = 'center';
  g.globalAlpha = 1;
}

// One frame: t seconds into a clip that starts clipStart seconds into the song.
function drawStoryFrame(g, scene, clipStart, t, clipLength, levels) {
  var W = STORY_WIDTH;
  var level = levels.reduce(function(sum, v) { return sum + v; }, 0) / Math.max(1, levels.length);
  g.globalAlpha = 1;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.drawImage(scene.background, 0, 0);
  storyBloom(g, W / 2, STORY_COVER_TOP + STORY_COVER / 2, STORY_COVER * (.78 + level * .3), scene.palette.a, .14 + level * .24);
  var side = scene.cover.width * (1 + level * .03);
  g.drawImage(scene.cover, (W - side) / 2, STORY_COVER_TOP + STORY_COVER / 2 - side / 2, side, side);

  var y = drawStoryLines(g, scene, scene.title, '800 74px ' + STORY_FONT_DISPLAY, STORY_COVER_TOP + STORY_COVER + 130, 84, 1, 2);
  if (scene.sub) {
    g.font = '500 34px ' + STORY_FONT_SANS;
    g.fillStyle = 'rgba(255, 255, 255, .66)';
    g.fillText(scene.sub, W / 2, y + 58);
  }
  drawStoryWords(g, scene, clipStart + t, clipStart + clipLength, 1290);
  drawStoryBars(g, scene, levels, 1610);
  drawStoryMark(g, scene, 1752);

  var fade = storyFade(t, clipLength);
  if (fade < 1) {
    g.globalAlpha = 1 - fade;
    g.fillStyle = '#05060c';
    g.fillRect(0, 0, W, STORY_HEIGHT);
    g.globalAlpha = 1;
  }
}

// Bar heights for a still: a gentle fall from the low notes outwards.
function storyStillLevels(n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(.16 + .5 * Math.pow(1 - i / n, 1.3) * (.65 + .35 * Math.abs(Math.sin(i * 1.9))));
  return out;
}

// The dialog's preview: a still from the clip, at the first line it shows.
function drawStoryPreview() {
  var canvas = document.getElementById('story-canvas');
  var scene = _storyScene;
  if (!canvas || !scene || !_story || scene.trackId !== _story.trackId || _story.phase === 'recording' || _story.phase === 'done') return;
  var t = Math.min(2, _story.length / 2);
  if (scene.times) {
    for (var i = 0; i < scene.times.length; i++) {
      var at = scene.times[i][0] - _story.start;
      if (at >= .2) {
        if (at < _story.length - 1) t = at + .5;
        break;
      }
    }
  }
  drawStoryFrame(canvas.getContext('2d'), scene, _story.start, t, _story.length, storyStillLevels(STORY_BARS));
}

// ── Recording ─────────────────────────────────────────────────────────

function decodeStoryAudio(data) {
  return new Promise(function(resolve, reject) {
    var pending = _audioContext.decodeAudioData(data, resolve, reject);
    if (pending && pending.then) pending.then(resolve, reject);
  });
}

async function loadStoryAudio(track) {
  if (_storyBuffer && _storyBuffer.id === track.id) return _storyBuffer.buffer;
  var src = track.audioURL || track.audioData;
  // Tagged like the waveform sweep: sw.js hands over a cached copy when it
  // has one and otherwise fetches without caching.
  if (/^https?:/.test(src)) src += (src.indexOf('?') === -1 ? '?' : '&') + 'sv-wave=1';
  var response = await fetch(src, { mode:'cors' });
  if (!response.ok) throw new Error('Couldn’t download the song (' + response.status + ').');
  var buffer = await decodeStoryAudio(await response.arrayBuffer());
  _storyBuffer = { id:track.id, buffer:buffer };
  return buffer;
}

// Plays the clip's stretch of the song into a recorder alongside the
// canvas, drawing each frame as it goes. Resolves with { blob, format }.
function recordStoryClip(buffer, scene, clipStart, length) {
  return new Promise(function(resolve, reject) {
    var ctx = _audioContext;
    var canvas = document.getElementById('story-canvas');
    var g = canvas.getContext('2d');
    var clipLength = Math.max(1, Math.min(length, buffer.duration - clipStart));
    var format = pickStoryFormat(function(type) { return MediaRecorder.isTypeSupported(type); });
    var dest = ctx.createMediaStreamDestination();
    var gain = ctx.createGain();
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = .78;
    var source = ctx.createBufferSource();
    source.buffer = buffer;
    // Into the recording only: nothing plays out loud.
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(dest);
    var video = canvas.captureStream(30);
    var stream = new MediaStream(video.getVideoTracks().concat(dest.stream.getAudioTracks()));
    var recorder = new MediaRecorder(stream, { mimeType:format.type, videoBitsPerSecond:5000000, audioBitsPerSecond:160000 });
    var chunks = [];
    var freq = new Uint8Array(analyser.frequencyBinCount);
    var cancelled = false;
    var finished = false;
    var lastSecond = -1;

    function cleanup() {
      try { source.stop(); } catch (e) {}
      [source, gain, analyser].forEach(function(node) { try { node.disconnect(); } catch (e) {} });
      stream.getTracks().forEach(function(track) { track.stop(); });
      video.getTracks().forEach(function(track) { track.stop(); });
    }
    function finish() {
      if (finished) return;
      finished = true;
      if (recorder.state !== 'inactive') recorder.stop();
      else cleanup();
    }
    recorder.ondataavailable = function(e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = function() {
      cleanup();
      if (cancelled) reject({ cancelled:true });
      else resolve({ blob:new Blob(chunks, { type:format.type.split(';')[0] }), format:format });
    };
    recorder.onerror = function(e) {
      cancelled = true;
      cleanup();
      reject(e && e.error || new Error('The recording failed.'));
    };
    _storyRun = { cancel:function() { cancelled = true; finish(); } };

    drawStoryFrame(g, scene, clipStart, 0, clipLength, storyBarLevels(null, STORY_BARS));
    recorder.start(1000);
    var t0 = ctx.currentTime + .15;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + .3);
    gain.gain.setValueAtTime(1, t0 + clipLength - .8);
    gain.gain.linearRampToValueAtTime(0, t0 + clipLength);
    source.start(t0, clipStart, clipLength);

    function frame() {
      if (finished) return;
      var t = Math.max(0, ctx.currentTime - t0);
      analyser.getByteFrequencyData(freq);
      drawStoryFrame(g, scene, clipStart, Math.min(t, clipLength), clipLength, storyBarLevels(freq, STORY_BARS));
      if (_story) {
        _story.progress = Math.min(1, t / clipLength);
        if (Math.floor(t) !== lastSecond) {
          lastSecond = Math.floor(t);
          renderStoryProgress(t, clipLength);
        }
      }
      if (t >= clipLength + .1) { finish(); return; }
      // Hidden pages get no animation frames; a timer keeps the clip going.
      if (document.hidden) setTimeout(frame, 33);
      else requestAnimationFrame(frame);
    }
    frame();
  });
}

async function makeStoryClip() {
  var track = storyTrack();
  if (!track || !storyEditable() || _story.timing) return;
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!_audioContext) _audioContext = new Ctx();
  // First, while the tap still counts as a gesture: browsers keep audio
  // suspended until the page is touched.
  try { await _audioContext.resume(); } catch (e) {}
  _story.phase = 'loading';
  _story.error = '';
  renderStoryDialog();
  try {
    var buffer = await loadStoryAudio(track);
    if (!_story || _story.trackId !== track.id) return;
    if (!_storyScene || _storyScene.trackId !== track.id) await prepareStoryScene(track);
    if (!_story || _story.trackId !== track.id) return;
    // The real length may differ from the stored one.
    _story.start = Math.min(_story.start, Math.max(0, buffer.duration - _story.length));
    // The preview still becomes the finished video's poster: its first
    // frame is the fade in from black.
    drawStoryPreview();
    var still = await storyStillBlob(document.getElementById('story-canvas'));
    if (!_story || _story.trackId !== track.id) return;
    _story.phase = 'recording';
    _story.progress = 0;
    renderStoryDialog();
    var result = await recordStoryClip(buffer, _storyScene, _story.start, _story.length);
    _storyRun = null;
    if (!_story || _story.trackId !== track.id) return;
    _story.url = URL.createObjectURL(result.blob);
    _story.file = new File([result.blob], storyFileName(track.title, result.format.ext), { type:result.blob.type });
    _story.poster = still ? URL.createObjectURL(still) : '';
    _story.ownPoster = !!still;
    _story.phase = 'done';
    renderStoryDialog();
    var kept = await keepStoryClip(_story.file, still, {
      trackId:track.id, title:track.title || 'Untitled', start:_story.start, length:_story.length,
      ext:result.format.ext, type:_story.file.type, size:_story.file.size, at:new Date().toISOString()
    });
    if (_story && kept && _story.phase === 'done' && !_story.viewing) _story.clipId = kept.id;
  } catch (e) {
    _storyRun = null;
    if (!_story) return;
    if (e && e.cancelled) {
      _story.phase = 'setup';
    } else {
      console.warn('Story clip failed:', e);
      _story.phase = 'error';
      _story.error = (e && e.message) || 'The clip couldn’t be made.';
    }
  }
  renderStoryDialog();
  if (_story && _story.phase === 'setup') drawStoryPreview();
}

function cancelStoryClip() {
  if (_storyRun) _storyRun.cancel();
}

function makeAnotherStoryClip() {
  if (!_story) return;
  releaseStoryResult();
  _story.phase = 'setup';
  renderStoryDialog();
  drawStoryPreview();
}

function canShareStoryClip() {
  try {
    return !!(_story && _story.file && navigator.canShare && navigator.canShare({ files:[_story.file] }));
  } catch (e) {
    return false;
  }
}

function shareStoryClip() {
  if (!canShareStoryClip()) { saveStoryClip(); return; }
  var track = storyTrack();
  var title = _story.viewing ? _story.viewing.title : (track && track.title);
  navigator.share({ files:[_story.file], title:title || 'SonicVault' }).catch(function(e) {
    if (e && e.name !== 'AbortError') showToast('Couldn’t share the clip. Save it instead.');
  });
}

function saveStoryClip() {
  if (!_story || !_story.url) return;
  var link = document.createElement('a');
  link.href = _story.url;
  link.download = _story.file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ── Kept clips ────────────────────────────────────────────────────────

function getStoryClips() {
  if (_storyClips) return _storyClips;
  try { _storyClips = JSON.parse(localStorage.getItem('sv_clips') || '[]'); } catch (e) { _storyClips = []; }
  if (!Array.isArray(_storyClips)) _storyClips = [];
  return _storyClips;
}

function saveStoryClipList() {
  try { localStorage.setItem('sv_clips', JSON.stringify(getStoryClips())); } catch (e) {}
}

function storyClipVideoKey(id) {
  return './__clips/video/' + encodeURIComponent(id);
}

function storyClipStillKey(id) {
  return './__clips/still/' + encodeURIComponent(id);
}

// The preview at half size as a JPEG: the finished clip's poster and its
// picture in the list. (A clip's first frame is the fade in from black.)
function storyStillBlob(canvas) {
  return new Promise(function(resolve) {
    try {
      var small = storyCanvas(STORY_WIDTH / 2, STORY_HEIGHT / 2);
      small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
      small.toBlob(function(blob) { resolve(blob || null); }, 'image/jpeg', .82);
    } catch (e) {
      resolve(null);
    }
  });
}

// Keeps a finished clip on this device and lets the oldest past STORY_KEEP
// go. Returns its entry, or null when the browser wouldn't store it (a
// private window, or the device is full): the clip on screen still works.
async function keepStoryClip(file, still, meta) {
  if (!('caches' in window)) return null;
  var clip = Object.assign({ id:'clip-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }, meta);
  try {
    var cache = await caches.open(STORY_CLIP_CACHE);
    await cache.put(storyClipVideoKey(clip.id), new Response(file, { headers:{ 'Content-Type':file.type } }));
    if (still) await cache.put(storyClipStillKey(clip.id), new Response(still, { headers:{ 'Content-Type':'image/jpeg' } }));
    var result = keepRecentClip(getStoryClips(), clip, STORY_KEEP);
    _storyClips = result.kept;
    saveStoryClipList();
    await Promise.all(result.dropped.map(function(old) {
      forgetStoryStill(old.id);
      return Promise.all([cache.delete(storyClipVideoKey(old.id)), cache.delete(storyClipStillKey(old.id))]);
    }));
    // Ask the browser not to clear this site's storage when space runs low.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function() {});
    return clip;
  } catch (e) {
    console.warn('Couldn’t keep the clip on this device:', e);
    return null;
  }
}

function forgetStoryStill(id) {
  if (_storyStills[id]) URL.revokeObjectURL(_storyStills[id]);
  delete _storyStills[id];
}

async function storyStillURL(id) {
  if (_storyStills[id]) return _storyStills[id];
  try {
    var response = await (await caches.open(STORY_CLIP_CACHE)).match(storyClipStillKey(id));
    if (!response) return '';
    _storyStills[id] = URL.createObjectURL(await response.blob());
    return _storyStills[id];
  } catch (e) {
    return '';
  }
}

// Drops list entries whose video the browser has since cleared.
async function syncKeptStoryClips() {
  if (!('caches' in window) || !getStoryClips().length) return;
  try {
    var cache = await caches.open(STORY_CLIP_CACHE);
    var present = await Promise.all(getStoryClips().map(function(clip) { return cache.match(storyClipVideoKey(clip.id)); }));
    var before = getStoryClips().length;
    _storyClips = getStoryClips().filter(function(clip, i) { return !!present[i]; });
    if (_storyClips.length !== before) {
      saveStoryClipList();
      renderKeptStoryClips();
    }
  } catch (e) {}
}

async function openKeptStoryClip(id) {
  if (!_story || _story.phase === 'loading' || _story.phase === 'recording') return;
  var clip = getStoryClips().find(function(item) { return item.id === id; });
  if (!clip) return;
  var response = null;
  try { response = await (await caches.open(STORY_CLIP_CACHE)).match(storyClipVideoKey(id)); } catch (e) {}
  if (!_story) return;
  if (!response) {
    _storyClips = getStoryClips().filter(function(item) { return item.id !== id; });
    saveStoryClipList();
    showToast('That clip is no longer on this device.');
    renderKeptStoryClips();
    return;
  }
  var blob = await response.blob();
  var poster = await storyStillURL(id);
  if (!_story || _story.phase === 'loading' || _story.phase === 'recording') return;
  releaseStoryResult();
  _story.url = URL.createObjectURL(blob);
  _story.file = new File([blob], storyFileName(clip.title, clip.ext), { type:clip.type || blob.type || 'video/mp4' });
  _story.poster = poster;
  _story.clipId = id;
  _story.viewing = clip;
  _story.phase = 'done';
  renderStoryDialog();
}

async function deleteKeptStoryClip(id) {
  _storyClips = getStoryClips().filter(function(clip) { return clip.id !== id; });
  saveStoryClipList();
  var showing = _story && _story.phase === 'done' && _story.clipId === id;
  if (showing && _story.viewing) {
    makeAnotherStoryClip();
  } else {
    if (showing) _story.clipId = '';   // made just now: it stays on screen, no longer kept
    renderStoryDialog();
  }
  forgetStoryStill(id);
  try {
    var cache = await caches.open(STORY_CLIP_CACHE);
    await Promise.all([cache.delete(storyClipVideoKey(id)), cache.delete(storyClipStillKey(id))]);
  } catch (e) {}
}

function renderKeptStoryClips() {
  var box = document.getElementById('story-kept');
  if (!box || !_story) return;
  var clips = getStoryClips();
  box.hidden = !clips.length;
  if (!clips.length) { box.innerHTML = ''; return; }
  var busy = _story.phase === 'loading' || _story.phase === 'recording';
  var current = _story.phase === 'done' ? _story.clipId : '';
  box.innerHTML = '<div class="story-label">Recent clips on this device</div>'
    + '<div class="story-kept-list">' + clips.map(function(clip) {
        var meta = 'From ' + fmtTime(clip.start) + ' · ' + clip.length + 's · ' + storyClipAge(clip.at);
        var here = clip.id === current;
        return '<div class="story-kept-row' + (here ? ' is-current' : '') + '">'
          + '<button type="button" class="story-kept-open"' + (busy ? ' disabled' : '') + (here ? ' aria-current="true"' : '')
          +   ' aria-label="' + attr('Open the clip of ' + clip.title + ', ' + meta) + '" onclick="openKeptStoryClip(' + jsq(clip.id) + ')">'
          +   '<span class="story-kept-thumb"><img alt="" data-clip-still="' + attr(clip.id) + '" hidden></span>'
          +   '<span class="story-kept-copy"><span class="story-kept-title">' + esc(clip.title) + '</span>'
          +   '<span class="story-kept-meta">' + esc(meta) + '</span></span>'
          + '</button>'
          + '<button type="button" class="story-kept-del"' + (busy ? ' disabled' : '')
          +   ' aria-label="' + attr('Delete the clip of ' + clip.title + ' from this device') + '" title="Delete from this device"'
          +   ' onclick="deleteKeptStoryClip(' + jsq(clip.id) + ')">' + icon('x') + '</button>'
          + '</div>';
      }).join('') + '</div>';
  box.querySelectorAll('img[data-clip-still]').forEach(function(img) {
    storyStillURL(img.getAttribute('data-clip-still')).then(function(url) {
      if (!url) return;
      img.src = url;
      img.hidden = false;
    });
  });
}

// ── The dialog ────────────────────────────────────────────────────────

function setStoryLength(seconds) {
  if (!storyEditable()) return;
  var wasBest = isBestStoryStart();
  _story.length = seconds;
  if (wasBest) pickBestStoryStart();
  else _story.start = Math.min(_story.start, Math.max(0, storyDuration(storyTrack()) - seconds));
  renderStoryDialog();
  drawStoryPreview();
}

function onStoryStartInput(value) {
  if (!_story) return;
  _story.start = Number(value) || 0;
  renderStoryWhen();
  drawStoryPreview();
}

function useBestStoryStart() {
  if (!_story || !_story.best) return;
  _story.start = _story.best.start;
  var slider = document.getElementById('story-start');
  if (slider) slider.value = _story.start;
  renderStoryWhen();
  drawStoryPreview();
}

var STORY_REASONS = {
  chorus:['the first chorus', 'Back to the chorus'],
  hook:['the line sung most', 'Back to the hook'],
  'first-line':['where the singing starts', 'Back to where the singing starts'],
  middle:['a third of the way in', 'Back to the suggested start']
};

function renderStoryWhen() {
  var when = document.getElementById('story-when');
  var best = document.getElementById('story-best');
  if (!when || !_story) return;
  var reason = _story.best && STORY_REASONS[_story.best.reason];
  var onBest = isBestStoryStart();
  when.innerHTML = esc(fmtTime(_story.start)) + (onBest && reason ? ' <span>· ' + esc(reason[0]) + '</span>' : '');
  if (best) {
    best.hidden = onBest || !reason;
    if (reason) best.textContent = reason[1];
  }
}

function renderStoryProgress(t, total) {
  var bar = document.querySelector('#story-progress span');
  if (bar) bar.style.width = Math.round(Math.min(1, t / total) * 100) + '%';
  var note = document.getElementById('story-note');
  if (note) note.textContent = 'Recording… ' + fmtTime(Math.min(t, total)) + ' of ' + fmtTime(total) + '. Keep this screen open until it finishes.';
}

function storyNote(track) {
  var phase = _story.phase;
  if (phase === 'setup' && _story.timing) return 'Timing the lyrics first, so the words land when they’re sung. About half a minute.';
  if (phase === 'loading') return 'Getting the song…';
  if (phase === 'error') return _story.error;
  if (phase === 'done') {
    var ext = _story.file.name.split('.').pop().toUpperCase();
    var shown = _story.viewing;
    var what = 'a ' + (shown ? shown.length : _story.length) + '-second ' + ext + ', ' + formatFileSize(_story.file.size) + '.';
    var note = shown
      ? 'Made ' + storyClipAge(shown.at) + ', from ' + fmtTime(shown.start) + ' of the song: ' + what
      : 'Ready: ' + what + (_story.clipId ? ' A copy stays on this device with your last ' + STORY_KEEP + ' clips.' : '');
    if (ext === 'WEBM') note += ' This browser can only record WebM, which iPhones and Instagram may not open; Safari or a recent Chrome makes MP4.';
    return note;
  }
  if (!hasLyrics(track)) return 'An instrumental: the clip shows the cover, the title and the sound.';
  if (!storyTimes(track)) {
    return getTrackSummary(track)
      ? 'These lyrics aren’t timed yet, so the clip shows what the song is about instead.'
      : 'These lyrics aren’t timed yet, so the clip shows the cover and the sound.';
  }
  return 'The lyrics appear as they’re sung.';
}

function renderStoryDialog() {
  if (!_story) return;
  var track = storyTrack();
  if (!track) return;
  var phase = _story.phase;
  var busy = phase === 'loading' || phase === 'recording' || _story.timing;
  var done = phase === 'done';
  var canvas = document.getElementById('story-canvas');
  var video = document.getElementById('story-video');
  canvas.hidden = done;
  video.hidden = !done;
  if (done && video.getAttribute('src') !== _story.url) {
    video.poster = _story.poster || '';
    video.src = _story.url;
  }
  if (!done && video.getAttribute('src')) {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
  }
  var progress = document.getElementById('story-progress');
  progress.hidden = phase !== 'recording';
  progress.querySelector('span').style.width = Math.round((_story.progress || 0) * 100) + '%';
  document.getElementById('story-song').textContent = (_story.viewing ? _story.viewing.title : track.title) || 'Untitled';

  var maxStart = Math.max(0, storyDuration(track) - _story.length);
  var locked = !storyEditable() || _story.timing;
  document.getElementById('story-controls').innerHTML = done ? '' :
      '<div class="story-field">'
    +   '<div class="story-label" id="story-length-label">Length</div>'
    +   '<div class="story-chips" role="group" aria-labelledby="story-length-label">'
    +     STORY_LENGTHS.map(function(seconds) {
            return '<button type="button" class="story-chip" aria-pressed="' + (seconds === _story.length) + '"'
              + (locked ? ' disabled' : '') + ' onclick="setStoryLength(' + seconds + ')">' + seconds + ' seconds</button>';
          }).join('')
    +   '</div>'
    + '</div>'
    + '<div class="story-field">'
    +   '<label class="story-label" for="story-start">Starts at</label>'
    +   '<div class="story-when" id="story-when"></div>'
    +   '<input type="range" class="vol-slider story-start" id="story-start" min="0" max="' + maxStart + '" step="0.5" value="' + _story.start + '"'
    +     (locked || !maxStart ? ' disabled' : '') + ' oninput="onStoryStartInput(this.value)">'
    +   '<button type="button" class="story-best" id="story-best"' + (locked ? ' disabled' : '') + ' onclick="useBestStoryStart()" hidden></button>'
    + '</div>';
  renderStoryWhen();

  var note = document.getElementById('story-note');
  note.textContent = storyNote(track);
  note.classList.toggle('is-error', phase === 'error');
  if (phase === 'recording') renderStoryProgress(_story.progress * _story.length, _story.length);

  var actions;
  if (phase === 'loading' || phase === 'recording') {
    actions = '<button class="sec-action" onclick="cancelStoryClip()">Cancel</button>';
  } else if (done) {
    actions = '<button class="sec-action" onclick="makeAnotherStoryClip()">' + (_story.viewing ? 'New clip' : 'Make another') + '</button>'
      + '<button class="sec-action' + (canShareStoryClip() ? '' : ' primary') + '" onclick="saveStoryClip()">Save video</button>'
      + (canShareStoryClip() ? '<button class="sec-action primary" onclick="shareStoryClip()">Share&hellip;</button>' : '');
  } else {
    actions = '<button class="sec-action" onclick="closeStoryClip()">Close</button>'
      + '<button class="sec-action primary" onclick="makeStoryClip()"' + (busy ? ' disabled' : '') + '>'
      + (phase === 'error' ? 'Try again' : 'Make the clip') + '</button>';
  }
  document.getElementById('story-actions').innerHTML = actions;
  renderKeptStoryClips();
}
