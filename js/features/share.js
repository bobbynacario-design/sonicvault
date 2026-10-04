// Public sharing: the snapshots published to the world-readable share
// collections, revoking them, and the public track and playlist pages.

function getPlaylistAnchorTrack(pl) {
  var items = getPlaylistTracks(pl);
  return items[0] || {
    title: pl && pl.name || 'Playlist',
    genre: 'Other',
    mood: 'Dreamy',
    source: 'Mix'
  };
}

// What a share page needs to play the lyrics along with a song: the line
// and word timings (not what the transcription heard), and the saved
// translation. null where there is none.
function publicLyricSync(track) {
  var sync = getLyricSync(track);
  if (!sync || sync.source === 'unmatched' || !sync.lines.some(Boolean)) return null;
  return packLyricSync(getTrackLyrics(track), sync.lines, sync.source, sync.at || '', null, sync.words);
}

function publicTranslation(track) {
  var tr = track && track.translation;
  if (!tr || !hasLyrics(track) || tr.key !== lyricSyncKey(getTrackLyrics(track))) return null;
  return {
    key:tr.key,
    lang:String(tr.lang || ''),
    from:String(tr.from || ''),
    same:!!tr.same,
    lines:(tr.lines || []).map(function(line) { return String(line || ''); }),
    about:String(tr.about || ''),
    notes:(tr.notes || []).map(function(item) { return { line:Number(item.line) || 0, note:String(item.note || '') }; }),
    at:String(tr.at || '')
  };
}

// full: the whole sheet with its timings and translation, for a song the
// page plays (the shared song, a shared playlist's songs) rather than one
// it only links to.
function makeTrackSnapshot(track, full) {
  if (!track) return null;
  var snapshot = {
    id: track.id,
    title: track.title || 'Untitled release',
    genre: track.genre || 'Other',
    mood: track.mood || 'Dreamy',
    source: track.source || 'Suno',
    prompt: track.prompt || '',
    duration: Number(track.duration || 0),
    audioURL: track.audioURL || '',
    coverStyle: getCoverStyle(track),
    loudness: getRealPeaksForTrack(track),
    plays: Number(track.plays || 0),
    created: track.created || '',
    shared: !!track.shared,
    aiGenre: track.aiGenre || '',
    aiMood: track.aiMood || '',
    aiSummary: getTrackSummary(track),
    aiTags: getTrackAITags(track),
    aiTheme: getTrackAITheme(track),
    aiEnergy: track.aiEnergy || '',
    aiEra: track.aiEra || '',
    lyricsExcerpt: trimLyricsPreview(getTrackLyrics(track), 900),
    hasLyrics: hasLyrics(track)
  };
  if (full) {
    snapshot.lyrics = getTrackLyrics(track);
    snapshot.lyricSync = publicLyricSync(track);
    snapshot.translation = publicTranslation(track);
  }
  return snapshot;
}

function makePlaylistSnapshot(pl, limit) {
  if (!pl) return null;
  var items = getPlaylistTracks(pl).slice(0, limit || 4).map(function(item) { return makeTrackSnapshot(item); }).filter(Boolean);
  return {
    id: pl.id,
    name: pl.name || 'Untitled playlist',
    desc: pl.desc || '',
    color: pl.color || '#F08B62',
    shared: !!pl.shared,
    trackIds: (pl.trackIds || items.map(function(item) { return item.id; })).slice(),
    tracks: items
  };
}

function buildTrackSharePayload(track) {
  var related = getSimilarTracks(track, 8).filter(function(item) {
    return !!item.shared;
  }).slice(0, 4).map(function(item) { return makeTrackSnapshot(item); }).filter(Boolean);
  var contextPlaylists = playlists.filter(function(pl) {
    return !!pl.shared && (pl.trackIds || []).indexOf(track.id) !== -1;
  }).slice(0, 4).map(function(pl) {
    return makePlaylistSnapshot(pl, 4);
  }).filter(Boolean);
  return Object.assign(makeTrackSnapshot(track, true), {
    kind: 'track',
    related: related,
    playlists: contextPlaylists,
    sharedAt: new Date().toISOString()
  });
}

