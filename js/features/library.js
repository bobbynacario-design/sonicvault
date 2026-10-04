// The browse shelf: filters, search and sort, the cached filtered list,
// progressive rendering of rows and cards, and per-track actions.

var _genreFilter = 'All';
var _moodFilter = 'All';
var _sourceFilter = 'All';
var _tagFilter = '';
var _sortMode = 'newest';
var _expandedTrackId = '';

function getTopPromptTags(limit) {
  var counts = {};
  tracks.forEach(function(track) {
    getTrackTags(track).forEach(function(tag) {
      counts[tag] = (counts[tag] || 0) + 1;
    });
  });
  return Object.keys(counts).sort(function(a, b) {
    return counts[b] - counts[a];
  }).slice(0, limit || 10);
}

// Filter and sort changes only affect the browse shelf, never the hero.
function setGenreFilter(value) { _genreFilter = value; renderTrackList(); }
function setMoodFilter(value) { _moodFilter = value; renderTrackList(); }
function setSourceFilter(value) { _sourceFilter = value; renderTrackList(); }
function setTagFilter(value) { _tagFilter = _tagFilter === value ? '' : value; renderTrackList(); }
function setSortMode(value) { _sortMode = value; renderTrackList(); }

// Typing rebuilds only the shelf, and only after the user pauses. Previously
// every keystroke re-rendered the hero plus the full grid (120ms at 300
// tracks), so fast typing queued a full render per character.
var _searchDebounce = null;
function onSearchInput() {
  if (_searchDebounce) clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(function() {
    _searchDebounce = null;
    renderTrackList();
  }, 140);
}

function clearFilters() {
  _genreFilter = 'All';
  _moodFilter = 'All';
  _sourceFilter = 'All';
  _tagFilter = '';
  _sortMode = 'newest';
  _expandedTrackId = '';
  var input = document.getElementById('search-input');
  if (input) input.value = '';
  if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
  renderTrackList();
}

function browseMood(value) {
  switchView('library');
  _moodFilter = value;
  renderTrackList();
  document.getElementById('browse-panel').scrollIntoView({ behavior:'smooth', block:'start' });
}

function browseTag(value) {
  switchView('library');
  _tagFilter = value;
  renderTrackList();
  document.getElementById('browse-panel').scrollIntoView({ behavior:'smooth', block:'start' });
}

// ── Filter disclosure ──────────────────────────────────────────────────
// The chip rows are collapsed by default. Everything currently applied is
// mirrored as a removable chip next to the toggle, so collapsing never
// hides state — it only hides the *choices*.
var _filterPanelOpen = false;

function getSearchQuery() {
  var input = document.getElementById('search-input');
  return input ? String(input.value || '').trim() : '';
}

function clearSearch() {
  var input = document.getElementById('search-input');
  if (input) input.value = '';
  if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
  renderTrackList();
}

function getActiveFilters() {
  var active = [];
  var query = getSearchQuery();
  // The search box narrows the shelf exactly like the chip filters do, so it
  // has to be visible and removable in the same place they are.
  if (query) active.push({ label:'Search: ' + query, clear:'clearSearch()' });
  if (_genreFilter !== 'All') active.push({ label:'Genre: ' + _genreFilter, clear:'setGenreFilter(\'All\')' });
  if (_moodFilter !== 'All') active.push({ label:'Mood: ' + _moodFilter, clear:'setMoodFilter(\'All\')' });
  if (_sourceFilter !== 'All') active.push({ label:'Source: ' + _sourceFilter, clear:'setSourceFilter(\'All\')' });
  if (_tagFilter) active.push({ label:'Tag: ' + _tagFilter, clear:'setTagFilter(' + jsq(_tagFilter) + ')' });
  return active;
}

