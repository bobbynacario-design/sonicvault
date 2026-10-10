// Playlists: the playlist page and smart mixes, creating and deleting
// mixtapes, and the sequence editor with its drag-to-reorder.

function addTrackToPlaylist(playlistId, trackId) {
  var playlist = getPlaylistById(playlistId);
  var track = getTrackById(trackId);
  if (!playlist || !track) return;
  playlist.trackIds = playlist.trackIds || [];
  if (playlist.trackIds.indexOf(trackId) === -1) {
    playlist.trackIds.push(trackId);
    persistPlaylists();
    renderPlaylists();
    updateExpandedPlayer();
    showToast('Added to ' + playlist.name);
  } else {
    showToast('Already in ' + playlist.name);
  }
}

function duplicatePlaylist(id) {
  var source = getPlaylistById(id);
  if (!source) return;
  var copy = {
    id: 'pl-' + Date.now(),
    name: source.name + ' Copy',
    color: source.color || '#F08B62',
    desc: source.desc || '',
    trackIds: (source.trackIds || []).slice(),
    shared: false
  };
  playlists.unshift(copy);
  persistPlaylists();
  renderPlaylists();
  viewPlaylist(copy.id, true);
  showToast('Playlist duplicated');
}

function mergePlaylistEditDraft(pl) {
  if (!pl || _editingPlaylistId !== pl.id) return;
  var nameInput = document.getElementById('pl-edit-name');
  var descInput = document.getElementById('pl-edit-desc');
  var colorInput = document.querySelector('input[name="pl-edit-color"]:checked');
  if (nameInput && nameInput.value.trim()) pl.name = nameInput.value.trim();
  if (descInput) pl.desc = descInput.value.trim();
  if (colorInput) pl.color = safePlaylistColor(colorInput.value);
}

function shufflePlaylistMix(id) {
  var pl = getPlaylistById(id);
  if (!pl || !pl.trackIds || pl.trackIds.length < 2) return;
  mergePlaylistEditDraft(pl);
  var current = pl.trackIds.slice();
  for (var i = current.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = current[i];
    current[i] = current[j];
    current[j] = temp;
  }
  pl.trackIds = current;
  persistPlaylists();
  renderPlaylists();
  viewPlaylist(id, true);
  showToast('Playlist shuffled');
}

function movePlaylistTrack(id, fromIndex, direction) {
  var pl = getPlaylistById(id);
  if (!pl || !pl.trackIds) return;
  mergePlaylistEditDraft(pl);
  var toIndex = fromIndex + direction;
  if (toIndex < 0 || toIndex >= pl.trackIds.length) return;
  var next = pl.trackIds.slice();
  var moved = next.splice(fromIndex, 1)[0];
  next.splice(toIndex, 0, moved);
  pl.trackIds = next;
  persistPlaylists();
  renderPlaylists();
  viewPlaylist(id, true);
}

// ── Drag-to-reorder for the sequence editor ────────────────────────────
// The Up/Down buttons stay the keyboard path; this is the pointer path.
// Both land on the same reorder + persist, so the two never diverge.
function reorderPlaylistTrack(id, fromIndex, toIndex) {
  var pl = getPlaylistById(id);
  if (!pl || !pl.trackIds) return;
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= pl.trackIds.length) return;
  mergePlaylistEditDraft(pl);
  var next = pl.trackIds.slice();
  var moved = next.splice(fromIndex, 1)[0];
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
  pl.trackIds = next;
  persistPlaylists();
  renderPlaylists();
  viewPlaylist(id, true);
  showToast('Moved to position ' + (Math.max(0, Math.min(pl.trackIds.length - 1, toIndex)) + 1));
}

var _dragPlaylistId = '';
var _dragFromIndex = -1;

function onSeqDragStart(e, playlistId, index) {
  _dragPlaylistId = playlistId;
  _dragFromIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  // Firefox refuses to start a drag unless some data is set.
  try { e.dataTransfer.setData('text/plain', String(index)); } catch (err) {}
  e.currentTarget.classList.add('dragging');
}