function buildPlaylistSharePayload(pl) {
  var items = getPlaylistTracks(pl).map(function(track) { return makeTrackSnapshot(track, true); }).filter(Boolean);
  return {
    kind: 'playlist',
    id: pl.id,
    name: pl.name || 'Untitled playlist',
    desc: pl.desc || '',
    color: pl.color || '#F08B62',
    shared: !!pl.shared,
    trackIds: (pl.trackIds || items.map(function(item) { return item.id; })).slice(),
    tracks: items,
    related: getPlaylistRelatedTracks(pl, 8).filter(function(item) {
      return !!item.shared;
    }).slice(0, 4).map(function(item) { return makeTrackSnapshot(item); }).filter(Boolean),
    totalDuration: getCollectionDuration(items),
    sharedAt: new Date().toISOString()
  };
}

function shareCurrentTrack() {
  if (!_currentTrack) return;
  shareTrack(_currentTrack.id);
}

function syncSharedPlaylist(pl) {
  if (!pl || !pl.shared || !window.fbPublishShare) return;
  window.fbPublishShare('playlist', pl.id, buildPlaylistSharePayload(pl)).catch(function(err) {
    console.error('Playlist share sync failed:', err);
  });
}

// What is being shared, for the text the platforms put next to the link:
// the title without the dialog's "Share “...”" wrapping.
var _shareSubject = '';

function openShareLinkModal(title, subtitle, url) {
  document.getElementById('share-title').textContent = title;
  document.getElementById('share-subtitle').textContent = subtitle;
  document.getElementById('share-link').value = url;
  _shareSubject = String(title || '').replace(/^Share\s+/, '').replace(/^["\u201c]|["\u201d]$/g, '');
  var native = document.getElementById('share-native-btn');
  if (native) native.hidden = !navigator.share;
  openModal('modal-share');
}

// What a shared page shows of a lyric sheet: the opening lines, cut at a line
// break, with line breaks kept. (Shares published before this carry a
// one-line excerpt; renderPublicTrackPage reads those from the song file.)
function trimLyricsPreview(lyrics, max) {
  var text = String(lyrics || '').replace(/\r\n?/g, '\n').trim();
  var limit = max || 900;
  if (text.length <= limit) return text;
  var cut = text.lastIndexOf('\n', limit);
  return text.slice(0, cut > limit * .5 ? cut : limit).replace(/\s+$/, '') + '\n…';
}

function publicLyricsHTML(text) {
  var value = String(text || '').trim();
  if (!value) return '';
  if (value.indexOf('\n') === -1) return '<p class="public-lyrics-text">' + esc(value) + '</p>';
  return parseLyricSheet(value).map(function(row) {
    if (row.kind === 'gap') return '<div class="lyric-gap"></div>';
    if (row.kind === 'header') return '<div class="lyric-section-header">' + esc(row.text) + '</div>';
    return '<div class="lyric-line">' + esc(row.text) + '</div>';
  }).join('');
}

// Visitors cannot open a private vault, so the way back into the app is
// offered only to the signed-in owner.
// ── Live lyrics on a share page ──────────────────────────────────────
// A shared song with timed lyrics shows its whole sheet, lighting the line
// being sung while it plays -- the translation under each line when the
// owner saved one (shown at first; a song in another language is the
// reason to share one) -- and opens karaoke ("Sing along"). Tapping a line
// plays from there.

var _publicLyricIdx = -1;
var _publicTranslationShown = {};   // track id -> true once shown by default

function publicSyncedLyrics(track) {
  return !!(track && hasLyrics(track) && hasUsableLyricTimes(track));
}

function publicSyncedLyricsHTML(track) {
  var translations = shownTranslationLines(track);
  return parseLyricSheet(getTrackLyrics(track)).map(function(row) {
    if (row.kind === 'gap') return '<div class="lyric-gap"></div>';
    if (row.kind === 'header') return '<div class="lyric-section-header">' + esc(row.text) + '</div>';
    var tr = translations && translations[row.index];
    return '<div class="lyric-line" role="button" tabindex="0" data-line="' + row.index + '" onclick="playSharedLyric(' + jsq(track.id) + ', ' + row.index + ')">'
      + esc(row.text) + (tr ? '<span class="lyric-tr">' + esc(tr) + '</span>' : '') + '</div>';
  }).join('');
}