function toggleFilterPanel(force) {
  _filterPanelOpen = typeof force === 'boolean' ? force : !_filterPanelOpen;
  var panel = document.getElementById('filter-stack');
  var btn = document.getElementById('filter-toggle');
  if (panel) panel.hidden = !_filterPanelOpen;
  if (btn) btn.setAttribute('aria-expanded', _filterPanelOpen ? 'true' : 'false');
  renderFilterBar();
}

function renderViewSwitch() {
  ['list', 'cards'].forEach(function(view) {
    var btn = document.getElementById('view-' + view);
    if (!btn) return;
    var on = _shelfView === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function renderFilterBar() {
  renderViewSwitch();
  var btn = document.getElementById('filter-toggle');
  var wrap = document.getElementById('active-filter-chips');
  var active = getActiveFilters();
  if (btn) {
    btn.textContent = _filterPanelOpen
      ? 'Hide filters'
      : (active.length ? 'Filters (' + active.length + ')' : 'Filters');
    btn.classList.toggle('has-active', active.length > 0);
  }
  if (!wrap) return;
  wrap.innerHTML = active.map(function(f) {
    return '<button class="active-filter-chip" onclick="' + f.clear + '" aria-label="' + attr('Remove filter ' + f.label) + '">'
      + esc(f.label) + '<span aria-hidden="true">&times;</span></button>';
  }).join('') + (active.length > 1
    ? '<button class="active-filter-chip clear-all" onclick="clearFilters()">Clear all</button>'
    : '');
}

function renderFilterRow(items, current, setterName, allLabel, elementId) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var html = '<button class="filter-chip default-chip ' + (current === allLabel ? 'active' : '') + '" onclick="' + setterName + '(' + jsq(allLabel) + ')">' + esc(allLabel) + '</button>';
  items.forEach(function(item) {
    html += '<button class="filter-chip ' + (current === item ? 'active' : '') + '" onclick="' + setterName + '(' + jsq(item) + ')">' + esc(item) + '</button>';
  });
  el.innerHTML = html;
}

function renderTagFilter() {
  var el = document.getElementById('tag-filter');
  if (!el) return;
  var tags = getTopPromptTags(12);
  if (!tags.length) {
    el.innerHTML = '<span class="filter-chip active">No discovery tags yet</span>';
    return;
  }
  var html = '<button class="filter-chip default-chip ' + (!_tagFilter ? 'active' : '') + '" onclick="setTagFilter(' + jsq('') + ')">All tags</button>';
  tags.forEach(function(tag) {
    html += '<button class="filter-chip ' + (_tagFilter === tag ? 'active' : '') + '" onclick="setTagFilter(' + jsq(tag) + ')">' + esc(tag) + '</button>';
  });
  el.innerHTML = html;
}

function renderSortFilter() {
  var el = document.getElementById('sort-filter');
  if (!el) return;
  var modes = [
    { id:'newest', label:'Newest first' },
    { id:'most-played', label:'Most played' },
    { id:'least-played', label:'Hidden gems' },
    { id:'title', label:'A to Z' }
  ];
  el.innerHTML = modes.map(function(mode) {
    return '<button class="filter-chip ' + (mode.id === 'newest' ? 'default-chip ' : '') + (_sortMode === mode.id ? 'active' : '') + '" onclick="setSortMode(' + jsq(mode.id) + ')">' + esc(mode.label) + '</button>';
  }).join('');
}

// Cached filtered/sorted tracks. Invalidated when filter state, search,
// sort, or the tracks array length/version changes. Edits to existing
// tracks bump _tracksVersion via invalidateFilterCache().
var _filterCache = { key: null, result: null };
var _tracksVersion = 0;
function invalidateFilterCache() { _tracksVersion++; _filterCache.key = null; }

function getFilteredTracks() {
  var searchVal = lower(document.getElementById('search-input') ? document.getElementById('search-input').value : '');
  // Searching by meaning ranks songs by what they are about instead of
  // matching words (js/features/meaning.js); null means search by words.
  var meaningRank = getMeaningRank(searchVal);
  var cacheKey = [
    searchVal, _genreFilter, _moodFilter, _sourceFilter, _tagFilter || '',
    _sortMode || '', tracks.length, _tracksVersion, getMeaningVersion(), meaningRank ? 'm' : 'w'
  ].join('|');
  if (_filterCache.key === cacheKey && _filterCache.result) {
    return _filterCache.result.slice();
  }
  var filtered = tracks.filter(function(track) {
    var haystack = [
      track.title,
      track.prompt,
      track.lyrics,
      track.genre,
      track.mood,
      track.aiGenre,
      track.aiMood,
      track.aiTheme,
      track.aiEnergy,
      track.aiVocalStyle,
      track.aiEra,
      getTrackSummary(track),
      getTrackAITags(track).join(' '),
      getTrackAIInstruments(track).join(' '),
      track.source,
      track.fileName
    ].join(' ').toLowerCase();
    var matchSearch = meaningRank ? meaningRank[track.id] !== undefined : (!searchVal || haystack.indexOf(searchVal) !== -1);
    var matchGenre = _genreFilter === 'All' || track.genre === _genreFilter;
    var matchMood = _moodFilter === 'All' || track.mood === _moodFilter;
    var matchSource = _sourceFilter === 'All' || track.source === _sourceFilter;
    var matchTag = !_tagFilter || getTrackTags(track).map(lower).indexOf(lower(_tagFilter)) !== -1 || lower(track.genre) === lower(_tagFilter) || lower(track.mood) === lower(_tagFilter) || lower(track.aiTheme) === lower(_tagFilter);
    return matchSearch && matchGenre && matchMood && matchSource && matchTag;
  });

  if (meaningRank) {
    filtered.sort(function(a, b) { return meaningRank[a.id] - meaningRank[b.id]; });
  } else if (_sortMode === 'most-played') {
    filtered.sort(function(a, b) { return Number(b.plays || 0) - Number(a.plays || 0) || compareNewestFirst(a, b); });
  } else if (_sortMode === 'least-played') {
    filtered.sort(function(a, b) { return Number(a.plays || 0) - Number(b.plays || 0) || compareNewestFirst(a, b); });
  } else if (_sortMode === 'title') {
    filtered.sort(function(a, b) { return String(a.title || '').localeCompare(String(b.title || '')); });
  } else {
    filtered.sort(function(a, b) { return compareNewestFirst(a, b); });
  }

  _filterCache.key = cacheKey;
  _filterCache.result = filtered;
  return filtered.slice();
}

function renderBrowseSummary(filtered, withVersions) {
  var el = document.getElementById('browse-summary');
  if (!el) return;
  var filters = [];
  var query = getSearchQuery();
  if (query) filters.push('search: "' + query + '"');
  if (_genreFilter !== 'All') filters.push('genre: ' + _genreFilter);
  if (_moodFilter !== 'All') filters.push('mood: ' + _moodFilter);
  if (_sourceFilter !== 'All') filters.push('source: ' + _sourceFilter);
  if (_tagFilter) filters.push('tag: ' + _tagFilter);
  if (_sortMode !== 'newest') filters.push('sort: ' + _sortMode.replace('-', ' '));
  var clearBtn = filters.length
    ? '<button class="browse-clear-pill" onclick="clearFilters()">Clear all filters</button>'
    : '';
  el.classList.toggle('has-filters', filters.length > 0);
  el.innerHTML = ''
    + '<div><strong>' + filtered.length + '</strong> ' + (withVersions > filtered.length
        ? 'song' + (filtered.length !== 1 ? 's' : '') + ' in view \u00b7 ' + withVersions + ' tracks counting versions.'
        : 'track' + (filtered.length !== 1 ? 's' : '') + ' in view.') + '</div>'
    + '<div>' + (filters.length ? 'Active filters: ' + esc(filters.join(' / ')) : 'Showing the full collection in listening-first order.') + '</div>'
    + clearBtn;
}

// The queue is resolved lazily at click time (playTrack -> startPlayback
// derives the filtered shelf itself). Building it per card called
// getFilteredTracks() once per row — 301 calls and 90k id-string copies at
// 300 tracks — and re-serialised the whole queue into every card's onclick,
// which was 36% of the list HTML and grew quadratically with the library.
// Shared by the card grid and the row list so the notes panel cannot drift
// between the two views.
function buildTrackNotes(track) {
  var prompt = track.prompt ? '<div class="expand-item" style="grid-column:1 / -1"><div class="expand-label">Prompt</div><div class="expand-value">' + esc(track.prompt) + '</div></div>' : '';
  var lyrics = hasLyrics(track)
    ? '<div class="expand-item" style="grid-column:1 / -1"><div class="expand-label">Lyrics</div><div class="expand-value" style="white-space:pre-wrap">' + esc(getTrackLyrics(track)) + '</div></div>'
    : '<div class="expand-item" style="grid-column:1 / -1"><div class="expand-label">Lyrics</div><div class="expand-value">No lyrics yet &mdash; use Edit details to paste a lyric sheet.</div></div>';
  var summary = getTrackSummary(track) ? '<div class="expand-item" style="grid-column:1 / -1"><div class="expand-label">About this song</div><div class="expand-value">' + esc(getTrackSummary(track)) + '</div></div>' : '';
  var aiFacts = [track.aiTheme, track.aiEnergy, track.aiVocalStyle, track.aiEra].filter(Boolean).join(' / ');
  return '<div class="track-expand" id="notes-' + esc(track.id) + '"><div class="expand-grid">'
    + '<div class="expand-item"><div class="expand-label">Source</div><div class="expand-value">' + esc(track.source || 'Suno') + '</div></div>'
    + '<div class="expand-item"><div class="expand-label">Added</div><div class="expand-value">' + esc(track.created || 'Undated') + '</div></div>'
    + '<div class="expand-item"><div class="expand-label">File</div><div class="expand-value">' + esc(track.fileName || 'Manual upload') + (track.fileSize ? ' &middot; ' + (track.fileSize / 1024 / 1024).toFixed(1) + ' MB' : '') + '</div></div>'
    + (aiFacts ? '<div class="expand-item"><div class="expand-label">Details</div><div class="expand-value">' + esc(aiFacts) + '</div></div>' : '')
    + prompt + summary + lyrics
    + '</div></div>';
}

function buildTrackCard(track) {
  var tags = getTrackTags(track);
  var waveform = getVisualWaveform(track, 48);
  var isPlaying = _currentTrack && _currentTrack.id === track.id && _isPlaying;
  var expanded = _expandedTrackId === track.id;

  return ''
    + '<div class="track-card' + (isPlaying ? ' playing' : '') + (expanded ? ' expanded' : '') + '" id="card-' + esc(track.id) + '">'
    +   '<div class="track-card-top">'
    +     buildCoverArt(track, 'md', true)
    +     '<div class="track-main">'
    +       '<div class="track-kicker">' + (_currentTrack && _currentTrack.id === track.id ? eqBars() : '') + esc(track.source || 'Suno') + ' / ' + esc(track.created || 'Undated') + '</div>'
    +       '<div class="track-title">' + esc(track.title) + '</div>'
    +       '<div class="track-subtitle">' + esc(getTrackPromptExcerpt(track, 118)) + '</div>'
    +       '<div class="pill-row">'
    +         '<span class="meta-pill highlight">' + esc(track.genre || 'Other') + '</span>'
    +         '<span class="meta-pill">' + esc(track.mood || 'Mood') + '</span>'
    +         '<span class="meta-pill">' + fmtTime(track.duration || 0) + '</span>'
    +         (!hasLyrics(track) ? '<span class="meta-pill warn">Lyrics missing</span>' : '')
    +         (track.shared ? '<span class="meta-pill shared">Public link live</span>' : '')
    +         (track.autoImported ? '<span class="meta-pill">Watcher import</span>' : '')
    +         versionChipHTML(track)
    +       '</div>'
    +       '<div class="track-tag-row">' + tags.slice(0, 6).map(function(tag) { return '<span class="track-tag">' + esc(tag) + '</span>'; }).join('') + '</div>'
    +       '<div class="track-meta-strip">'
    // The source filename is provenance, not something you scan a shelf by.
    // It lives in the notes panel now instead of on the card face.
    +         '<div class="track-stats"><span>' + fmtCompactNumber(track.plays || 0) + ' play' + (Number(track.plays || 0) === 1 ? '' : 's') + '</span></div>'
    // Play and Notes are the everyday actions and stay on the card. Cover,
    // Edit, Share, and Delete move into an overflow menu — six equal-weight
    // buttons per card wrapped onto two rows and made every card read as a
    // control panel rather than a record.
    +         '<div class="track-actions">'
    +           '<button class="action-btn primary" onclick="event.stopPropagation();playTrack(' + jsq(track.id) + ')">' + (isPlaying ? 'Pause' : 'Play') + '</button>'
    +           '<button class="action-btn js-notes-btn" aria-expanded="' + (expanded ? 'true' : 'false') + '" aria-controls="notes-' + esc(track.id) + '" onclick="event.stopPropagation();toggleExpand(' + jsq(track.id) + ')">' + (expanded ? 'Hide notes' : 'Notes') + '</button>'
    +           '<div class="card-menu-wrap">'
    +             '<button class="icon-btn card-menu-btn" id="menubtn-' + esc(track.id) + '"'
    +               ' aria-haspopup="menu" aria-expanded="false"'
    +               ' aria-label="' + attr('More actions for ' + (track.title || 'this track')) + '"'
    +               ' onclick="toggleCardMenu(' + jsq(track.id) + ', event)">' + icon('more') + '</button>'
    +             '<div class="card-menu" id="menu-' + esc(track.id) + '" role="menu" aria-label="Track actions">'
    +               '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();cycleTrackCover(' + jsq(track.id) + ')">Change cover</button>'
    +               '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();openEditTrack(' + jsq(track.id) + ')">Edit details</button>'
    +               (track.shared
                      ? '<button role="menuitem" class="is-shared" onclick="event.stopPropagation();closeAllCardMenus();unshareTrack(' + jsq(track.id) + ')">Revoke public link</button>'
                      : '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();shareTrack(' + jsq(track.id) + ')">Share&hellip;</button>')
    +               '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();openStoryClip(' + jsq(track.id) + ')">Make a story clip</button>'
    +               '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();startRadio(' + jsq(track.id) + ')">Start radio</button>' + lyricsFileMenuItems(track)
    +               '<button role="menuitem" class="is-danger" onclick="event.stopPropagation();closeAllCardMenus();deleteTrack(' + jsq(track.id) + ')">Delete track</button>'
    +             '</div>'
    +           '</div>'
    +         '</div>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="track-footer">'
    +     renderWaveformHTML(track.id, waveform)
    +     buildTrackNotes(track)
    +     versionListHTML(track)
    +   '</div>'
    + '</div>';
}

// Full library render: editorial hero + browse shelf. Use this when the
// underlying data changed.
function renderTracks() {
  renderLibraryHome();
  renderTrackList();
}

// Browse-shelf only: filters, summary, and the card grid. Search and filter
// changes go through here so a keystroke doesn't rebuild the whole hero.
function renderTrackList() {
  var genres = {};
  var moods = {};
  var sources = {};
  tracks.forEach(function(track) {
    if (track.genre) genres[track.genre] = 1;
    if (track.mood) moods[track.mood] = 1;
    if (track.source) sources[track.source] = 1;
  });

  renderFilterRow(Object.keys(genres).sort(), _genreFilter, 'setGenreFilter', 'All', 'genre-filter');
  renderFilterRow(Object.keys(moods).sort(), _moodFilter, 'setMoodFilter', 'All', 'mood-filter');
  renderFilterRow(Object.keys(sources).sort(), _sourceFilter, 'setSourceFilter', 'All', 'source-filter');
  renderTagFilter();
  renderSortFilter();
  renderFilterBar();
  renderMeaningToggle();
  renderMeaningStatus();

  var filtered = getFilteredTracks();
  // Each song once, its other takes behind a "2 versions" chip.
  var shelf = shelfCollapse(filtered);
  _shelfVersions = shelf.versions;
  renderGroupVersionsToggle();
  renderBrowseSummary(shelf.list, filtered.length);

  var el = document.getElementById('track-list');
  if (!el) return;
  // An empty vault has nothing to search or filter: the welcome card above is
  // the whole page until the first track lands, not a search box over
  // "No tracks match this shelf".
  var vaultEmpty = !tracks.length && !window.svBootPending;
  var panel = document.getElementById('browse-panel');
  if (panel) panel.hidden = vaultEmpty;
  el.hidden = vaultEmpty;
  if (!filtered.length) {
    _shelfRendered = 0;
    _shelfTracks = [];
    el.innerHTML = (!tracks.length && window.svBootPending)
      ? '<div class="skel skel-card"></div><div class="skel skel-card"></div>'
      : '<div class="empty-state"><strong>No tracks match this shelf.</strong>Try another mood, clear the prompt tag, or widen the search terms.</div>';
    return;
  }

  _shelfTracks = shelf.list;
  _shelfRendered = 0;
  el.className = _shelfView === 'list' ? 'track-list-view' : 'track-grid';
  el.innerHTML = '';
  appendShelfPage(el);
  observeShelfSentinel();

  if (_currentTrack && _isPlaying && _audio.duration) {
    updateWaveformProgress(_currentTrack.id, _audio.currentTime / _audio.duration);
  }
}

// ── Progressive shelf rendering ────────────────────────────────────────
// A full 600-track shelf is ~70k DOM nodes and a ~150ms parse. Rendering a
// page at a time keeps the first paint flat regardless of library size; the
// rest streams in as the user scrolls, with an explicit button as the
// fallback when IntersectionObserver is unavailable or the user prefers it.
var SHELF_PAGE_SIZE = 60;
var _shelfTracks = [];
var _shelfRendered = 0;
var _shelfObserver = null;

// ── List vs card view ──────────────────────────────────────────────────
// Cards present every track as an album release: two per row, each with
// cover, description, pills, tags, stats, buttons, and a waveform. That is
// unusable as a browse surface past a few dozen tracks, so a compact row
// list is the default and the card grid stays available as a toggle.
// Device-local like the player prefs — a view preference is not vault data.
var _shelfView = (function() {
  try { return localStorage.getItem('sv_shelf_view') === 'cards' ? 'cards' : 'list'; }
  catch (e) { return 'list'; }
})();

function setShelfView(view) {
  _shelfView = view === 'cards' ? 'cards' : 'list';
  try { localStorage.setItem('sv_shelf_view', _shelfView); } catch (e) {}
  renderTrackList();
}

function buildTrackRow(track, index) {
  var isPlaying = _currentTrack && _currentTrack.id === track.id && _isPlaying;
  var isCurrent = _currentTrack && _currentTrack.id === track.id;
  var expanded = _expandedTrackId === track.id;
  return ''
    + '<div class="track-row-wrap' + (expanded ? ' expanded' : '') + '" id="card-' + esc(track.id) + '" data-index="' + index + '">'
    + '<div class="track-row' + (isCurrent ? ' current' : '') + '"'
    +   (isCurrent ? ' aria-current="true"' : '')
    +   ' role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track')) + '"'
    +   ' onclick="playTrack(' + jsq(track.id) + ')">'
    +   '<div class="row-index" aria-hidden="true">' + (isCurrent ? eqBars() : (index + 1)) + '</div>'
    +   buildCoverArt(track, 'xs', false)
    +   '<div class="row-main">'
    +     '<div class="row-title">' + esc(track.title) + versionChipHTML(track) + '</div>'
    +     '<div class="row-sub">' + esc(track.genre || 'Other') + ' &middot; ' + esc(track.mood || 'Mood')
    +       (track.shared ? ' &middot; <span class="row-shared">Public link</span>' : '')
    +       (!hasLyrics(track) ? ' &middot; <span class="row-warn">No lyrics</span>' : '')
    +     '</div>'
    +   '</div>'
    +   '<div class="row-plays">' + fmtCompactNumber(track.plays || 0) + (Number(track.plays) === 1 ? ' play' : ' plays') + '</div>'
    +   '<div class="row-time">' + fmtTime(track.duration || 0) + '</div>'
    +   '<div class="row-actions">'
    +     '<button class="icon-btn js-notes-btn" aria-expanded="' + (expanded ? 'true' : 'false') + '" aria-controls="notes-' + esc(track.id) + '" onclick="event.stopPropagation();toggleExpand(' + jsq(track.id) + ')" aria-label="' + attr('Notes for ' + (track.title || 'track')) + '">Notes</button>'
    +     '<div class="card-menu-wrap">'
    +       '<button class="icon-btn card-menu-btn" id="menubtn-' + esc(track.id) + '"'
    +         ' aria-haspopup="menu" aria-expanded="false"'
    +         ' aria-label="' + attr('More actions for ' + (track.title || 'this track')) + '"'
    +         ' onclick="toggleCardMenu(' + jsq(track.id) + ', event)">' + icon('more') + '</button>'
    +       '<div class="card-menu" id="menu-' + esc(track.id) + '" role="menu" aria-label="Track actions">'
    // On a phone the row has no room for the Notes button, so it moves in here.
    +         '<button role="menuitem" class="menu-notes" onclick="event.stopPropagation();closeAllCardMenus();toggleExpand(' + jsq(track.id) + ')">Notes</button>'
    +         '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();cycleTrackCover(' + jsq(track.id) + ')">Change cover</button>'
    +         '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();openEditTrack(' + jsq(track.id) + ')">Edit details</button>'
    +         (track.shared
                ? '<button role="menuitem" class="is-shared" onclick="event.stopPropagation();closeAllCardMenus();unshareTrack(' + jsq(track.id) + ')">Revoke public link</button>'
                : '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();shareTrack(' + jsq(track.id) + ')">Share&hellip;</button>')
    +         '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();openStoryClip(' + jsq(track.id) + ')">Make a story clip</button>'
    +         '<button role="menuitem" onclick="event.stopPropagation();closeAllCardMenus();startRadio(' + jsq(track.id) + ')">Start radio</button>' + lyricsFileMenuItems(track)
    +         '<button role="menuitem" class="is-danger" onclick="event.stopPropagation();closeAllCardMenus();deleteTrack(' + jsq(track.id) + ')">Delete track</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + buildTrackNotes(track)
    + versionListHTML(track)
    + '</div>';
}

