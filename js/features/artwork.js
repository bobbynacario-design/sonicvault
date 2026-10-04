// Real cover art and lyrics. Suno embeds each song's artwork and lyric sheet
// in the MP3's tag, so both are read from the first few KB of the track's
// own audio -- a ranged request, never the whole file.
//
// The picture is derived data, kept on this device only: the image in Cache
// Storage, its palette and a "checked" mark in localStorage. Lyrics are the
// track's own content, so they are saved to the vault -- but only into a
// track whose lyrics are empty, never over lyrics someone has written.

var ART_CACHE_NAME = 'sv-art-v1';   // sw.js keeps this cache when it activates
var ART_PROBE_PARAM = 'sv-art';     // sw.js passes these requests straight through
var ART_PROBE_BYTES = 65536;
var ART_TAG_LIMIT = 1048576;        // never read past 1MB looking for the end of a tag
var _artIndex = null;               // track id -> { src, art, palette }
var _artURLs = {};                  // track id -> object URL, this page only
var _artDataURLs = {};              // track id -> data URL, for the OS media controls
var _artSweepTimer = null;
var _artSweepRunning = false;
var _artRangeBlocked = false;

function getArtIndex() {
  if (_artIndex) return _artIndex;
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('sv_art') || 'null'); } catch (e) { stored = null; }
  _artIndex = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
  return _artIndex;
}

function saveArtIndex() {
  try { localStorage.setItem('sv_art', JSON.stringify(getArtIndex())); } catch (e) {}
}

function artCacheKey(trackId) {
  return './__art/' + encodeURIComponent(trackId);
}

// Art the track is known to have, whether or not its image is loaded yet.
function trackHasArt(track) {
  var entry = track && track.id ? getArtIndex()[track.id] : null;
  return !!(entry && entry.art && entry.src === track.audioURL);
}

function getArtURL(trackId) {
  return _artURLs[trackId] || '';
}

// The colours to tint the shell with: the real artwork's when there is one,
// else the generated cover's.
function getCoverPalette(track) {
  if (trackHasArt(track) && getArtIndex()[track.id].palette) return getArtIndex()[track.id].palette;
  return getTrackPalette(track || {});
}

function setArtBlob(trackId, blob) {
  if (_artURLs[trackId]) URL.revokeObjectURL(_artURLs[trackId]);
  _artURLs[trackId] = URL.createObjectURL(blob);
  delete _artDataURLs[trackId];
}

// Put the picture into every cover already on screen for this track (or all
// tracks), without re-rendering the views around them.
function paintArt(onlyId) {
  document.querySelectorAll('.cover-art[data-art-id]').forEach(function(el) {
    var id = el.getAttribute('data-art-id');
    if (onlyId && id !== onlyId) return;
    var url = _artURLs[id];
    if (!url) return;
    var img = el.querySelector('.cover-img');
    if (!img) {
      img = document.createElement('img');
      img.className = 'cover-img';
      img.alt = '';
      el.appendChild(img);
    }
    if (img.getAttribute('src') !== url) img.src = url;
    el.classList.add('has-art');
  });
  var current = typeof _currentTrack !== 'undefined' ? _currentTrack : null;
  if (current && (!onlyId || current.id === onlyId) && _artURLs[current.id]) {
    applyTrackTint(current);
    paintPlayerBackdrop();
    updateMediaSession();
  }
}

// Data URL of a track's art for MediaMetadata, which wants a fetchable
// image. Converted once on demand; the caller retries when it lands.
function getArtDataURL(trackId) {
  if (_artDataURLs[trackId]) return _artDataURLs[trackId];
  var url = _artURLs[trackId];
  if (!url || _artDataURLs[trackId] === false) return '';
  _artDataURLs[trackId] = false;
  fetch(url).then(function(res) { return res.blob(); }).then(function(blob) {
    var reader = new FileReader();
    reader.onload = function() {
      _artDataURLs[trackId] = reader.result;
      if (_currentTrack && _currentTrack.id === trackId) updateMediaSession();
    };
    reader.readAsDataURL(blob);
  }).catch(function() { delete _artDataURLs[trackId]; });
  return '';
}