function sharedQueueFor(track) {
  var related = Array.isArray(track.related) ? track.related : [];
  return [track.id].concat(related.map(function(item) { return item.id; }));
}

// Plays the shared song from a line: straight there when it is already
// the song playing, else once the new song knows its length.
function playSharedLyric(id, index) {
  var seek = function() {
    var times = getCurrentLyricTimes();
    if (times && times[index]) _audio.currentTime = Math.max(0, times[index][0] - .2);
    updatePublicLyricHighlight(true);
  };
  if (_currentTrack && _currentTrack.id === id) {
    seek();
    if (_audio.paused) togglePlayback();
    return;
  }
  var track = getTrackById(id);
  if (!track) return;
  var once = function() { _audio.removeEventListener('loadedmetadata', once); seek(); };
  _audio.addEventListener('loadedmetadata', once);
  startPlayback(id, sharedQueueFor(_publicRoutePayload && _publicRoutePayload.id === id ? _publicRoutePayload : track), 'Shared track');
}

function singAlongShared(id) {
  if (!_currentTrack || _currentTrack.id !== id) {
    var track = getTrackById(id);
    if (!track) return;
    startPlayback(id, sharedQueueFor(_publicRoutePayload && _publicRoutePayload.id === id ? _publicRoutePayload : track), 'Shared track');
  } else if (_audio.paused) {
    togglePlayback();
  }
  openKaraoke();
}

function toggleSharedTranslation(id) {
  _translateOpen = _translateOpen === id ? '' : id;
  _publicTranslationShown[id] = true;
  renderRouteAwareView(true);
  if (_currentTrack && typeof updateExpandedPlayer === 'function') updateExpandedPlayer();
}

// The line being sung, lit within the lyric box (never scrolling the page).
function updatePublicLyricHighlight(force) {
  var box = document.getElementById('public-lyrics');
  if (!box) return;
  var playingThis = _currentTrack && box.getAttribute('data-track') === _currentTrack.id;
  var lines = box.querySelectorAll('.lyric-line');
  var times = playingThis ? getCurrentLyricTimes() : null;
  var idx = times && times.length === lines.length ? currentLyricIndex(times, _audio.currentTime || 0) : -1;
  if (idx === _publicLyricIdx && !force) return;
  _publicLyricIdx = idx;
  for (var i = 0; i < lines.length; i++) {
    lines[i].classList.toggle('lyric-current', i === idx);
    lines[i].classList.toggle('lyric-past', idx >= 0 && i < idx);
  }
  if (idx >= 0) box.scrollTop = lines[idx].offsetTop - box.clientHeight / 2 + lines[idx].offsetHeight / 2;
}

_audio.addEventListener('timeupdate', function() { updatePublicLyricHighlight(false); });
_audio.addEventListener('seeked', function() { updatePublicLyricHighlight(true); });

function publicLyricsSection(track, lyrics) {
  if (!publicSyncedLyrics(track)) {
    return lyrics ? '<section class="public-section"><h2 class="public-section-title">Lyrics</h2><div class="public-lyrics">' + publicLyricsHTML(lyrics) + '</div></section>' : '';
  }
  var tr = getTranslation(track);
  var hasLines = !!(tr && !tr.same && tr.lines && tr.lines.length);
  if (hasLines && !_publicTranslationShown[track.id]) {
    _publicTranslationShown[track.id] = true;
    _translateOpen = track.id;
  }
  var shown = hasLines && _translateOpen === track.id;
  return '<section class="public-section">'
    + '<div class="public-section-head"><h2 class="public-section-title">Lyrics</h2><div class="public-lyric-tools">'
    +   (hasLines ? '<button class="sec-action" aria-pressed="' + shown + '" onclick="toggleSharedTranslation(' + jsq(track.id) + ')">' + (shown ? 'Hide ' : 'Show ') + esc(tr.lang || 'translation') + '</button>' : '')
    +   '<button class="sec-action primary has-icon" onclick="singAlongShared(' + jsq(track.id) + ')">' + icon('play') + 'Sing along</button>'
    + '</div></div>'
    + (shown && tr.about ? '<p class="public-lyrics-about">' + esc(tr.about) + '</p>' : '')
    + '<div class="public-lyrics synced" id="public-lyrics" data-track="' + attr(track.id) + '">' + publicSyncedLyricsHTML(track) + '</div>'
    + '<p class="public-lyrics-hint">The lyrics follow the song as it plays. Tap a line to play from there.</p>'
    + '</section>';
}

