// Search by meaning in the library: "the one about my brother and poker",
// "something that feels like rain". Each song gets one vector of what it is
// about (js/data/meaning.js), made once through the AI worker's /embed and
// kept on this device; a search makes one for the query and ranks the songs
// by how close they are. A song's vector is remade when its words change.

var MEANING_CACHE_KEY = 'sv_meaning';   // the old localStorage home; IndexedDB 'meaning' now
var MEANING_BATCH = 12;
var MEANING_INDEX_DELAY_MS = 20000;
var _meaningIndex = loadMeaningIndex();     // { model, items: { id: { h, scale, data } } }
var _meaningVectors = {};                   // id -> Float32Array, unpacked on first use
var _meaningOn = (function() {
  try { return localStorage.getItem('sv_search_mode') === 'meaning'; } catch (e) { return false; }
})();
var _meaningIndexing = null;                // { done, total } while songs are being read
var _meaningIndexError = '';
var _meaningQuery = { text:'', rank:null, version:0, loading:false, error:'' };
var _meaningQueryVectors = {};              // query text -> Float32Array, this page load
var _meaningSearchTimer = null;
var _meaningIndexTimer = null;

function loadMeaningIndex() {
  try {
    var saved = JSON.parse(localStorage.getItem(MEANING_CACHE_KEY) || 'null');
    if (saved && saved.model === MEANING_MODEL && saved.items) return saved;
  } catch (e) {}
  return { model:MEANING_MODEL, items:{} };
}

// Saved to IndexedDB (js/features/store.js) once the saved copy has been
// read, so a start-up index never replaces it.
var _meaningHydrated = false;
function saveMeaningIndex() {
  if (_meaningHydrated) svIdbSave('meaning', _meaningIndex);
}

// The saved vectors, merged under any read since start-up; the old
// localStorage copy moves across and is cleared.
svIdbGet('meaning').then(function(saved) {
  if (saved && saved.model === MEANING_MODEL && saved.items) {
    Object.keys(saved.items).forEach(function(id) {
      if (!_meaningIndex.items[id]) _meaningIndex.items[id] = saved.items[id];
    });
  }
  _meaningHydrated = true;
  var hadLegacy = false;
  try { hadLegacy = !!localStorage.getItem(MEANING_CACHE_KEY); } catch (e) {}
  if (hadLegacy) {
    svIdbSet('meaning', _meaningIndex).then(function() {
      try { localStorage.removeItem(MEANING_CACHE_KEY); } catch (e) {}
    }).catch(function() {});
  }
  scheduleMeaningIndex();
}).catch(function() {
  _meaningHydrated = true;
  saveMeaningIndex = function() {
    try { localStorage.setItem(MEANING_CACHE_KEY, JSON.stringify(_meaningIndex)); } catch (e) {}
  };
});

function meaningAvailable() {
  return !!(_aiConfig && _aiConfig.endpoint) && !(typeof _coverDemoActive !== 'undefined' && _coverDemoActive);
}

function meaningSearchActive() {
  return _meaningOn && meaningAvailable();
}

async function embedTexts(texts) {
  var headers = { 'Content-Type':'application/json' };
  if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
  var response = await fetch(new URL('/embed', _aiConfig.endpoint).toString(), {
    method:'POST', headers:headers, body:JSON.stringify({ texts:texts })
  });
  var data = await response.json().catch(function() { return {}; });
  if (!response.ok) throw new Error(data.error || ('The worker answered ' + response.status + '.'));
  if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) throw new Error('The worker sent no vectors.');
  return data.vectors;
}

function songsNeedingMeaning() {
  return tracks.filter(function(track) {
    var text = songMeaningText(track);
    if (!text) return false;
    var item = _meaningIndex.items[track.id];
    return !item || item.h !== hashString(text);
  });
}