function appendShelfPage(el) {
  el = el || document.getElementById('track-list');
  if (!el) return;
  var sentinel = document.getElementById('shelf-sentinel');
  if (sentinel) sentinel.remove();

  var offset = _shelfRendered;
  var slice = _shelfTracks.slice(_shelfRendered, _shelfRendered + SHELF_PAGE_SIZE);
  if (slice.length) {
    el.insertAdjacentHTML('beforeend', slice.map(function(track, i) {
      return _shelfView === 'list' ? buildTrackRow(track, offset + i) : buildTrackCard(track);
    }).join(''));
    _shelfRendered += slice.length;
  }

  var remaining = _shelfTracks.length - _shelfRendered;
  if (remaining > 0) {
    el.insertAdjacentHTML('beforeend',
      '<div class="shelf-sentinel" id="shelf-sentinel">'
      + '<button class="sec-action" onclick="appendShelfPage()">Show ' + Math.min(SHELF_PAGE_SIZE, remaining) + ' more</button>'
      + '<div class="shelf-sentinel-copy">Showing ' + _shelfRendered + ' of ' + _shelfTracks.length + ' tracks in this shelf.</div>'
      + '</div>');
    observeShelfSentinel();
  }
}

function observeShelfSentinel() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (_shelfObserver) _shelfObserver.disconnect();
  var sentinel = document.getElementById('shelf-sentinel');
  if (!sentinel) return;
  _shelfObserver = new IntersectionObserver(function(entries) {
    if (entries.some(function(entry) { return entry.isIntersecting; })) {
      appendShelfPage();
    }
  }, { rootMargin: '600px 0px' });
  _shelfObserver.observe(sentinel);
}