function publicOwnerAction(view) {
  return window.fbOwnerUser ? '<button class="sec-action" onclick="navigateToApp(' + jsq(view) + ')">Open vault</button>' : '';
}

function publicPlayButton(label, onclick) {
  return '<button class="sec-action primary has-icon" onclick="' + onclick + '">' + icon(/pause/i.test(label) ? 'pause' : 'play') + esc(label) + '</button>';
}

function publicRelatedCards(list) {
  return list.map(function(item) {
    return '<div class="related-card" role="button" tabindex="0" aria-label="' + attr('Open shared track ' + (item.title || 'track')) + '" onclick="openSharedRoute(\'track\', ' + jsq(item.id) + ')">' + buildCoverArt(item, 'md', false) + '<div><div class="related-title">' + esc(item.title) + '</div><div class="related-sub">' + esc(item.genre || 'Other') + ' &middot; ' + esc(item.mood || 'Mood') + '</div></div></div>';
  }).join('');
}

function renderPublicTrackPage(track) {
  var el = document.getElementById('public-page');
  if (!el) return;
  if (_publicRouteLoading && !track) {
    el.innerHTML = '<div class="public-shell" aria-busy="true" aria-label="Loading shared track"><div class="public-hero"><div class="skel skel-cover"></div><div><div class="skel skel-line short"></div><div class="skel skel-title"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div></div></div>';
    updatePageChrome('Loading track | SonicVault', null);
    return;
  }
  if (!track) {
    el.innerHTML = '<div class="public-shell"><div class="empty-state public-missing"><strong>This track isn’t shared anymore</strong>The link may have been turned off by its owner.</div></div>';
    updatePageChrome('Track not found | SonicVault', null);
    return;
  }

  var related = Array.isArray(track.related) ? track.related : getSimilarTracks(track, 4);
  var queueIds = [track.id].concat(related.map(function(item) { return item.id; }));
  var collections = Array.isArray(track.playlists) ? track.playlists : playlists.filter(function(pl) {
    return (pl.trackIds || []).indexOf(track.id) !== -1;
  }).slice(0, 4);
  var playLabel = _currentTrack && _currentTrack.id === track.id && _isPlaying ? 'Pause' : 'Play';
  var summary = getTrackSummary(track);
  var tags = sanitizeMetadataArray(track.aiTags || getTrackAITags(track), 6);
  var lyrics = String(track.lyrics || track.lyricsExcerpt || trimLyricsPreview(getTrackLyrics(track), 900) || '').trim();
  // Records shared before 2026-10-04 kept their excerpt as one long line.
  // The song file's own sheet, once read, gives the lines back; until then
  // the sections at least.
  if (isFlattenedLyrics(lyrics)) {
    lyrics = getFileLyrics(track.id) ? trimLyricsPreview(getFileLyrics(track.id), 900) : unflattenLyrics(lyrics);
  }
  var palette = getCoverPalette(track);
  var plays = Number(track.plays || 0);
  var facts = [track.genre || track.aiGenre || 'Other', track.mood || track.aiMood || 'Mood', fmtTime(track.duration || 0)];
  if (plays) facts.push(fmtCompactNumber(plays) + (plays === 1 ? ' play' : ' plays'));

  el.innerHTML = ''
    + '<div class="public-shell">'
    +   '<section class="public-hero" style="--hero-a:' + palette.a + ';--hero-b:' + palette.b + '">'
    +     '<div class="public-cover">' + buildCoverArt(track, 'lg', true) + '</div>'
    +     '<div class="public-info">'
    +       '<div class="public-eyebrow">Shared from SonicVault</div>'
    +       '<h1 class="public-title">' + esc(track.title) + '</h1>'
    +       '<div class="public-facts">' + facts.map(esc).join(' &middot; ') + '</div>'
    +       ((summary || track.prompt) ? '<p class="public-sub">' + esc(summary || getTrackPromptExcerpt(track, 260)) + '</p>' : '')
    +       (tags.length ? '<div class="public-tags">' + tags.map(esc).join(' &middot; ') + '</div>' : '')
    +       '<div class="public-actions">'
    +         publicPlayButton(playLabel, 'startPlayback(' + jsq(track.id) + ', ' + jsv(queueIds) + ', ' + jsq('Shared track') + ')')
    +         '<button class="sec-action" onclick="openShareLinkModal(' + jsq('Share “' + track.title + '”') + ', ' + jsq('Anyone with the link can listen to this track.') + ', ' + jsq(buildShareURL('track', track.id)) + ')">Copy link</button>'
    +         publicOwnerAction('library')
    +       '</div>'
    +     '</div>'
    +   '</section>'
    +   publicLyricsSection(track, lyrics)
    +   (related.length ? '<section class="public-section"><h2 class="public-section-title">More like this</h2><div class="public-related-grid">' + publicRelatedCards(related) + '</div></section>' : '')
    +   (collections.length ? '<section class="public-section"><h2 class="public-section-title">In playlists</h2><div class="public-link-list">' + collections.map(function(pl) {
          var items = getPlaylistTracks(pl);
          return '<div class="public-link-row" role="button" tabindex="0" aria-label="' + attr('Open shared playlist ' + (pl.name || 'playlist')) + '" onclick="openSharedRoute(\'playlist\', ' + jsq(pl.id) + ')">' + buildPlaylistCover(pl, 'xs') + '<div class="public-link-main"><div class="public-link-title">' + esc(pl.name) + '</div><div class="public-link-sub">' + esc(pl.desc || (items.length + ' tracks')) + '</div></div></div>';
        }).join('') + '</div></section>' : '')
    + '</div>';

  updatePageChrome(track.title + ' | SonicVault', track);
  _publicLyricIdx = -2;
  updatePublicLyricHighlight(true);
}

