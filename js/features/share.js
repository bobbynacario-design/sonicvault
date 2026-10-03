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
    peaks: getRealPeaksForTrack(track),
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
    lyricsExcerpt: getLyricsExcerpt(track, 900),
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

function renderPublicTrackPage(track) {
  var el = document.getElementById('public-page');
  if (!el) return;
  if (_publicRouteLoading && !track) {
    el.innerHTML = '<div class="public-shell" aria-busy="true" aria-label="Loading shared track"><div class="public-list-card"><div class="skel skel-cover" style="max-width:220px"></div><div class="skel skel-title"></div><div class="skel skel-title short"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div><div class="skel skel-row" style="margin-top:1.2rem"></div><div class="skel skel-row"></div></div></div>';
    updatePageChrome('Loading track | SonicVault', null);
    return;
  }
  if (!track) {
    el.innerHTML = '<div class="public-shell"><div class="public-list-card"><div class="public-empty"><strong>Track not found</strong>This share link does not point to a track that exists in the current SonicVault library.<div class="modal-actions" style="justify-content:center;margin-top:1rem"><button class="sec-action primary" onclick="navigateToApp(\'library\')">Open SonicVault</button></div></div></div></div>';
    updatePageChrome('Track not found | SonicVault', null);
    return;
  }

  var related = Array.isArray(track.related) ? track.related : getSimilarTracks(track, 4);
  var queueIds = [track.id].concat(related.map(function(item) { return item.id; }));
  var collections = Array.isArray(track.playlists) ? track.playlists : playlists.filter(function(pl) {
    return (pl.trackIds || []).indexOf(track.id) !== -1;
  }).slice(0, 4);
  var playLabel = _currentTrack && _currentTrack.id === track.id && _isPlaying ? 'Pause track' : 'Play track';
  var summary = getTrackSummary(track);
  var tags = sanitizeMetadataArray(track.aiTags || getTrackAITags(track), 8);
  var lyricsExcerpt = String(track.lyricsExcerpt || getLyricsExcerpt(track, 900) || '').trim();

  el.innerHTML = ''
    + '<div class="public-shell">'
    +   '<div class="public-hero"><div class="public-grid">'
    +     '<div class="public-cover-card">' + buildCoverArt(track, 'lg', true) + '</div>'
    +     '<div class="public-info-card"><div class="public-kicker">Shared track / SonicVault</div><div class="public-title">' + esc(track.title) + '</div><div class="public-sub">' + esc(summary || getTrackPromptExcerpt(track, 260)) + '</div><div class="public-pill-strip"><span class="meta-pill highlight">' + esc(track.genre || track.aiGenre || 'Other') + '</span><span class="meta-pill">' + esc(track.mood || track.aiMood || 'Mood') + '</span><span class="meta-pill">' + esc(track.source || 'Suno') + '</span><span class="meta-pill">' + fmtTime(track.duration || 0) + '</span></div>' + (tags.length ? '<div class="ai-chip-row" style="margin-top:.9rem">' + tags.map(function(tag) { return '<span class="ai-chip">' + esc(tag) + '</span>'; }).join('') + '</div>' : '') + '<div class="section-action-row"><button class="sec-action primary" onclick="startPlayback(' + jsq(track.id) + ', ' + jsv(queueIds) + ', ' + jsq('Shared track') + ')">' + playLabel + '</button><button class="sec-action" onclick="openShareLinkModal(' + jsq('Share \"' + track.title + '\"') + ', ' + jsq('Anyone with the link can jump straight into this track.') + ', ' + jsq(buildShareURL('track', track.id)) + ')">Copy share link</button><button class="sec-action" onclick="navigateToApp(\'library\')">Open vault</button></div><div class="public-meta-grid"><div class="public-meta-card"><div class="public-meta-label">Plays</div><div class="public-meta-value">' + fmtCompactNumber(track.plays || 0) + '</div><div class="public-meta-copy">Total listens on this release.</div></div><div class="public-meta-card"><div class="public-meta-label">Published</div><div class="public-meta-value">' + esc(track.created || 'Undated') + '</div><div class="public-meta-copy">Saved into SonicVault.</div></div><div class="public-meta-card"><div class="public-meta-label">Theme</div><div class="public-meta-value">' + esc(getTrackAITheme(track) || 'Curated') + '</div><div class="public-meta-copy">A concise read on the track mood and subject.</div></div></div></div>'
    +   '</div></div>'
    +   '<div class="public-context-grid">'
    +     '<div class="public-list-card"><div class="public-list-head"><div><div class="public-kicker">Editorial read</div><div class="public-list-title">Lyrics and summary</div><div class="public-list-copy">Shared pages keep the listening context intact without exposing your whole private metadata footprint.</div></div></div>' + (summary ? '<div class="player-ai-summary" style="margin-bottom:1rem">' + esc(summary) + '</div>' : '') + '<div class="player-copy-card" style="background:rgba(255,255,255,.02)"><div class="player-copy-kicker">Lyrics excerpt</div><div class="player-lyrics' + (lyricsExcerpt ? '' : ' empty') + '" style="max-height:220px">' + esc(lyricsExcerpt || 'Lyrics are not included on this shared page yet.') + '</div></div></div>'
    +     '<div class="public-list-card"><div class="public-list-head"><div><div class="public-kicker">Similar vibe</div><div class="public-list-title">Stay in this lane</div><div class="public-list-copy">Related tracks are pulled from genre, mood, prompt, lyrics, and AI metadata already living in the vault.</div></div></div><div class="public-related-grid">' + (related.length ? related.map(function(item) {
          return '<div class="related-card" role="button" tabindex="0" aria-label="' + attr('Open shared track ' + (item.title || 'track')) + '" onclick="openSharedRoute(\'track\', ' + jsq(item.id) + ')">' + buildCoverArt(item, 'sm', false) + '<div><div class="related-title">' + esc(item.title) + '</div><div class="related-sub">' + esc(item.genre || 'Other') + ' / ' + esc(item.mood || 'Mood') + ' / ' + trimText(getTrackPromptExcerpt(item, 76), 76) + '</div></div></div>';
        }).join('') : '<div class="public-empty"><strong>No related tracks yet</strong>Add more music with mood and prompt metadata to strengthen similarity matching.</div>') + '</div></div>'
    +     '<div class="public-side-note"><div class="public-kicker">Playlist context</div><div class="public-list-title">Appears in curated mixes</div><div class="public-list-copy" style="margin-top:.45rem">' + esc(collections.length ? 'This track already anchors one or more mixtapes in the vault.' : 'This track is not in a playlist yet, so it is standing on its own as a shared single.') + '</div><div class="public-link-list" style="margin-top:1rem">' + (collections.length ? collections.map(function(pl) {
          var items = getPlaylistTracks(pl);
          return '<div class="public-link-row" role="button" tabindex="0" aria-label="' + attr('Open shared playlist ' + (pl.name || 'playlist')) + '" onclick="openSharedRoute(\'playlist\', ' + jsq(pl.id) + ')">' + buildPlaylistCover(pl, 'xs') + '<div class="public-link-main"><div class="public-link-title">' + esc(pl.name) + '</div><div class="public-link-sub">' + esc(pl.desc || items.length + ' track mix') + '</div></div><div class="public-row-action">Open mix</div></div>';
        }).join('') : '<div class="public-empty"><strong>No playlist context</strong>Create a playlist from the vault if you want this shared track to sit inside a bigger narrative.</div>') + '</div></div>'
    +   '</div>'
    + '</div>';

  updatePageChrome(track.title + ' | SonicVault', track);
}