// Boot: turn the cached pictures back into object URLs, then paint them over
// the generated covers the first render drew.
function loadCachedArt() {
  if (!('caches' in window)) return Promise.resolve();
  var index = getArtIndex();
  var ids = Object.keys(index).filter(function(id) { return index[id] && index[id].art; });
  if (!ids.length) return Promise.resolve();
  return caches.open(ART_CACHE_NAME).then(function(cache) {
    return Promise.all(ids.map(function(id) {
      return cache.match(artCacheKey(id)).then(function(res) {
        if (!res) { delete index[id]; return null; }
        return res.blob().then(function(blob) { setArtBlob(id, blob); });
      });
    }));
  }).then(function() {
    saveArtIndex();
    paintArt();
  }).catch(function(e) {
    console.warn('cached artwork not restored:', e);
  });
}

// An older sw.js answers any Cloudinary audio request by downloading and
// caching the whole song, so with a worker in control, tagged reads
// (?sv-art, ?sv-wave) wait until it confirms it handles them. No worker,
// nothing to intercept.
function workerSupports(capability) {
  var sw = navigator.serviceWorker;
  if (!sw || !sw.controller) return Promise.resolve(true);
  return new Promise(function(resolve) {
    var settled = false;
    var channel = new MessageChannel();
    channel.port1.onmessage = function(event) {
      settled = true;
      resolve(!!(event.data && event.data[capability]));
    };
    setTimeout(function() { if (!settled) resolve(false); }, 2000);
    sw.controller.postMessage({ type:'sv-capabilities' }, [channel.port2]);
  });
}

function concatBytes(chunks, length) {
  var out = new Uint8Array(length);
  var offset = 0;
  chunks.forEach(function(chunk) {
    out.set(chunk.subarray(0, Math.min(chunk.length, length - offset)), offset);
    offset += chunk.length;
  });
  return out;
}

// Read the head of a file until the ID3 tag is complete, then stop. A
// server that honours Range sends only those bytes; one that ignores it gets
// its stream cancelled as soon as the tag is in.
async function readAudioHead(audioURL) {
  var url = audioURL + (audioURL.indexOf('?') === -1 ? '?' : '&') + ART_PROBE_PARAM + '=1';
  var response;
  if (!_artRangeBlocked) {
    try {
      response = await fetch(url, { headers:{ Range:'bytes=0-' + (ART_PROBE_BYTES - 1) } });
    } catch (e) {
      _artRangeBlocked = true;
    }
  }
  if (!response) response = await fetch(url);
  if (!response.ok) throw new Error('art probe HTTP ' + response.status);
  var chunks = [];
  var have = 0;
  var need = ART_PROBE_BYTES;
  var sized = false;
  var reader = response.body.getReader();
  while (have < need) {
    var step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    have += step.value.length;
    if (!sized && have >= 10) {
      sized = true;
      var tagLength = id3TagLength(concatBytes(chunks, 10));
      need = tagLength ? Math.min(tagLength, ART_TAG_LIMIT) : 10;
    }
  }
  reader.cancel().catch(function() {});
  var bytes = concatBytes(chunks, Math.min(have, need));
  // A ranged answer stops at 64KB; fetch the rest of a longer tag.
  if (response.status === 206 && bytes.length < need) {
    var rest = await fetch(url, { headers:{ Range:'bytes=' + bytes.length + '-' + (need - 1) } });
    if (rest.status !== 206) throw new Error('art probe range refused');
    var tail = new Uint8Array(await rest.arrayBuffer());
    bytes = concatBytes([bytes, tail], bytes.length + tail.length);
  }
  return bytes;
}

async function paletteFromBlob(blob) {
  var bitmap = await createImageBitmap(blob);
  var canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  var ctx = canvas.getContext('2d', { willReadFrequently:true });
  ctx.drawImage(bitmap, 0, 0, 24, 24);
  if (bitmap.close) bitmap.close();
  return paletteFromPixels(ctx.getImageData(0, 0, 24, 24).data);
}

// Put the file's lyric sheet into the private track when its lyrics are
// empty, and save that one track straight away. Returns whether the file
// had lyrics at all, so a track whose lyrics are later cleared on purpose
// is not refilled on the next sweep.
var _lyricsFilledThisSweep = false;
function fillLyricsFromTag(track, bytes) {
  var text = findEmbeddedLyrics(bytes);
  if (!text) return false;
  var privateTrack = (tracks || []).find(function(item) { return item.id === track.id; });
  if (privateTrack && !hasLyrics(privateTrack)) {
    privateTrack.lyrics = text;
    persistTracks();
    _lyricsFilledThisSweep = true;
    if (_currentTrack && _currentTrack.id === privateTrack.id) updateExpandedPlayer();
  }
  return true;
}