function renderPublicPlaylistPage(pl) {
  var el = document.getElementById('public-page');
  if (!el) return;
  if (_publicRouteLoading && !pl) {
    el.innerHTML = '<div class="public-shell" aria-busy="true" aria-label="Loading shared playlist"><div class="public-hero"><div class="skel skel-cover"></div><div><div class="skel skel-line short"></div><div class="skel skel-title"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div></div></div>';
    updatePageChrome('Loading playlist | SonicVault', null);
    return;
  }
  if (!pl) {
    el.innerHTML = '<div class="public-shell"><div class="empty-state public-missing"><strong>This playlist isn’t shared anymore</strong>The link may have been turned off by its owner.</div></div>';
    updatePageChrome('Playlist not found | SonicVault', null);
    return;
  }

  var items = getPlaylistTracks(pl);
  var anchor = getPlaylistAnchorTrack(pl);
  var related = Array.isArray(pl.related) ? pl.related : getPlaylistRelatedTracks(pl, 4);
  var playing = items.length && _currentTrack && (pl.trackIds || []).indexOf(_currentTrack.id) !== -1 && _isPlaying;
  var palette = getCoverPalette(anchor);
  var plays = items.reduce(function(sum, item) { return sum + Number(item.plays || 0); }, 0);
  var facts = [items.length + (items.length === 1 ? ' track' : ' tracks'), fmtTime(Number(pl.totalDuration) || getCollectionDuration(items))];
  if (plays) facts.push(fmtCompactNumber(plays) + ' plays');

  el.innerHTML = ''
    + '<div class="public-shell">'
    +   '<section class="public-hero" style="--hero-a:' + palette.a + ';--hero-b:' + palette.b + '">'
    +     '<div class="public-cover">' + buildPlaylistCover(pl, 'md') + '</div>'
    +     '<div class="public-info">'
    +       '<div class="public-eyebrow">Shared playlist from SonicVault</div>'
    +       '<h1 class="public-title">' + esc(pl.name) + '</h1>'
    +       '<div class="public-facts">' + facts.map(esc).join(' &middot; ') + '</div>'
    +       (pl.desc ? '<p class="public-sub">' + esc(pl.desc) + '</p>' : '')
    +       '<div class="public-actions">'
    +         publicPlayButton(playing ? 'Pause' : 'Play', 'playPlaylist(' + jsq(pl.id) + ')')
    +         '<button class="sec-action" onclick="openShareLinkModal(' + jsq('Share “' + pl.name + '”') + ', ' + jsq('Anyone with the link can listen to this playlist.') + ', ' + jsq(buildShareURL('playlist', pl.id)) + ')">Copy link</button>'
    +         publicOwnerAction('playlists')
    +       '</div>'
    +     '</div>'
    +   '</section>'
    +   (items.length ? '<section class="public-section"><h2 class="public-section-title">Tracks</h2><div class="public-track-list">' + items.map(function(track, index) {
          var current = _currentTrack && _currentTrack.id === track.id;
          return '<div class="public-track-row' + (current ? ' current' : '') + '" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ', track ' + (index + 1) + ' of ' + items.length) + '" onclick="playPlaylistTrack(' + jsq(pl.id) + ', ' + jsq(track.id) + ')"><div class="public-track-index" aria-hidden="true">' + (current ? eqBars() : (index + 1)) + '</div>' + buildCoverArt(track, 'xs', false) + '<div class="public-track-main"><div class="public-track-name">' + esc(track.title) + '</div><div class="public-track-sub">' + esc(track.genre || 'Other') + ' &middot; ' + esc(track.mood || 'Mood') + '</div></div><div class="public-track-time">' + fmtTime(track.duration || 0) + '</div></div>';
        }).join('') + '</div></section>' : '<div class="empty-state public-missing"><strong>Nothing here yet</strong>This playlist doesn’t have any tracks.</div>')
    +   (related.length ? '<section class="public-section"><h2 class="public-section-title">More like this</h2><div class="public-related-grid">' + publicRelatedCards(related) + '</div></section>' : '')
    + '</div>';

  updatePageChrome(pl.name + ' | SonicVault', anchor);
}