// Read every song not yet read (or changed since), a batch at a time.
async function indexSongsForMeaning() {
  if (_meaningIndexing || !meaningAvailable()) return;
  var todo = songsNeedingMeaning();
  // Songs deleted from the vault leave the index too.
  var live = {};
  tracks.forEach(function(track) { live[track.id] = true; });
  Object.keys(_meaningIndex.items).forEach(function(id) { if (!live[id]) delete _meaningIndex.items[id]; });
  if (!todo.length) { saveMeaningIndex(); return; }
  _meaningIndexing = { done:0, total:todo.length };
  _meaningIndexError = '';
  renderMeaningStatus();
  try {
    for (var i = 0; i < todo.length; i += MEANING_BATCH) {
      var batch = todo.slice(i, i + MEANING_BATCH);
      var texts = batch.map(songMeaningText);
      var vectors = await embedTexts(texts);
      batch.forEach(function(track, k) {
        var packed = packMeaningVector(vectors[k]);
        _meaningIndex.items[track.id] = { h:hashString(texts[k]), scale:packed.scale, data:packed.data };
        delete _meaningVectors[track.id];
      });
      _meaningIndexing.done = Math.min(todo.length, i + batch.length);
      saveMeaningIndex();
      renderMeaningStatus();
      renderSentencePlaylist();
    }
  } catch (e) {
    _meaningIndexError = (e && e.message) || 'Couldn’t read the songs.';
    console.warn('Meaning index stopped:', e);
  } finally {
    _meaningIndexing = null;
    saveMeaningIndex();
    // Results made before every song was read are made again.
    if (_meaningQuery.text) runMeaningSearch(_meaningQuery.text, true);
    renderMeaningStatus();
  }
}

// Keep the index current a while after each sync, once it has been used.
function scheduleMeaningIndex() {
  clearTimeout(_meaningIndexTimer);
  if (!meaningAvailable() || !Object.keys(_meaningIndex.items).length) return;
  _meaningIndexTimer = setTimeout(function() {
    if (document.visibilityState === 'visible' && !window.svBootPending) indexSongsForMeaning();
  }, MEANING_INDEX_DELAY_MS);
}

function songVector(id) {
  if (!_meaningVectors[id] && _meaningIndex.items[id]) _meaningVectors[id] = unpackMeaningVector(_meaningIndex.items[id]);
  return _meaningVectors[id] || null;
}

async function runMeaningSearch(text, force) {
  var query = String(text || '').trim();
  if (!query) return;
  if (!force && _meaningQuery.text === query && (_meaningQuery.rank || _meaningQuery.loading)) return;
  _meaningQuery = { text:query, rank:_meaningQuery.rank, version:_meaningQuery.version, loading:true, error:'' };
  renderMeaningStatus();
  try {
    var vector = _meaningQueryVectors[query];
    if (!vector) {
      vector = Float32Array.from((await embedTexts([query]))[0]);
      _meaningQueryVectors[query] = vector;
    }
    if (_meaningQuery.text !== query) return;   // a newer search took over
    var scored = tracks.map(function(track) {
      var v = songVector(track.id);
      return v ? { id:track.id, score:meaningSimilarity(vector, v) } : null;
    }).filter(Boolean);
    var rank = {};
    rankMeaningMatches(scored, 24).forEach(function(item, i) { rank[item.id] = i; });
    _meaningQuery.rank = rank;
    _meaningQuery.loading = false;
    _meaningQuery.version++;
  } catch (e) {
    _meaningQuery.loading = false;
    _meaningQuery.error = (e && e.message) || 'Search by meaning failed.';
  }
  renderTrackList();
}

// For getFilteredTracks: a map of id -> place for the current query, or
// null to search by words. While a new query is out, the last results stand
// rather than the shelf emptying.
function getMeaningRank(searchVal) {
  if (!meaningSearchActive() || !searchVal) return null;
  if (_meaningQuery.text !== String(searchVal).trim() && !_meaningQuery.loading) {
    clearTimeout(_meaningSearchTimer);
    _meaningSearchTimer = setTimeout(function() { runMeaningSearch(searchVal); }, 450);
  }
  return _meaningQuery.rank || null;
}

function getMeaningVersion() {
  return meaningSearchActive() ? _meaningQuery.version : -1;
}

function toggleMeaningSearch() {
  _meaningOn = !_meaningOn;
  try { localStorage.setItem('sv_search_mode', _meaningOn ? 'meaning' : 'words'); } catch (e) {}
  _meaningQuery = { text:'', rank:null, version:_meaningQuery.version + 1, loading:false, error:'' };
  if (_meaningOn) indexSongsForMeaning();
  renderMeaningToggle();
  invalidateFilterCache();
  renderTrackList();
  var input = document.getElementById('search-input');
  if (input) input.focus();
}