// ── Card overflow menu ─────────────────────────────────────────────────
function closeAllCardMenus() {
  document.querySelectorAll('.card-menu.open').forEach(function(menu) {
    menu.classList.remove('open');
  });
  document.querySelectorAll('.card-menu-btn[aria-expanded="true"]').forEach(function(btn) {
    btn.setAttribute('aria-expanded', 'false');
  });
}

function toggleCardMenu(id, event) {
  if (event) event.stopPropagation();
  var menu = document.getElementById('menu-' + id);
  var btn = document.getElementById('menubtn-' + id);
  if (!menu) return;
  var wasOpen = menu.classList.contains('open');
  closeAllCardMenus();
  if (wasOpen) {
    if (btn) btn.focus();
    return;
  }
  menu.classList.add('open');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  var first = menu.querySelector('button');
  if (first) first.focus();
}

// Any click outside an open menu dismisses it.
document.addEventListener('click', function(e) {
  if (e.target && e.target.closest && e.target.closest('.card-menu-wrap')) return;
  closeAllCardMenus();
});

// The notes markup is already in every card and `.expanded` is a pure CSS
// state, so flip the class on the two affected cards instead of rebuilding
// the entire list to open one row.
function toggleExpand(id) {
  var previous = _expandedTrackId;
  _expandedTrackId = previous === id ? '' : id;

  [previous, _expandedTrackId].forEach(function(cardId) {
    if (!cardId) return;
    var card = document.getElementById('card-' + cardId);
    if (!card) return;
    var open = cardId === _expandedTrackId;
    card.classList.toggle('expanded', open);
    var btn = card.querySelector('.js-notes-btn');
    if (btn) {
      // Rows have a narrow actions column; cards have room for a verb.
      btn.textContent = card.classList.contains('track-row-wrap')
        ? 'Notes'
        : (open ? 'Hide notes' : 'Open notes');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  });
}

function deleteTrack(id) {
  var doomed = getTrackById(id);
  var wasShared = !!(doomed && doomed.shared);
  if (!confirm(wasShared
      ? 'Delete this track and revoke its public link?'
      : 'Delete this track from SonicVault?')) return;
  // Take the public page down first — otherwise the shared URL keeps serving
  // the prompt, lyrics excerpt, and audio after the track is gone locally.
  if (wasShared) revokeShare('track', id);
  tracks = tracks.filter(function(track) { return track.id !== id; });
  playlists.forEach(function(pl) {
    pl.trackIds = (pl.trackIds || []).filter(function(trackId) { return trackId !== id; });
  });
  persistTracks();
  invalidateVisualWaveform(id);
  persistPlaylists();
  if (_currentTrack && _currentTrack.id === id) {
    _audio.pause();
    _currentTrack = null;
    _isPlaying = false;
    updateNowPlaying();
  }
  renderTracks();
  renderPlaylists();
}
