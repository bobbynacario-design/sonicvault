// Real cover art and lyrics. Suno embeds each song's artwork and lyric sheet
// in the MP3's tag, so both are read from the first few KB of the track's
// own audio -- a ranged request, never the whole file.
//
// The picture is derived data, kept on this device only: the image in Cache
// Storage, its palette and a "checked" mark in localStorage. Lyrics are the
// track's own content, so they are saved to the vault -- but only into a
// track whose lyrics are empty, never over lyrics someone has written.
// A finished release cover selected with "Use as song cover" is also
// device-local, stored separately so it wins over the file's picture.

var ART_CACHE_NAME = 'sv-art-v1';   // sw.js keeps this cache when it activates
var ART_PROBE_PARAM = 'sv-art';     // sw.js passes these requests straight through
var ART_PROBE_BYTES = 65536;
var ART_TAG_LIMIT = 1048576;        // never read past 1MB looking for the end of a tag
var _artIndex = null;               // track id -> { src, art, palette }
var _artURLs = {};                  // track id -> object URL, this page only
var _songCoverURLs = {};            // chosen release covers take precedence
var _songCoverIndex = null;
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

function songCoverCacheKey(trackId) {
  return './__art/selected/' + encodeURIComponent(trackId);
}

function getSongCoverIndex() {
  if (_songCoverIndex) return _songCoverIndex;
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('sv_song_covers') || 'null'); } catch (e) {}
  _songCoverIndex = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return _songCoverIndex;
}

// Store the finished release artwork separately from embedded art. Scans
// may still read lyrics and Suno stamps, but cannot overwrite this choice.
async function useSongCoverBlob(trackId, blob) {
  if (!('caches' in window)) throw new Error('This browser cannot save song covers.');
  var palette = await paletteFromBlob(blob);
  var cache = await caches.open(ART_CACHE_NAME);
  // A fresh key keeps the previous selection intact if saving fails.
  var key = songCoverCacheKey(trackId) + '/' + Date.now() + '-' + Math.random().toString(36).slice(2);
  await cache.put(key, new Response(blob, { headers:{ 'Content-Type':blob.type } }));
  var index = getSongCoverIndex();
  var previous = index[trackId];
  var next = Object.assign({}, index);
  next[trackId] = { key:key, palette:palette };
  try {
    localStorage.setItem('sv_song_covers', JSON.stringify(next));
  } catch (e) {
    await cache.delete(key).catch(function() {});
    throw new Error('The song cover could not be saved on this device.');
  }
  _songCoverIndex = next;
  if (_songCoverURLs[trackId]) URL.revokeObjectURL(_songCoverURLs[trackId]);
  _songCoverURLs[trackId] = URL.createObjectURL(blob);
  delete _artDataURLs[trackId];
  paintArt(trackId);
  if (previous && previous.key) await cache.delete(previous.key).catch(function() {});
}

// Art the track is known to have, whether or not its image is loaded yet.
function trackHasArt(track) {
  if (track && track.id && getSongCoverIndex()[track.id]) return true;
  var entry = track && track.id ? getArtIndex()[track.id] : null;
  return !!(entry && entry.art && entry.src === track.audioURL);
}

function getArtURL(trackId) {
  return _songCoverURLs[trackId] || _artURLs[trackId] || '';
}

// The colours to tint the shell with: the real artwork's when there is one,
// else the generated cover's.
function getCoverPalette(track) {
  var chosen = track && track.id ? getSongCoverIndex()[track.id] : null;
  if (chosen && chosen.palette) return chosen.palette;
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
    var url = getArtURL(id);
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
  if (current && (!onlyId || current.id === onlyId) && getArtURL(current.id)) {
    applyTrackTint(current);
    paintPlayerBackdrop();
    updateMediaSession();
  }
}