function renderPublicPlaylistPage(pl) {
  var el = document.getElementById('public-page');
  if (!el) return;
  if (_publicRouteLoading && !pl) {
    el.innerHTML = '<div class="public-shell" aria-busy="true" aria-label="Loading shared playlist"><div class="public-list-card"><div class="skel skel-cover" style="max-width:220px"></div><div class="skel skel-title"></div><div class="skel skel-title short"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div><div class="skel skel-row" style="margin-top:1.2rem"></div><div class="skel skel-row"></div></div></div>';
    updatePageChrome('Loading playlist | SonicVault', null);
    return;
  }
  if (!pl) {
    el.innerHTML = '<div class="public-shell"><div class="public-list-card"><div class="public-empty"><strong>Playlist not found</strong>This share link does not point to a playlist that exists in the current SonicVault library.<div class="modal-actions" style="justify-content:center;margin-top:1rem"><button class="sec-action primary" onclick="navigateToApp(\'playlists\')">Open SonicVault</button></div></div></div></div>';
    updatePageChrome('Playlist not found | SonicVault', null);
    return;
  }

  var items = getPlaylistTracks(pl);
  var anchor = getPlaylistAnchorTrack(pl);
  var related = Array.isArray(pl.related) ? pl.related : getPlaylistRelatedTracks(pl, 4);
  var playLabel = items.length && _currentTrack && (pl.trackIds || []).indexOf(_currentTrack.id) !== -1 && _isPlaying ? 'Resume playlist' : 'Play playlist';

  el.innerHTML = ''
    + '<div class="public-shell">'
    +   '<div class="public-hero"><div class="public-grid">'
    +     '<div class="public-cover-card">' + buildPlaylistCover(pl, 'md') + '</div>'
    +     '<div class="public-info-card"><div class="public-kicker">Shared playlist / SonicVault</div><div class="public-title">' + esc(pl.name) + '</div><div class="public-sub">' + esc(pl.desc || 'A front-to-back curated sequence built from this private AI music vault.') + '</div><div class="public-pill-strip"><span class="meta-pill highlight">' + items.length + ' tracks</span><span class="meta-pill">' + fmtTime(getCollectionDuration(items)) + '</span><span class="meta-pill">' + esc(anchor.source || 'Mixed') + '</span></div><div class="section-action-row"><button class="sec-action primary" onclick="playPlaylist(' + jsq(pl.id) + ')">' + playLabel + '</button><button class="sec-action" onclick="openShareLinkModal(' + jsq('Share \"' + pl.name + '\"') + ', ' + jsq('Send the playlist link for a front-to-back listen.') + ', ' + jsq(buildShareURL('playlist', pl.id)) + ')">Copy share link</button><button class="sec-action" onclick="navigateToApp(\'playlists\')">Open vault</button></div><div class="public-meta-grid"><div class="public-meta-card"><div class="public-meta-label">Playlist tone</div><div class="public-meta-value">' + esc(anchor.mood || 'Mixed') + '</div><div class="public-meta-copy">Dominant mood from the opener.</div></div><div class="public-meta-card"><div class="public-meta-label">Lead source</div><div class="public-meta-value">' + esc(anchor.source || 'Mixed') + '</div><div class="public-meta-copy">Source shaping the first impression.</div></div><div class="public-meta-card"><div class="public-meta-label">Total plays</div><div class="public-meta-value">' + fmtCompactNumber(items.reduce(function(sum, item) { return sum + Number(item.plays || 0); }, 0)) + '</div><div class="public-meta-copy">Combined plays across this sequence.</div></div></div></div>'
    +   '</div></div>'
    +   '<div class="public-context-grid">'
    +     '<div class="public-list-card"><div class="public-list-head"><div><div class="public-kicker">Track list</div><div class="public-list-title">Front-to-back sequence</div><div class="public-list-copy">The share page keeps the playlist feel intact, with direct play access on every track in the mix.</div></div><div class="section-action-row"><button class="sec-action" onclick="viewPlaylist(' + jsq(pl.id) + ')">Open detail modal</button></div></div><div class="public-track-list">' + (items.length ? items.map(function(track, index) {
          return '<div class="public-track-row" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ', position ' + (index + 1) + ' of ' + (pl.name || 'playlist')) + '" onclick="playPlaylistTrack(' + jsq(pl.id) + ', ' + jsq(track.id) + ')"><div class="public-track-index" aria-hidden="true">' + (index + 1) + '</div>' + buildCoverArt(track, 'xs', false) + '<div class="public-track-main"><div class="public-track-name">' + esc(track.title) + '</div><div class="public-track-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + trimText(getTrackPromptExcerpt(track, 90), 90) + '</div></div><div class="public-track-time">' + fmtTime(track.duration || 0) + '</div><div class="public-row-action">' + ((_currentTrack && _currentTrack.id === track.id && _isPlaying) ? 'Playing' : 'Play') + '</div></div>';
        }).join('') : '<div class="public-empty"><strong>Empty playlist</strong>This shared playlist does not contain tracks yet.</div>') + '</div></div>'
    +     '<div class="public-side-note"><div class="public-kicker">Related context</div><div class="public-list-title">More from this lane</div><div class="public-list-copy" style="margin-top:.45rem">' + esc(related.length ? 'These tracks sit near the same mood, source, or genre profile as this playlist.' : 'Add more tracks nearby in tone if you want a stronger related shelf here.') + '</div><div class="public-related-grid" style="margin-top:1rem">' + (related.length ? related.map(function(track) {
          return '<div class="related-card" role="button" tabindex="0" aria-label="' + attr('Open shared track ' + (track.title || 'track')) + '" onclick="openSharedRoute(\'track\', ' + jsq(track.id) + ')">' + buildCoverArt(track, 'sm', false) + '<div><div class="related-title">' + esc(track.title) + '</div><div class="related-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + trimText(getTrackPromptExcerpt(track, 76), 76) + '</div></div></div>';
        }).join('') : '<div class="public-empty"><strong>No nearby tracks yet</strong>More music in the vault will make playlist-adjacent discovery stronger.</div>') + '</div></div>'
    +   '</div>'
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