function renderMeaningToggle() {
  var btn = document.getElementById('search-mode-btn');
  var input = document.getElementById('search-input');
  if (!btn || !input) return;
  btn.hidden = !meaningAvailable();
  var on = meaningSearchActive();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.classList.toggle('active', on);
  input.placeholder = on
    ? 'Describe it: “the one about my brother and poker”'
    : 'Search titles, prompts, lyrics, moods, or tags...';
}

// The line under the search box about meaning search: reading songs,
// searching, or why it stopped.
function renderMeaningStatus() {
  var el = document.getElementById('meaning-status');
  if (!el) return;
  var text = '';
  if (meaningSearchActive()) {
    if (_meaningIndexing) text = 'Getting to know your songs… ' + _meaningIndexing.done + ' of ' + _meaningIndexing.total;
    else if (_meaningIndexError) text = 'Couldn’t read every song: ' + _meaningIndexError;
    else if (_meaningQuery.loading) text = 'Searching by meaning…';
    else if (_meaningQuery.error) text = _meaningQuery.error;
    else if (_meaningQuery.text && _meaningQuery.rank) text = 'Songs closest in meaning to “' + _meaningQuery.text + '”, best first.';
    else text = 'Describe a song in your own words: what it’s about, how it feels, a line you half remember.';
  }
  el.textContent = text;
  el.hidden = !text;
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') scheduleMeaningIndex();
});

// ── A playlist from a sentence ───────────────────────────────────────────
// The box on the Playlists page: "songs for a rainy Sunday drive" becomes
// a playlist of the songs closest to it in meaning (pickPlaylistByMeaning),
// one take of each, named after the sentence and opened to look over. The
// songs are read first if they haven't been (the same index as search).

var _sentencePlaylist = { busy:false, status:'' };

function renderSentencePlaylist() {
  var form = document.getElementById('pl-sentence-form');
  if (!form) return;
  form.hidden = !meaningAvailable();
  var btn = document.getElementById('pl-sentence-btn');
  if (btn) btn.disabled = _sentencePlaylist.busy;
  var status = document.getElementById('pl-sentence-status');
  if (status) {
    var text = _sentencePlaylist.status
      || (_meaningIndexing && _sentencePlaylist.busy ? 'Getting to know your songs\u2026 ' + _meaningIndexing.done + ' of ' + _meaningIndexing.total : '');
    status.textContent = text;
    status.hidden = !text;
  }
}

async function makePlaylistFromSentence() {
  var input = document.getElementById('pl-sentence');
  var text = input ? input.value.trim() : '';
  if (!text || _sentencePlaylist.busy) return;
  if (!meaningAvailable()) { showToast('Connect the AI worker to make playlists from a sentence.'); return; }
  _sentencePlaylist = { busy:true, status:'' };
  renderSentencePlaylist();
  try {
    if (songsNeedingMeaning().length) {
      var reading = indexSongsForMeaning();
      renderSentencePlaylist();   // "Getting to know your songs... 0 of N"
      await reading;
    }
    _sentencePlaylist.status = 'Finding the songs\u2026';
    renderSentencePlaylist();
    var vector = Float32Array.from((await embedTexts([text]))[0]);
    var songs = collapseVersions(tracks.filter(function(track) { return track.audioURL || track.audioData; }), tracks).list;
    var scored = songs.map(function(track) {
      var v = songVector(track.id);
      return v ? { id:track.id, score:meaningSimilarity(vector, v) } : null;
    }).filter(Boolean);
    var ids = pickPlaylistByMeaning(scored, 6, 20);
    if (!ids.length) throw new Error('None of your songs could be read yet.');
    var name = playlistNameFromSentence(text);
    var playlist = {
      id:'pl-' + Date.now(),
      name:name,
      color:PLAYLIST_COLOR_OPTIONS[hashString(text) % PLAYLIST_COLOR_OPTIONS.length].value,
      desc:'Made from \u201c' + text + '\u201d',
      trackIds:ids
    };
    playlists.push(playlist);
    persistPlaylists();
    renderPlaylists();
    if (input) input.value = '';
    _sentencePlaylist = { busy:false, status:'' };
    renderSentencePlaylist();
    showToast('Made \u201c' + name + '\u201d with ' + ids.length + ' songs');
    viewPlaylist(playlist.id);
  } catch (e) {
    console.warn('Sentence playlist failed:', e);
    _sentencePlaylist = { busy:false, status:'Couldn\u2019t make it: ' + ((e && e.message) || 'something went wrong') };
    renderSentencePlaylist();
  }
}