// Data URL of a track's art for MediaMetadata, which wants a fetchable
// image. Converted once on demand; the caller retries when it lands.
function getArtDataURL(trackId) {
  if (_artDataURLs[trackId]) return _artDataURLs[trackId];
  var url = getArtURL(trackId);
  if (!url || _artDataURLs[trackId] === false) return '';
  _artDataURLs[trackId] = false;
  fetch(url).then(function(res) { return res.blob(); }).then(function(blob) {
    var reader = new FileReader();
    reader.onload = function() {
      if (getArtURL(trackId) !== url) return;
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
  var chosen = getSongCoverIndex();
  var ids = Object.keys(index).filter(function(id) { return index[id] && index[id].art; });
  return caches.open(ART_CACHE_NAME).then(function(cache) {
    return Promise.all(ids.map(function(id) {
      return cache.match(artCacheKey(id)).then(function(res) {
        if (!res) { delete index[id]; return null; }
        return res.blob().then(function(blob) { setArtBlob(id, blob); });
      });
    }).concat(Object.keys(chosen).map(function(id) {
      var entry = chosen[id];
      var key = entry && entry.key;
      if (!key) { delete chosen[id]; return null; }
      return cache.match(key).then(function(res) {
        if (!res) { delete chosen[id]; return null; }
        return res.blob().then(function(blob) {
          if (getSongCoverIndex()[id] !== entry) return;
          if (_songCoverURLs[id]) URL.revokeObjectURL(_songCoverURLs[id]);
          _songCoverURLs[id] = URL.createObjectURL(blob);
          delete _artDataURLs[id];
        });
      });
    })));
  }).then(function() {
    saveArtIndex();
    localStorage.setItem('sv_song_covers', JSON.stringify(getSongCoverIndex()));
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
  if (!privateTrack) rememberFileLyrics(track.id, text);
  return true;
}

// The lyric sheets of shared tracks a visitor opens, read from the song
// file, for share records whose stored excerpt lost its line breaks (made
// before 2026-10-04). Kept on this device; a handful at most.
var FILE_LYRICS_KEY = 'sv_file_lyrics';
var FILE_LYRICS_LIMIT = 40;
var _fileLyrics = null;

function getFileLyricsMap() {
  if (_fileLyrics) return _fileLyrics;
  try { _fileLyrics = JSON.parse(localStorage.getItem(FILE_LYRICS_KEY) || '{}') || {}; } catch (e) { _fileLyrics = {}; }
  return _fileLyrics;
}

function getFileLyrics(trackId) {
  return getFileLyricsMap()[trackId] || '';
}

function rememberFileLyrics(trackId, text) {
  var map = getFileLyricsMap();
  if (map[trackId] === text) return;
  delete map[trackId];
  map[trackId] = text;
  var ids = Object.keys(map);
  while (ids.length > FILE_LYRICS_LIMIT) delete map[ids.shift()];
  try { localStorage.setItem(FILE_LYRICS_KEY, JSON.stringify(map)); } catch (e) {}
  if (typeof _routeState !== 'undefined' && _routeState.mode === 'track' && _routeState.id === trackId) renderRouteAwareView(true);
}

// Look one track up. A network failure records nothing, so the next sweep
// tries again; a file read cleanly is remembered, art or not.
async function probeTrackArt(track) {
  var bytes = await readAudioHead(track.audioURL);
  var hasLyricSheet = fillLyricsFromTag(track, bytes);
  return rememberTrackArt(track, findEmbeddedArt(bytes), hasLyricSheet, findSunoStamp(bytes));
}

// Record what a track's file carries -- its picture ({ mime, data }, or
// null), whether it has a lyric sheet, and Suno's stamp ({ made, id }, or
// null) -- and paint the picture. Used by the sweep, and by the Create page
// for a song whose cover it already holds, so the cover shows at once
// instead of after the next sweep.
async function rememberTrackArt(track, art, hasLyricSheet, stamp) {
  var index = getArtIndex();
  var known = { src:track.audioURL, art:false, lyrics:!!hasLyricSheet, stamp:stamp || false };
  if (!art) {
    index[track.id] = known;
    saveArtIndex();
    return false;
  }
  var blob = new Blob([art.data], { type:art.mime });
  var palette;
  try {
    palette = await paletteFromBlob(blob);
  } catch (e) {
    index[track.id] = known;
    saveArtIndex();
    return false;
  }
  if ('caches' in window) {
    var cache = await caches.open(ART_CACHE_NAME);
    await cache.put(artCacheKey(track.id), new Response(blob, { headers:{ 'Content-Type':art.mime } }));
  }
  index[track.id] = Object.assign(known, { art:true, palette:palette });
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

// Copy each file's Suno stamp -- when the song was made, and its Suno id --
// from the art index onto the private track, for the release check. All in
// one save; the index keeps the stamps, so a save lost to a closed tab is
// made on the next sweep.
function applySunoStamps() {
  if (typeof _coverDemoActive !== 'undefined' && _coverDemoActive) return 0;
  var index = getArtIndex();
  var changed = 0;
  (tracks || []).forEach(function(track) {
    var entry = track && track.id ? index[track.id] : null;
    var stamp = entry && entry.src === track.audioURL ? entry.stamp : null;
    if (!stamp) return;
    var made = stamp.made || track.madeAt || '';
    var id = stamp.id || track.sunoId || '';
    if (made === (track.madeAt || '') && id === (track.sunoId || '')) return;
    if (made) track.madeAt = made;
    if (id) track.sunoId = id;
    changed++;
  });
  if (changed) {
    persistTracks();
    if (typeof renderRelease === 'function') renderRelease();
  }
  return changed;
}

async function sweepArtwork() {
  if (_artSweepRunning || !('caches' in window) || !window.ReadableStream) return;
  var index = getArtIndex();
  applySunoStamps();
  var inVault = {};
  (tracks || []).forEach(function(track) { if (track && track.id) inVault[track.id] = true; });
  // Entries from before lyrics were read have no `lyrics` key, and vault
  // songs read before Suno's stamp was have no `stamp`: re-read those once,
  // unless another device already put the stamp on the song.
  var todo = getArtCandidates().filter(function(track) {
    var entry = index[track.id];
    if (!entry || entry.src !== track.audioURL || !('lyrics' in entry)) return true;
    if (inVault[track.id] && !('stamp' in entry) && !track.madeAt) return true;
    // A shared track whose excerpt lost its line breaks, read before its
    // sheet was kept: read it once more for the sheet.
    return entry.lyrics && isFlattenedLyrics(track.lyricsExcerpt) && !getFileLyrics(track.id);
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
    applySunoStamps();
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
  var key = track.id + '|' + (url || palette.a);
  if (el.getAttribute('data-track') === key) return;
  el.setAttribute('data-track', key);
  // No art: the generated cover's blooms, painted large. Blurring the cover
  // itself left mostly its dark ground.
  el.innerHTML = url
    ? '<img class="player-backdrop-art" src="' + attr(url) + '" alt="">'
    : '<div class="player-backdrop-art is-generated" style="--cover-a:' + palette.a + ';--cover-b:' + palette.b + ';--cover-c:' + palette.c + '"></div>';
}