// Look one track up. A network failure records nothing, so the next sweep
// tries again; a file read cleanly is remembered, art or not.
async function probeTrackArt(track) {
  var bytes = await readAudioHead(track.audioURL);
  var hasLyricSheet = fillLyricsFromTag(track, bytes);
  return rememberTrackArt(track, findEmbeddedArt(bytes), hasLyricSheet);
}

// Record what a track's file carries -- its picture ({ mime, data }, or
// null) and whether it has a lyric sheet -- and paint the picture. Used by
// the sweep, and by the Create page for a song whose cover it already holds,
// so the cover shows at once instead of after the next sweep.
async function rememberTrackArt(track, art, hasLyricSheet) {
  var index = getArtIndex();
  if (!art) {
    index[track.id] = { src:track.audioURL, art:false, lyrics:!!hasLyricSheet };
    saveArtIndex();
    return false;
  }
  var blob = new Blob([art.data], { type:art.mime });
  var palette;
  try {
    palette = await paletteFromBlob(blob);
  } catch (e) {
    index[track.id] = { src:track.audioURL, art:false, lyrics:!!hasLyricSheet };
    saveArtIndex();
    return false;
  }
  if ('caches' in window) {
    var cache = await caches.open(ART_CACHE_NAME);
    await cache.put(artCacheKey(track.id), new Response(blob, { headers:{ 'Content-Type':art.mime } }));
  }
  index[track.id] = { src:track.audioURL, art:true, palette:palette, lyrics:!!hasLyricSheet };
  saveArtIndex();
  setArtBlob(track.id, blob);
  paintArt(track.id);
  return true;
}

function getArtCandidates() {
  var seen = {};
  var pool = (tracks || []).concat(typeof getPublicTrackPool === 'function' ? getPublicTrackPool() : []);
  return pool.filter(function(track) {
    if (!track || !track.id || seen[track.id]) return false;
    seen[track.id] = true;
    return /^https?:\/\//.test(track.audioURL || '');
  });
}

async function sweepArtwork() {
  if (_artSweepRunning || !('caches' in window) || !window.ReadableStream) return;
  var index = getArtIndex();
  // Entries from before lyrics were read have no `lyrics` key: re-read
  // those once too.
  var todo = getArtCandidates().filter(function(track) {
    var entry = index[track.id];
    return !entry || entry.src !== track.audioURL || !('lyrics' in entry);
  });
  if (!todo.length) return;
  _artSweepRunning = true;
  _lyricsFilledThisSweep = false;
  try {
    if (!(await workerSupports('artProbe'))) return;
    for (var i = 0; i < todo.length; i++) {
      if (navigator.onLine === false) break;
      try {
        await probeTrackArt(todo[i]);
      } catch (e) {
        console.warn('Artwork probe skipped for', todo[i].id, e);
      }
      await new Promise(function(resolve) { setTimeout(resolve, 150); });
    }
  } finally {
    _artSweepRunning = false;
    // One re-render for every lyric sheet filled, so "Lyrics missing" labels
    // clear without rebuilding the views once per track.
    if (_lyricsFilledThisSweep) renderTracks();
  }
}

// Called after boot and after every sync: new watcher imports and uploads
// pick up their art without a reload.
function scheduleArtSweep(delayMs) {
  clearTimeout(_artSweepTimer);
  _artSweepTimer = setTimeout(sweepArtwork, typeof delayMs === 'number' ? delayMs : 1500);
}

// The expanded player's full-bleed backdrop: the cover itself, blown up and
// blurred, so the whole screen takes on the track's colours.
function paintPlayerBackdrop() {
  var el = document.getElementById('xp-backdrop');
  if (!el) return;
  var track = typeof _currentTrack !== 'undefined' ? _currentTrack : null;
  if (!track) {
    el.innerHTML = '';
    el.removeAttribute('data-track');
    return;
  }
  var url = getArtURL(track.id);
  var palette = getCoverPalette(track);
  var key = track.id + '|' + (url ? 'art' : palette.a);
  if (el.getAttribute('data-track') === key) return;
  el.setAttribute('data-track', key);
  // No art: the generated cover's blooms, painted large. Blurring the cover
  // itself left mostly its dark ground.
  el.innerHTML = url
    ? '<img class="player-backdrop-art" src="' + attr(url) + '" alt="">'
    : '<div class="player-backdrop-art is-generated" style="--cover-a:' + palette.a + ';--cover-b:' + palette.b + ';--cover-c:' + palette.c + '"></div>';
}
