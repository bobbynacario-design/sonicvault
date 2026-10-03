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

function makeTrackSnapshot(track) {
  if (!track) return null;
  return {
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
}

function makePlaylistSnapshot(pl, limit) {
  if (!pl) return null;
  var items = getPlaylistTracks(pl).slice(0, limit || 4).map(makeTrackSnapshot).filter(Boolean);
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
  }).slice(0, 4).map(makeTrackSnapshot).filter(Boolean);
  var contextPlaylists = playlists.filter(function(pl) {
    return !!pl.shared && (pl.trackIds || []).indexOf(track.id) !== -1;
  }).slice(0, 4).map(function(pl) {
    return makePlaylistSnapshot(pl, 4);
  }).filter(Boolean);
  return Object.assign(makeTrackSnapshot(track), {
    kind: 'track',
    related: related,
    playlists: contextPlaylists,
    sharedAt: new Date().toISOString()
  });
}

function buildPlaylistSharePayload(pl) {
  var items = getPlaylistTracks(pl).map(makeTrackSnapshot).filter(Boolean);
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
    }).slice(0, 4).map(makeTrackSnapshot).filter(Boolean),
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

function openShareLinkModal(title, subtitle, url) {
  document.getElementById('share-title').textContent = title;
  document.getElementById('share-subtitle').textContent = subtitle;
  document.getElementById('share-link').value = url;
  openModal('modal-share');
}

// What a shared page shows of a lyric sheet: the opening lines, cut at a line
// break, with line breaks kept. (Shares published before this carry a
// one-line excerpt; publicLyricsHTML still renders those as a paragraph.)
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
  var lyrics = String(track.lyricsExcerpt || trimLyricsPreview(getTrackLyrics(track), 900) || '').trim();
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
    +   (lyrics ? '<section class="public-section"><h2 class="public-section-title">Lyrics</h2><div class="public-lyrics">' + publicLyricsHTML(lyrics) + '</div></section>' : '')
    +   (related.length ? '<section class="public-section"><h2 class="public-section-title">More like this</h2><div class="public-related-grid">' + publicRelatedCards(related) + '</div></section>' : '')
    +   (collections.length ? '<section class="public-section"><h2 class="public-section-title">In playlists</h2><div class="public-link-list">' + collections.map(function(pl) {
          var items = getPlaylistTracks(pl);
          return '<div class="public-link-row" role="button" tabindex="0" aria-label="' + attr('Open shared playlist ' + (pl.name || 'playlist')) + '" onclick="openSharedRoute(\'playlist\', ' + jsq(pl.id) + ')">' + buildPlaylistCover(pl, 'xs') + '<div class="public-link-main"><div class="public-link-title">' + esc(pl.name) + '</div><div class="public-link-sub">' + esc(pl.desc || (items.length + ' tracks')) + '</div></div></div>';
        }).join('') + '</div></section>' : '')
    + '</div>';

  updatePageChrome(track.title + ' | SonicVault', track);
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

async function shareTrack(id) {
  var track = getTrackById(id);
  if (!track) return;
  track.shared = true;
  persistTracks();
  try {
    if (window.fbPublishShare) await window.fbPublishShare('track', track.id, buildTrackSharePayload(track));
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
  var text = 'Listen to this SonicVault selection:';
  if (platform === 'twitter') window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url));
  if (platform === 'whatsapp') window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url));
  if (platform === 'email') window.open('mailto:?subject=' + encodeURIComponent('SonicVault share') + '&body=' + encodeURIComponent(text + '\n\n' + url));
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
