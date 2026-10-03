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
  var colorInput = document.getElementById('pl-edit-color');
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
  var dragging = document.querySelector('.playlist-edit-item.dragging');
  if (dragging) dragging.classList.remove('dragging');
}

function clearSeqDropMarkers() {
  document.querySelectorAll('.playlist-edit-item.drop-before, .playlist-edit-item.drop-after').forEach(function(el) {
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
  var colorInput = document.getElementById('pl-edit-color');
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
  if (!playlists.length) {
    el.innerHTML = '<div class="section-card"><div class="section-inner"><div class="empty-state"><strong>No playlists yet.</strong>Create your first curated mix to turn the vault into a set of editorial rooms.</div></div></div>';
    return;
  }
  var featured = getFeaturedPlaylist();
  var tracksInFeatured = getPlaylistTracks(featured);
  // The side card used to explain the playlist page to its owner. It now
  // carries the featured mixtape's running order instead.
  var previewTracks = tracksInFeatured.slice(0, 6);
  var remaining = tracksInFeatured.length - previewTracks.length;
  var sideBody = previewTracks.length
    ? '<div class="playlist-track-list" style="margin-top:.9rem">' + previewTracks.map(function(track, index) {
        return '<div class="playlist-track-pill" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ' from ' + (featured.name || 'playlist')) + '" style="cursor:pointer" onclick="playPlaylistTrack(' + jsq(featured.id) + ', ' + jsq(track.id) + ')"><div class="playlist-track-pill-main"><span class="playlist-track-order">' + (index + 1) + '</span><span>' + esc(track.title) + '</span></div><span>' + esc(track.mood || 'Mood') + '</span></div>';
      }).join('') + '</div>'
      + (remaining > 0
          ? '<div class="section-action-row" style="margin-top:.8rem"><button class="sec-action" onclick="viewPlaylist(' + jsq(featured.id) + ')">Open all ' + tracksInFeatured.length + ' tracks</button></div>'
          : '')
    : '<div class="side-copy">This mixtape has no tracks yet. Open it to add some from the vault.</div>';
  el.innerHTML = '<div class="section-card"><div class="section-inner"><div class="playlist-hero-grid"><div class="playlist-hero-main"><div class="section-kicker">Featured mixtape</div><div class="playlist-hero-card">' + buildPlaylistCover(featured, 'sm') + '<div><div class="section-title is-hero">' + esc(featured.name) + '</div><div class="section-sub" style="margin-top:.65rem">' + esc(featured.desc || 'A curated sequence built from your vault.') + '</div><div class="pill-row" style="margin-top:.8rem"><span class="meta-pill highlight">' + tracksInFeatured.length + ' tracks</span><span class="meta-pill">' + fmtTime(getCollectionDuration(tracksInFeatured)) + '</span><span class="meta-pill">' + esc((tracksInFeatured[0] && tracksInFeatured[0].source) || 'Mixed') + '</span></div><div class="section-action-row" style="margin-top:1rem"><button class="sec-action primary" onclick="playPlaylist(' + jsq(featured.id) + ')">Play playlist</button><button class="sec-action" onclick="viewPlaylist(' + jsq(featured.id) + ')">Open details</button><button class="sec-action" onclick="sharePlaylist(' + jsq(featured.id) + ')">Share</button></div></div></div></div><div class="side-card"><div class="side-kicker">Running order</div>' + sideBody + '</div></div></div></div>';
}

// Smart mixes: rule-based playlists computed live from the vault. They aren't
// persisted — they recompute on every render so they stay current as tracks
// are imported and tagged. A mix can be snapshotted into a real playlist.
function getSmartMixes() {
  if (!tracks.length) return [];
  var mixes = [];
  var minSize = tracks.length >= 8 ? 3 : 2;

  function build(id, name, desc, color, predicate) {
    var ids = tracks.filter(predicate).map(function(t) { return t.id; });
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
  grid.innerHTML = mixes.map(function(m) {
    var items = m.trackIds.map(getTrackById).filter(Boolean);
    var dur = getCollectionDuration(items);
    var plays = items.reduce(function(s, t) { return s + Number(t.plays || 0); }, 0);
    return '<div class="smart-mix-card" style="--sm-accent:' + m.color + '">'
      + '<div class="smart-mix-head"><span class="smart-mix-badge">Smart mix</span><span class="smart-mix-count">' + m.trackIds.length + ' tracks</span></div>'
      + '<div class="smart-mix-name">' + esc(m.name) + '</div>'
      + '<div class="smart-mix-desc">' + esc(m.desc) + '</div>'
      + '<div class="pill-row" style="margin-top:.6rem"><span class="meta-pill">' + fmtTime(dur) + '</span><span class="meta-pill">' + fmtCompactNumber(plays) + ' plays</span></div>'
      + '<div class="section-action-row" style="margin-top:.9rem"><button class="sec-action primary" onclick="playSmartMix(' + jsq(m.id) + ')">Play</button><button class="sec-action" onclick="saveSmartMixAsPlaylist(' + jsq(m.id) + ')">Save as playlist</button></div>'
      + '</div>';
  }).join('');
}

function renderPlaylists() {
  renderPlaylistHero();
  renderSmartMixes();
  var el = document.getElementById('playlist-grid');
  if (!el) return;
  if (!playlists.length) {
    el.innerHTML = '<div class="empty-state"><strong>No playlists yet.</strong>Start with a mood, a night drive, or a favorite AI era and build your first mix.</div>';
    return;
  }

  var html = playlists.slice().sort(function(a, b) {
    return playlistTimestamp(b) - playlistTimestamp(a);
  }).map(function(pl) {
    var items = getPlaylistTracks(pl);
    var totalDuration = getCollectionDuration(items);
    return '<div class="playlist-card" style="' + playlistAccentVars(pl) + '" onclick="viewPlaylist(' + jsq(pl.id) + ')"><div class="playlist-card-top">' + buildPlaylistCover(pl, 'sm') + '<div><div class="section-kicker" style="margin-bottom:.35rem;color:var(--pl-accent)">Curated playlist</div><div class="playlist-name">' + esc(pl.name) + '</div><div class="playlist-desc">' + esc(pl.desc || 'An editorial mix from the vault.') + '</div><div class="pill-row" style="margin-top:.7rem"><span class="meta-pill highlight" style="color:var(--pl-accent);border-color:var(--pl-accent-rim);background:var(--pl-accent-soft)">' + items.length + ' tracks</span><span class="meta-pill">' + fmtTime(totalDuration) + '</span><span class="meta-pill">' + fmtCompactNumber(items.reduce(function(sum, item) { return sum + Number(item.plays || 0); }, 0)) + ' plays</span></div></div></div><div class="playlist-track-list">' + (items.slice(0, 3).map(function(track, index) {
      return '<div class="playlist-track-pill"><div class="playlist-track-pill-main"><span class="playlist-track-order">' + (index + 1) + '</span><span>' + esc(track.title) + '</span></div><span>' + esc(track.mood || 'Mood') + '</span></div>';
    }).join('') || '<div class="playlist-track-pill"><span>Empty playlist</span><span>Ready for curation</span></div>') + '</div><div class="section-action-row"><button class="sec-action primary" onclick="event.stopPropagation();playPlaylist(' + jsq(pl.id) + ')">Play</button><button class="sec-action" onclick="event.stopPropagation();viewPlaylist(' + jsq(pl.id) + ')">Open</button>' + (pl.shared ? '<button class="sec-action is-shared" title="This playlist has a live public link" onclick="event.stopPropagation();unsharePlaylist(' + jsq(pl.id) + ')">Unshare</button>' : '<button class="sec-action" onclick="event.stopPropagation();sharePlaylist(' + jsq(pl.id) + ')">Share</button>') + '<button class="sec-action" onclick="event.stopPropagation();deletePlaylist(' + jsq(pl.id) + ')">Delete</button></div></div>';
  }).join('');

  // The card stays clickable for pointers, but the keyboard path is the real
  // button inside it — a focusable card wrapping focusable buttons would be a
  // duplicate tab stop for the same action.
  html += '<div class="playlist-card playlist-card-new" onclick="openModal(\'modal-playlist\')"><div class="section-kicker">New room</div><div class="playlist-name">Create another playlist</div><div class="playlist-desc">Turn a cluster of tracks into a stronger editorial sequence.</div><div class="section-action-row"><button class="sec-action primary" onclick="event.stopPropagation();openModal(\'modal-playlist\')">Start playlist</button></div></div>';
  el.innerHTML = html;
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
  var colorOptions = PLAYLIST_COLOR_OPTIONS;
  var actionRow = '<button class="sec-action primary" onclick="playPlaylist(' + jsq(pl.id) + ');closeModal(\'modal-playlist-detail\')">Play all</button>';
  if (isPrivatePlaylist) {
    actionRow += '<button class="sec-action" onclick="shufflePlaylistMix(' + jsq(pl.id) + ')">Shuffle this mix</button><button class="sec-action" onclick="duplicatePlaylist(' + jsq(pl.id) + ')">Duplicate</button><button class="sec-action" onclick="' + (isEditing ? 'savePlaylistEdits(' + jsq(pl.id) + ')' : 'setPlaylistEditMode(' + jsq(pl.id) + ', true)') + '">' + (isEditing ? 'Save edits' : 'Edit mix') + '</button>' + (pl.shared ? '<button class="sec-action is-shared" onclick="unsharePlaylist(' + jsq(pl.id) + ')">Revoke public link</button>' : '<button class="sec-action" onclick="sharePlaylist(' + jsq(pl.id) + ')">Share playlist</button>');
  } else {
    actionRow += '<button class="sec-action" onclick="openShareLinkModal(' + jsq('Share \"' + pl.name + '\"') + ', ' + jsq('Send the playlist link for a front-to-back listen.') + ', ' + jsq(buildShareURL('playlist', pl.id)) + ')">Copy share link</button>';
  }
  var html = '<div class="playlist-modal-hero" style="' + playlistAccentVars(pl) + '">' + buildPlaylistCover(pl, 'sm') + '<div><div class="section-kicker" style="color:var(--pl-accent)">' + (isEditing ? 'Edit mixtape' : 'Playlist detail') + '</div><div class="modal-title" style="margin-bottom:.55rem;color:var(--pl-accent)">' + esc(pl.name) + '</div><div class="section-sub">' + esc(pl.desc || 'An editorial mix from the vault.') + '</div><div class="pill-row" style="margin-top:.85rem"><span class="meta-pill highlight" style="color:var(--pl-accent);border-color:var(--pl-accent-rim);background:var(--pl-accent-soft)">' + items.length + ' tracks</span><span class="meta-pill">' + fmtTime(getCollectionDuration(items)) + '</span><span class="meta-pill">' + fmtCompactNumber(items.reduce(function(sum, item) { return sum + Number(item.plays || 0); }, 0)) + ' plays</span></div><div class="section-action-row" style="margin-top:1rem">' + actionRow + '</div></div></div>';

  if (isEditing) {
    html += '<div class="playlist-edit-shell"><div class="playlist-edit-card"><div class="form-grid"><div class="form-group"><label class="form-label">Playlist name</label><input class="form-input" type="text" id="pl-edit-name" value="' + attr(pl.name) + '"></div><div class="form-group"><label class="form-label">Accent color</label><select class="form-input" id="pl-edit-color">' + colorOptions.map(function(option) { return '<option value="' + option.value + '"' + ((pl.color || '#F08B62') === option.value ? ' selected' : '') + '>' + option.label + '</option>'; }).join('') + '</select></div></div><div class="form-group" style="margin-top:.8rem"><label class="form-label">Description</label><textarea class="form-input" id="pl-edit-desc" rows="4">' + esc(pl.desc || '') + '</textarea></div><div class="playlist-edit-actions"><button class="sec-action" onclick="setPlaylistEditMode(' + jsq(pl.id) + ', false)">Cancel</button><button class="sec-action primary" onclick="savePlaylistEdits(' + jsq(pl.id) + ')">Save mixtape</button></div></div>';
    if (!items.length) {
      html += '<div class="empty-state"><strong>Empty mix.</strong>Add tracks from the library or expanded player, then arrange the order here.</div>';
    } else {
      html += '<div class="playlist-edit-card"><div class="section-kicker">Sequence editor</div><div class="section-sub" style="margin-bottom:1rem">Drag a row to reorder it, or use Up and Down to move it from the keyboard. This order is used everywhere SonicVault treats this as a mixtape: playlist page, detail modal, and playback queue.</div><div class="playlist-edit-list">';
      items.forEach(function(track, index) {
        html += '<div class="playlist-edit-item" draggable="true"'
          + ' ondragstart="onSeqDragStart(event, ' + jsq(pl.id) + ', ' + index + ')"'
          + ' ondragover="onSeqDragOver(event, ' + jsq(pl.id) + ', ' + index + ')"'
          + ' ondrop="onSeqDrop(event, ' + jsq(pl.id) + ', ' + index + ')"'
          + ' ondragend="onSeqDragEnd()">'
          + '<div class="playlist-drag-handle" aria-hidden="true" title="Drag to reorder">::</div>'
          + '<div class="playlist-edit-index">' + (index + 1) + '</div>' + buildCoverArt(track, 'xs', false) + '<div class="playlist-edit-copy"><div class="playlist-edit-title">' + esc(track.title) + '</div><div class="playlist-edit-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + fmtTime(track.duration || 0) + '</div></div><div class="playlist-seq-actions"><button class="playlist-seq-btn" onclick="movePlaylistTrack(' + jsq(pl.id) + ', ' + index + ', -1)"' + (index === 0 ? ' disabled' : '') + '>Up</button><button class="playlist-seq-btn" onclick="movePlaylistTrack(' + jsq(pl.id) + ', ' + index + ', 1)"' + (index === items.length - 1 ? ' disabled' : '') + '>Down</button><button class="playlist-seq-btn" onclick="removePlaylistTrack(' + jsq(pl.id) + ', ' + jsq(track.id) + ')">Remove</button></div></div>';
      });
      html += '</div></div>';
    }
  } else {
    if (!items.length) {
      html += '<div class="empty-state"><strong>Empty mix.</strong>Add tracks to give this room some shape.</div>';
    } else {
      html += '<div class="playlist-modal-list">';
      items.forEach(function(track, index) {
        html += '<div class="playlist-modal-item" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ', position ' + (index + 1)) + '" onclick="playPlaylistTrack(' + jsq(pl.id) + ', ' + jsq(track.id) + ');closeModal(\'modal-playlist-detail\')"><div class="mini-track-meta" aria-hidden="true">#' + (index + 1) + '</div>' + buildCoverArt(track, 'xs', false) + '<div><div class="playlist-picker-title">' + esc(track.title) + '</div><div class="playlist-picker-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + trimText(getTrackPromptExcerpt(track, 86), 86) + '</div></div><div class="mini-track-meta">' + fmtTime(track.duration || 0) + '</div></div>';
      });
      html += '</div>';
    }
  }

  document.getElementById('pld-body').innerHTML = html;
  openModal('modal-playlist-detail');
}

var _editingPlaylistId = '';