function onSeqDragOver(e, playlistId, index) {
  if (_dragPlaylistId !== playlistId || _dragFromIndex === -1) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var row = e.currentTarget;
  if (index === _dragFromIndex) { clearSeqDropMarkers(); return; }
  var box = row.getBoundingClientRect();
  var after = (e.clientY - box.top) > box.height / 2;
  clearSeqDropMarkers();
  row.classList.add(after ? 'drop-after' : 'drop-before');
}

function onSeqDrop(e, playlistId, index) {
  if (_dragPlaylistId !== playlistId || _dragFromIndex === -1) return;
  e.preventDefault();
  var row = e.currentTarget;
  var box = row.getBoundingClientRect();
  var after = (e.clientY - box.top) > box.height / 2;
  var target = index + (after ? 1 : 0);
  // Removing the dragged row first shifts everything below it up by one.
  if (target > _dragFromIndex) target -= 1;
  var from = _dragFromIndex;
  clearSeqDropMarkers();
  _dragFromIndex = -1;
  _dragPlaylistId = '';
  reorderPlaylistTrack(playlistId, from, target);
}

function onSeqDragEnd() {
  clearSeqDropMarkers();
  _dragFromIndex = -1;
  _dragPlaylistId = '';
  var dragging = document.querySelector('.pl-row.dragging');
  if (dragging) dragging.classList.remove('dragging');
}