// ── Keeping a shared song's page current ──────────────────────────────
// A song is published when it is shared. A later change that shows on its
// page -- the lyrics, their timings or translation, the description, the
// cover -- republishes it a few seconds after the change settles. Plays
// don't count. What was last published is remembered per song
// (localStorage.sv_share_sigs), so each change goes out once.
var _shareRefreshTimer = null;

function trackShareSignature(track) {
  var sync = publicLyricSync(track);
  var tr = publicTranslation(track);
  return hashString([
    track.title, track.genre, track.mood, track.audioURL, getCoverStyle(track), getTrackSummary(track),
    getTrackAITags(track).join(','), getTrackLyrics(track),
    sync ? sync.key + sync.at + sync.source + (sync.words ? sync.words.length : 0) : '',
    tr ? tr.lang + tr.at : '', getRealPeaksForTrack(track).length
  ].join('|'));
}

function loadShareSignatures() {
  try { return JSON.parse(localStorage.getItem('sv_share_sigs') || '{}') || {}; } catch (e) { return {}; }
}

function rememberShareSignature(track) {
  var sigs = loadShareSignatures();
  sigs[track.id] = trackShareSignature(track);
  try { localStorage.setItem('sv_share_sigs', JSON.stringify(sigs)); } catch (e) {}
}

function scheduleShareRefresh() {
  clearTimeout(_shareRefreshTimer);
  _shareRefreshTimer = setTimeout(refreshSharedTracks, 4000);
}

function refreshSharedTracks() {
  // Only the signed-in owner can write a share, and only once synced.
  if (!window.fbOwnerUser || !window.fbPublishShare || !window.svVaultSettingsLoaded) return;
  var sigs = loadShareSignatures();
  tracks.filter(function(track) { return track && track.shared; }).forEach(function(track) {
    if (sigs[track.id] === trackShareSignature(track)) return;
    window.fbPublishShare('track', track.id, buildTrackSharePayload(track)).then(function() {
      rememberShareSignature(track);
    }).catch(function(e) { console.warn('Share refresh failed for', track.id, e); });
  });
}