function clearSeqDropMarkers() {
  document.querySelectorAll('.pl-row.drop-before, .pl-row.drop-after').forEach(function(el) {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function removePlaylistTrack(id, trackId) {
  var pl = getPlaylistById(id);
  if (!pl) return;
  mergePlaylistEditDraft(pl);
  pl.trackIds = (pl.trackIds || []).filter(function(itemId) { return itemId !== trackId; });
  persistPlaylists();
  renderPlaylists();
  updateExpandedPlayer();
  viewPlaylist(id, true);
  showToast('Removed from playlist');
}

function setPlaylistEditMode(id, enabled) {
  _editingPlaylistId = enabled ? id : '';
  viewPlaylist(id, true);
}

function savePlaylistEdits(id) {
  var pl = getPlaylistById(id);
  if (!pl) return;
  var nameInput = document.getElementById('pl-edit-name');
  if (!nameInput || !nameInput.value.trim()) {
    showToast('Playlist needs a name');
    return;
  }
  pl.name = nameInput.value.trim();
  var descInput = document.getElementById('pl-edit-desc');
  var colorInput = document.querySelector('input[name="pl-edit-color"]:checked');
  pl.desc = descInput ? descInput.value.trim() : '';
  pl.color = safePlaylistColor(colorInput ? colorInput.value : pl.color);
  persistPlaylists();
  renderPlaylists();
  _editingPlaylistId = '';
  viewPlaylist(id, true);
  showToast('Playlist updated');
}

function getFeaturedPlaylist() {
  if (!playlists.length) return null;
  return playlists.slice().sort(function(a, b) {
    var aTracks = getPlaylistTracks(a);
    var bTracks = getPlaylistTracks(b);
    var scoreA = aTracks.length * 10 + getCollectionDuration(aTracks) / 60 + (a.desc ? 3 : 0);
    var scoreB = bTracks.length * 10 + getCollectionDuration(bTracks) / 60 + (b.desc ? 3 : 0);
    return scoreB - scoreA || playlistTimestamp(b) - playlistTimestamp(a);
  })[0];
}

function getPlaylistRelatedTracks(pl, limit) {
  var items = getPlaylistTracks(pl);
  var itemIds = items.map(function(track) { return track.id; });
  return tracks.filter(function(track) {
    return itemIds.indexOf(track.id) === -1;
  }).map(function(track) {
    var score = 0;
    items.forEach(function(item) {
      if (track.genre && item.genre && track.genre === item.genre) score += 3;
      if (track.mood && item.mood && track.mood === item.mood) score += 4;
      if (track.source && item.source && track.source === item.source) score += 2;
      if (track.aiTheme && item.aiTheme && track.aiTheme === item.aiTheme) score += 3;
      if (track.aiEra && item.aiEra && track.aiEra === item.aiEra) score += 2;
      getTrackAITags(track).forEach(function(tag) {
        if (getTrackAITags(item).indexOf(tag) !== -1) score += 1;
      });
    });
    return score > 0 ? { track:track, score:score } : null;
  }).filter(Boolean).sort(function(a, b) {
    return b.score - a.score || trackTimestamp(b.track) - trackTimestamp(a.track);
  }).slice(0, limit || 4).map(function(entry) { return entry.track; });
}

function renderPlaylistHero() {
  var el = document.getElementById('playlist-hero');
  if (!el) return;
  // The Playlists section below carries the empty state and the New
  // playlist button; a second "No playlists yet" up here only repeated it.
  el.hidden = !playlists.length;
  if (!playlists.length) {
    el.innerHTML = '';
    return;
  }
  var featured = getFeaturedPlaylist();
  var items = getPlaylistTracks(featured);
  var plays = items.reduce(function(sum, track) { return sum + Number(track.plays || 0); }, 0);
  var order = items.slice(0, 6).map(function(track, index) {
    return '<li class="pl-order-row" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ' from ' + featured.name) + '" onclick="playPlaylistTrack(' + jsq(featured.id) + ', ' + jsq(track.id) + ')">'
      + '<span class="pl-order-num">' + (index + 1) + '</span>'
      + '<span class="pl-order-title">' + esc(track.title) + '</span>'
      + '<span class="pl-order-time">' + fmtTime(track.duration || 0) + '</span>'
      + '</li>';
  }).join('');
  var more = items.length - 6;
  el.innerHTML = '<section class="pl-feature" style="' + playlistAccentVars(featured) + '" aria-label="' + attr('Featured mixtape: ' + featured.name) + '">'
    + '<div class="pl-feature-art">' + buildPlaylistArt(featured, items) + '</div>'
    + '<div class="pl-feature-main">'
    +   '<div class="pl-eyebrow">Featured mixtape</div>'
    +   '<h2 class="pl-feature-title">' + esc(featured.name) + '</h2>'
    +   (featured.desc ? '<p class="pl-feature-desc">' + esc(featured.desc) + '</p>' : '')
    +   '<div class="pl-feature-meta">' + esc(playlistMeta(items)) + (plays ? ' \u00b7 ' + fmtCompactNumber(plays) + (plays === 1 ? ' play' : ' plays') : '') + playlistBadges(featured) + '</div>'
    +   '<div class="pl-actions">'
    +     (items.length ? '<button type="button" class="sec-action primary has-icon" onclick="playPlaylist(' + jsq(featured.id) + ')">' + icon('play') + 'Play</button>'
    +       '<button type="button" class="sec-action has-icon" onclick="playPlaylistShuffled(' + jsq(featured.id) + ')">' + icon('shuffle') + 'Shuffle</button>' : '')
    +     '<button type="button" class="sec-action" onclick="viewPlaylist(' + jsq(featured.id) + ')">Open</button>'
    +   '</div>'
    + '</div>'
    + (order ? '<div class="pl-feature-side"><div class="pl-side-label">Running order</div><ol class="pl-order">' + order + '</ol>'
        + (more > 0 ? '<button type="button" class="pl-more" onclick="viewPlaylist(' + jsq(featured.id) + ')">and ' + more + ' more</button>' : '') + '</div>' : '')
    + '</section>';
}

// Smart mixes: rule-based playlists computed live from the vault. They aren't
// persisted — they recompute on every render so they stay current as tracks
// are imported and tagged. A mix can be snapshotted into a real playlist.
function getSmartMixes() {
  if (!tracks.length) return [];
  var mixes = [];
  var minSize = tracks.length >= 8 ? 3 : 2;
  // Songs that keep being skipped stay out (js/features/listening.js).
  var mixable = mixableTracks();

  function build(id, name, desc, color, predicate) {
    var ids = mixable.filter(predicate).map(function(t) { return t.id; });
    if (ids.length >= minSize) mixes.push({ id: id, name: name, desc: desc, color: color, trackIds: ids });
  }

  var genreCounts = {}, moodCounts = {};
  tracks.forEach(function(t) {
    genreCounts[t.genre || 'Other'] = (genreCounts[t.genre || 'Other'] || 0) + 1;
    moodCounts[t.mood || 'Other'] = (moodCounts[t.mood || 'Other'] || 0) + 1;
  });
  Object.keys(genreCounts).forEach(function(g) {
    build('smart:genre:' + g, 'All ' + g, 'Every ' + g.toLowerCase() + ' record in the vault.', getGenreColor(g), function(t) { return (t.genre || 'Other') === g; });
  });
  Object.keys(moodCounts).forEach(function(m) {
    build('smart:mood:' + m, m + ' sessions', 'Tracks leaning ' + m.toLowerCase() + '.', getMoodColor(m), function(t) { return (t.mood || 'Other') === m; });
  });

  build('smart:instrumental', 'Instrumentals', 'No-lyric and instrumental records for focus listening.', '#A794FF', function(t) {
    return !hasLyrics(t) || /instrument/i.test(String(t.aiVocalStyle || ''));
  });
  build('smart:energy:high', 'High energy', 'The driving, high-energy end of the vault (AI-rated).', '#FF7C74', function(t) {
    return lower(t.aiEnergy) === 'high';
  });
  build('smart:energy:low', 'Wind down', 'Low-energy, easy records for late nights (AI-rated).', '#79A6FF', function(t) {
    return lower(t.aiEnergy) === 'low';
  });

  // Top recurring tags that aren't already a genre/mood mix.
  var reserved = {};
  Object.keys(genreCounts).forEach(function(g) { reserved[lower(g)] = 1; });
  Object.keys(moodCounts).forEach(function(m) { reserved[lower(m)] = 1; });
  tracks.forEach(function(t) { if (t.source) reserved[lower(t.source)] = 1; });
  var tagCounts = {};
  tracks.forEach(function(t) {
    getTrackTags(t).forEach(function(tag) { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
  });
  Object.keys(tagCounts).filter(function(tag) { return !reserved[lower(tag)]; })
    .sort(function(a, b) { return tagCounts[b] - tagCounts[a]; })
    .slice(0, 4)
    .forEach(function(tag) {
      build('smart:tag:' + tag, tag, 'Everything tagged "' + tag + '".', 'var(--accent-dynamic)', function(t) {
        return getTrackTags(t).some(function(x) { return lower(x) === lower(tag); });
      });
    });

  mixes.sort(function(a, b) { return b.trackIds.length - a.trackIds.length; });
  return mixes.slice(0, 12);
}

function findSmartMix(id) {
  return getSmartMixes().filter(function(m) { return m.id === id; })[0] || null;
}

function playSmartMix(id) {
  var m = findSmartMix(id);
  if (!m || !m.trackIds.length) { showToast('That smart mix is empty now'); return; }
  startPlayback(m.trackIds[0], m.trackIds.slice(), m.name);
}

function saveSmartMixAsPlaylist(id) {
  var m = findSmartMix(id);
  if (!m) return;
  playlists.push({
    id: 'pl-' + Date.now(),
    name: m.name,
    color: safePlaylistColor(m.color),
    desc: m.desc + ' (saved from a smart mix)',
    trackIds: m.trackIds.slice()
  });
  persistPlaylists();
  renderPlaylists();
  showToast('Saved "' + m.name + '" as a playlist');
}

function renderSmartMixes() {
  var card = document.getElementById('smart-mix-card');
  var grid = document.getElementById('smart-mix-grid');
  if (!grid) return;
  var mixes = getSmartMixes();
  if (!mixes.length) { if (card) card.style.display = 'none'; return; }
  if (card) card.style.display = '';
  grid.innerHTML = mixes.map(buildSmartMixCard).join('');
}

function renderPlaylists() {
  if (typeof renderSentencePlaylist === 'function') renderSentencePlaylist();
  renderPlaylistHero();
  renderSmartMixes();
  var el = document.getElementById('playlist-grid');
  if (!el) return;
  if (!playlists.length) {
    // The section's own New playlist button is right above this.
    el.innerHTML = '<div class="pl-empty"><strong>No playlists yet.</strong> Start with a mood, a night drive, or a favourite era, and build your first mix.</div>';
    return;
  }
  el.innerHTML = playlists.slice().sort(function(a, b) {
    return playlistTimestamp(b) - playlistTimestamp(a);
  }).map(buildPlaylistCard).join('');
}

// ── Cards ──────────────────────────────────────────────────────────────────

// A playlist's artwork: four covers in a square from four tracks up, the
// first track's cover below that, an empty frame with none.
function buildPlaylistArt(pl, items) {
  items = items || getPlaylistTracks(pl);
  if (!items.length) return '<div class="pl-art is-empty" aria-hidden="true">' + icon('playlists') + '</div>';
  if (items.length < 4) return '<div class="pl-art" aria-hidden="true">' + buildCoverArt(items[0], 'sm', false) + '</div>';
  return '<div class="pl-art is-quad" aria-hidden="true">' + items.slice(0, 4).map(function(track) {
    return buildCoverArt(track, 'sm', false);
  }).join('') + '</div>';
}

function playlistMeta(items) {
  if (!items.length) return 'No tracks yet';
  return items.length + ' track' + (items.length === 1 ? '' : 's') + ' \u00b7 ' + fmtLongDuration(getCollectionDuration(items));
}

function playlistBadges(pl) {
  var out = '';
  if (typeof isPlaylistOffline === 'function' && isPlaylistOffline(pl.id)) out += '<span class="pl-badge">' + icon('download') + 'Offline</span>';
  if (pl.shared) out += '<span class="pl-badge is-shared">Public link</span>';
  return out;
}

// Whether this playlist is what is playing now.
function isPlaylistPlaying(pl, items) {
  return !!(_currentTrack && _isPlaying && _playQueueLabel === pl.name && items.some(function(track) { return track.id === _currentTrack.id; }));
}

function playOverlayHTML(label, playing, action) {
  return '<button type="button" class="pl-play' + (playing ? ' is-playing' : '') + '" aria-label="' + attr((playing ? 'Pause ' : 'Play ') + label) + '" onclick="event.stopPropagation();' + (playing ? 'togglePlayback()' : action) + '">' + icon(playing ? 'pause' : 'play') + '</button>';
}

// Cover, name and a line of facts; the play button rises over the cover on
// hover (always there on touch). Sharing, offline and deleting live in the
// playlist's dialog, not on every card.
function buildPlaylistCard(pl) {
  var items = getPlaylistTracks(pl);
  var badges = playlistBadges(pl);
  return '<article class="pl-card" style="' + playlistAccentVars(pl) + '" role="button" tabindex="0" aria-label="' + attr('Open playlist ' + pl.name) + '" onclick="viewPlaylist(' + jsq(pl.id) + ')">'
    + '<div class="pl-cover">' + buildPlaylistArt(pl, items)
    +   (items.length ? playOverlayHTML(pl.name, isPlaylistPlaying(pl, items), 'playPlaylist(' + jsq(pl.id) + ')') : '')
    + '</div>'
    + '<div class="pl-card-title">' + esc(pl.name) + '</div>'
    + '<div class="pl-card-meta">' + esc(playlistMeta(items)) + '</div>'
    + (badges ? '<div class="pl-badges">' + badges + '</div>' : '')
    + '</article>';
}

function buildSmartMixCard(mix) {
  var items = mix.trackIds.map(getTrackById).filter(Boolean);
  var playing = !!(_currentTrack && _isPlaying && _playQueueLabel === mix.name);
  return '<article class="pl-card is-smart" style="--pl-accent:' + mix.color + '" role="button" tabindex="0" title="' + attr(mix.desc) + '" aria-label="' + attr('Play smart mix ' + mix.name) + '" onclick="playSmartMix(' + jsq(mix.id) + ')">'
    + '<div class="pl-cover">' + buildPlaylistArt(null, items)
    +   '<span class="pl-auto">Auto</span>'
    +   playOverlayHTML(mix.name, playing, 'playSmartMix(' + jsq(mix.id) + ')')
    + '</div>'
    + '<div class="pl-card-title">' + esc(mix.name) + '</div>'
    + '<div class="pl-card-meta">' + esc(playlistMeta(items)) + '</div>'
    + '<button type="button" class="pl-save" onclick="event.stopPropagation();saveSmartMixAsPlaylist(' + jsq(mix.id) + ')">Save as playlist</button>'
    + '</article>';
}

// Play the playlist from a random track with shuffle on.
function playPlaylistShuffled(id) {
  var pl = getPlaylistById(id);
  if (!pl || !pl.trackIds || !pl.trackIds.length) return;
  if (!_shuffleMode) toggleShuffle();
  var ids = pl.trackIds.slice();
  startPlayback(ids[Math.floor(Math.random() * ids.length)], ids, pl.name);
}

function populatePlaylistCheckboxes() {
  var el = document.getElementById('pl-track-checkboxes');
  if (!el) return;
  if (!tracks.length) {
    el.innerHTML = '<div class="empty-state" style="padding:1rem"><strong style="font-size:24px;margin-bottom:.3rem">Nothing to pick yet</strong>Upload or auto-import tracks first.</div>';
    return;
  }
  el.innerHTML = tracks.slice().sort(function(a, b) {
    return compareNewestFirst(a, b);
  }).map(function(track) {
    return '<label class="playlist-picker-item"><input type="checkbox" value="' + esc(track.id) + '" class="pl-track-cb">' + buildCoverArt(track, 'xs', false) + '<div class="playlist-picker-copy"><div class="playlist-picker-title">' + esc(track.title) + '</div><div class="playlist-picker-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + fmtTime(track.duration || 0) + '</div></div></label>';
  }).join('');
}

function addPlaylist() {
  var name = document.getElementById('pl-name').value.trim();
  if (!name) {
    showToast('Playlist needs a name');
    return;
  }
  var tids = [];
  document.querySelectorAll('.pl-track-cb:checked').forEach(function(cb) { tids.push(cb.value); });
  var playlist = {
    id: 'pl-' + Date.now(),
    name: name,
    color: safePlaylistColor(document.getElementById('pl-color').value),
    desc: document.getElementById('pl-desc').value || '',
    trackIds: tids
  };
  playlists.push(playlist);
  persistPlaylists();
  closeModal('modal-playlist');
  document.getElementById('pl-name').value = '';
  document.getElementById('pl-desc').value = '';
  renderPlaylists();
  renderTracks();
  showToast('Playlist created');
}

function deletePlaylist(id) {
  var doomed = getPlaylistById(id);
  var wasShared = !!(doomed && doomed.shared);
  if (!confirm(wasShared ? 'Delete this playlist and revoke its public link?' : 'Delete this playlist?')) return;
  if (wasShared) revokeShare('playlist', id);
  playlists = playlists.filter(function(pl) { return pl.id !== id; });
  if (_editingPlaylistId === id) _editingPlaylistId = '';
  persistPlaylists();
  renderPlaylists();
  renderTracks();
}

function viewPlaylist(id) {
  var pl = getPlaylistById(id);
  if (!pl) return;
  var items = getPlaylistTracks(pl);
  var isPrivatePlaylist = playlists.some(function(item) { return item.id === id; });
  var isEditing = isPrivatePlaylist && _editingPlaylistId === id;
  var plays = items.reduce(function(sum, item) { return sum + Number(item.plays || 0); }, 0);
  var close = "closeModal('modal-playlist-detail')";

  var actions = '';
  if (!isEditing) {
    if (items.length) {
      actions += '<button type="button" class="sec-action primary has-icon" onclick="playPlaylist(' + jsq(pl.id) + ');' + close + '">' + icon('play') + 'Play</button>'
        + '<button type="button" class="sec-action has-icon" onclick="playPlaylistShuffled(' + jsq(pl.id) + ');' + close + '">' + icon('shuffle') + 'Shuffle</button>';
    }
    if (isPrivatePlaylist) {
      var offlineOn = typeof isPlaylistOffline === 'function' && isPlaylistOffline(pl.id);
      actions += (pl.shared
          ? '<button type="button" class="sec-action is-shared" onclick="unsharePlaylist(' + jsq(pl.id) + ')">Revoke link</button>'
          : '<button type="button" class="sec-action" onclick="sharePlaylist(' + jsq(pl.id) + ')">Share</button>')
        + '<div class="card-menu-wrap">'
        +   '<button type="button" class="icon-btn card-menu-btn" id="menubtn-pld" aria-haspopup="menu" aria-expanded="false" aria-label="More for this playlist" onclick="toggleCardMenu(\'pld\', event)">' + icon('more') + '</button>'
        +   '<div class="card-menu drops-down" id="menu-pld" role="menu" aria-label="Playlist actions">'
        +     '<button role="menuitem" onclick="closeAllCardMenus();setPlaylistEditMode(' + jsq(pl.id) + ', true)">Edit details and order</button>'
        +     (items.length > 1 ? '<button role="menuitem" onclick="closeAllCardMenus();shufflePlaylistMix(' + jsq(pl.id) + ')">Shuffle the order</button>' : '')
        +     '<button role="menuitem" onclick="closeAllCardMenus();duplicatePlaylist(' + jsq(pl.id) + ')">Duplicate</button>'
        +     (typeof offlineSupported === 'function' && offlineSupported() && offlineTracksOf(pl).length
                ? (offlineOn
                    ? '<button role="menuitem" onclick="closeAllCardMenus();removePlaylistOffline(' + jsq(pl.id) + ').then(function(){viewPlaylist(' + jsq(pl.id) + ')})">Remove offline copy</button>'
                    : '<button role="menuitem" onclick="closeAllCardMenus();keepPlaylistOffline(' + jsq(pl.id) + ')">Keep offline</button>')
                : '')
        +     '<button role="menuitem" class="is-danger" onclick="closeAllCardMenus();deletePlaylistFromDialog(' + jsq(pl.id) + ')">Delete playlist</button>'
        +   '</div>'
        + '</div>';
    } else {
      actions += '<button type="button" class="sec-action" onclick="openShareLinkModal(' + jsq('Share \u201c' + pl.name + '\u201d') + ', ' + jsq('Send the playlist link for a front-to-back listen.') + ', ' + jsq(buildShareURL('playlist', pl.id)) + ')">Copy share link</button>';
    }
  }

  var offlineLine = !isEditing && isPrivatePlaylist && typeof offlineControlsHTML === 'function'
    && (isPlaylistOffline(pl.id) || (_offlineRun && _offlineRun.playlistId === pl.id)) ? offlineControlsHTML(pl) : '';

  var html = '<div class="pld-head" style="' + playlistAccentVars(pl) + '">'
    + '<div class="pld-art">' + buildPlaylistArt(pl, items) + '</div>'
    + '<div class="pld-info">'
    +   '<div class="pl-eyebrow">' + (isEditing ? 'Editing playlist' : 'Playlist') + '</div>'
    +   '<h2 class="pld-title">' + esc(pl.name) + '</h2>'
    +   (pl.desc && !isEditing ? '<p class="pld-desc">' + esc(pl.desc) + '</p>' : '')
    +   '<div class="pld-meta">' + esc(playlistMeta(items)) + (plays ? ' \u00b7 ' + fmtCompactNumber(plays) + (plays === 1 ? ' play' : ' plays') : '') + playlistBadges(pl) + '</div>'
    +   (actions ? '<div class="pl-actions">' + actions + '</div>' : '')
    +   offlineLine
    + '</div>'
    + '</div>';

  if (isEditing) {
    var current = safePlaylistColor(pl.color).toUpperCase();
    html += '<div class="pld-edit">'
      + '<div class="form-group"><label class="form-label" for="pl-edit-name">Name</label><input class="form-input" type="text" id="pl-edit-name" maxlength="80" value="' + attr(pl.name) + '"></div>'
      + '<div class="form-group"><label class="form-label" for="pl-edit-desc">Description <span class="form-label-note">optional</span></label><textarea class="form-input" id="pl-edit-desc" rows="2">' + esc(pl.desc || '') + '</textarea></div>'
      + '<div class="form-group"><span class="form-label" id="pl-edit-color-label">Colour</span><div class="pl-swatches" role="radiogroup" aria-labelledby="pl-edit-color-label">'
      +   PLAYLIST_COLOR_OPTIONS.map(function(option) {
            return '<label class="pl-swatch" title="' + attr(option.label) + '"><input type="radio" name="pl-edit-color" value="' + attr(option.value) + '"' + (option.value.toUpperCase() === current ? ' checked' : '') + ' aria-label="' + attr(option.label) + '"><span style="--sw:' + option.value + '"></span></label>';
          }).join('')
      + '</div></div>'
      + '<div class="pld-edit-actions"><button type="button" class="sec-action" onclick="setPlaylistEditMode(' + jsq(pl.id) + ', false)">Cancel</button><button type="button" class="sec-action primary" onclick="savePlaylistEdits(' + jsq(pl.id) + ')">Save</button></div>'
      + '</div>';
  }

  if (!items.length) {
    html += '<div class="pl-empty in-dialog">Add tracks from a track\u2019s menu in the library, or with Add to playlist in the player.'
      + '<button type="button" class="sec-action" onclick="' + close + ';switchView(\'library\')">Browse the library</button></div>';
  } else {
    html += (isEditing ? '<div class="pld-hint">Move tracks with the arrows<span class="pld-hint-drag">, or drag them</span>.</div>' : '')
      + '<div class="pld-list">' + items.map(function(track, index) {
        return isEditing ? playlistEditRow(pl, track, index, items.length) : playlistRow(pl, track, index);
      }).join('') + '</div>';
  }

  document.getElementById('pld-body').innerHTML = html;
  openModal('modal-playlist-detail');
}

function playlistRow(pl, track, index) {
  var isCurrent = _currentTrack && _currentTrack.id === track.id;
  return '<div class="pl-row' + (isCurrent ? ' current' : '') + '" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ', number ' + (index + 1)) + '" onclick="playPlaylistTrack(' + jsq(pl.id) + ', ' + jsq(track.id) + ');closeModal(\'modal-playlist-detail\')">'
    + '<span class="pl-row-index" aria-hidden="true">' + (isCurrent ? eqBars() : index + 1) + '</span>'
    + buildCoverArt(track, 'xs', false)
    + '<div class="pl-row-main"><div class="pl-row-title">' + esc(track.title) + '</div><div class="pl-row-sub">' + esc(track.genre || 'Other') + ' \u00b7 ' + esc(track.mood || 'Mood') + '</div></div>'
    + '<span class="pl-row-time">' + fmtTime(track.duration || 0) + '</span>'
    + '</div>';
}

function playlistEditRow(pl, track, index, count) {
  var id = jsq(pl.id);
  return '<div class="pl-row is-editing" draggable="true"'
    + ' ondragstart="onSeqDragStart(event, ' + id + ', ' + index + ')"'
    + ' ondragover="onSeqDragOver(event, ' + id + ', ' + index + ')"'
    + ' ondrop="onSeqDrop(event, ' + id + ', ' + index + ')"'
    + ' ondragend="onSeqDragEnd()">'
    + '<span class="pl-grip" aria-hidden="true" title="Drag to move">' + icon('grip') + '</span>'
    + '<span class="pl-row-index" aria-hidden="true">' + (index + 1) + '</span>'
    + buildCoverArt(track, 'xs', false)
    + '<div class="pl-row-main"><div class="pl-row-title">' + esc(track.title) + '</div><div class="pl-row-sub">' + esc(track.genre || 'Other') + ' \u00b7 ' + fmtTime(track.duration || 0) + '</div></div>'
    + '<div class="pl-row-tools">'
    +   '<button type="button" class="pl-tool" aria-label="' + attr('Move ' + track.title + ' up') + '" onclick="movePlaylistTrack(' + id + ', ' + index + ', -1)"' + (index === 0 ? ' disabled' : '') + '>' + icon('chevron-up') + '</button>'
    +   '<button type="button" class="pl-tool" aria-label="' + attr('Move ' + track.title + ' down') + '" onclick="movePlaylistTrack(' + id + ', ' + index + ', 1)"' + (index === count - 1 ? ' disabled' : '') + '>' + icon('chevron-down') + '</button>'
    +   '<button type="button" class="pl-tool is-danger" aria-label="' + attr('Remove ' + track.title + ' from the playlist') + '" onclick="removePlaylistTrack(' + id + ', ' + jsq(track.id) + ')">' + icon('x') + '</button>'
    + '</div>'
    + '</div>';
}

// The dialog stays open while a playlist downloads, so the menu's "Keep
// offline" re-renders it with the progress line.
function keepPlaylistOffline(id) {
  savePlaylistOffline(id);
  viewPlaylist(id);
}

function deletePlaylistFromDialog(id) {
  deletePlaylist(id);
  if (!getPlaylistById(id)) closeModal('modal-playlist-detail');
}

var _editingPlaylistId = '';