async function shareTrack(id) {
  var track = getTrackById(id);
  if (!track) return;
  track.shared = true;
  persistTracks();
  // Publishing is a network round trip; say something happened at once.
  showToast('Creating share link\u2026');
  try {
    if (window.fbPublishShare) await window.fbPublishShare('track', track.id, buildTrackSharePayload(track));
    rememberShareSignature(track);
    openShareLinkModal('Share "' + track.title + '"', 'Anyone with the link can jump straight into this track.', buildShareURL('track', track.id));
  } catch (e) {
    console.error('Track share publish failed:', e);
    showToast('Could not publish track share');
  }
}

// ── Revoking shares ────────────────────────────────────────────────────
// Deleting the public doc is the part that actually takes the link down.
// Both the explicit Unshare buttons and the delete paths route through here
// so a removed track can never leave a live public page behind.
async function revokeShare(kind, id) {
  if (!window.fbUnpublishShare) return false;
  try {
    await window.fbUnpublishShare(kind, id);
    return true;
  } catch (e) {
    console.error('Share revoke failed:', e);
    return false;
  }
}

async function unshareTrack(id) {
  var track = getTrackById(id);
  if (!track) return;
  if (!confirm('Revoke the public link for "' + track.title + '"? Anyone holding the link will stop being able to open it.')) return;
  track.shared = false;
  persistTracks();
  renderTracks();
  var ok = await revokeShare('track', id);
  showToast(ok ? 'Public link revoked' : 'Marked private, but the public page could not be deleted');
}

async function unsharePlaylist(id) {
  var pl = getPlaylistById(id);
  if (!pl) return;
  if (!confirm('Revoke the public link for "' + pl.name + '"?')) return;
  pl.shared = false;
  persistPlaylists();
  renderPlaylists();
  var ok = await revokeShare('playlist', id);
  showToast(ok ? 'Public link revoked' : 'Marked private, but the public page could not be deleted');
}

function copyShareLink() {
  var input = document.getElementById('share-link');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(input.value);
  } else {
    input.select();
    document.execCommand('copy');
  }
  var btn = document.getElementById('share-copy-btn');
  btn.textContent = 'Copied';
  setTimeout(function() { btn.textContent = 'Copy'; }, 1800);
  showToast('Link copied');
}

function shareExternal(platform) {
  var url = document.getElementById('share-link').value;
  var subject = _shareSubject || 'this';
  var text = 'Listen to \u201c' + subject + '\u201d on SonicVault';
  if (platform === 'native' && navigator.share) {
    // Dismissing the sheet rejects with AbortError; that is not a failure.
    navigator.share({ title:subject, text:text, url:url }).catch(function(e) {
      if (!e || e.name !== 'AbortError') showToast('Couldn\u2019t open the share menu');
    });
    return;
  }
  // Facebook takes only the link; the preview card comes from the page.
  if (platform === 'facebook') window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url), '_blank', 'noopener,width=640,height=560');
  if (platform === 'twitter') window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank', 'noopener');
  if (platform === 'whatsapp') window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url), '_blank', 'noopener');
  if (platform === 'email') window.open('mailto:?subject=' + encodeURIComponent(subject + ' on SonicVault') + '&body=' + encodeURIComponent(text + '\n\n' + url));
}

async function sharePlaylist(id) {
  var pl = getPlaylistById(id);
  if (!pl) return;
  closeModal('modal-playlist-detail');
  pl.shared = true;
  persistPlaylists();
  try {
    if (window.fbPublishShare) await window.fbPublishShare('playlist', pl.id, buildPlaylistSharePayload(pl));
    openShareLinkModal('Share "' + pl.name + '"', 'Send the playlist link for a front-to-back listen.', buildShareURL('playlist', pl.id));
  } catch (e) {
    console.error('Playlist share publish failed:', e);
    showToast('Could not publish playlist share');
  }
}
