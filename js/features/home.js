// The library home above the shelf: the resume strip and the rails, plus
// the track pickers they and the player draw from.

function getMostPlayedTracks(limit) {
  return tracks.slice().sort(function(a, b) {
    return Number(b.plays || 0) - Number(a.plays || 0) || compareNewestFirst(a, b);
  }).slice(0, limit || 4);
}

function getLeastPlayedTracks(limit) {
  return tracks.slice().sort(function(a, b) {
    return Number(a.plays || 0) - Number(b.plays || 0) || compareNewestFirst(a, b);
  }).slice(0, limit || 4);
}

function getNewestTracks(limit) {
  return tracks.slice().sort(function(a, b) {
    return compareNewestFirst(a, b);
  }).slice(0, limit || 4);
}

function getAutoImportedTracks(limit) {
  return tracks.filter(function(track) { return !!track.autoImported; }).sort(function(a, b) {
    return compareNewestFirst(a, b);
  }).slice(0, limit || 4);
}

function getContinueTrack() {
  var savedId = appSettings && appSettings.lastPlayedTrackId;
  return savedId ? getTrackById(savedId) : null;
}

// rememberPlayback() has always kept the last 24 played ids; nothing read
// them until now. Ids of deleted tracks simply fall out, and the caller
// excludes whatever the resume strip is already showing so the rail does not
// repeat the row directly above it.
function getRecentlyPlayedTracks(limit, excludeId) {
  var history = (appSettings && Array.isArray(appSettings.playHistory)) ? appSettings.playHistory : [];
  var max = limit || 4;
  var out = [];
  for (var i = 0; i < history.length && out.length < max; i++) {
    if (excludeId && history[i] === excludeId) continue;
    var track = getTrackById(history[i]);
    if (track) out.push(track);
  }
  return out;
}

function getFeaturedTrack() {
  if (_currentTrack) return _currentTrack;
  var continueTrack = getContinueTrack();
  if (continueTrack) return continueTrack;
  return getMostPlayedTracks(1)[0] || getNewestTracks(1)[0] || null;
}

function getSimilarTracks(track, limit) {
  if (!track) return [];
  var baseTags = getTrackTags(track);
  var baseLyricsTags = deriveTextTags(getTrackLyrics(track), 8);
  var baseInstruments = getTrackAIInstruments(track);
  return tracks.filter(function(item) {
    return item.id !== track.id;
  }).map(function(item) {
    var score = 0;
    if (item.genre === track.genre) score += 4;
    if (item.mood === track.mood) score += 5;
    if (item.source === track.source) score += 2;
    if (item.aiGenre && track.aiGenre && item.aiGenre === track.aiGenre) score += 3;
    if (item.aiMood && track.aiMood && item.aiMood === track.aiMood) score += 3;
    if (item.aiTheme && track.aiTheme && item.aiTheme === track.aiTheme) score += 4;
    if (item.aiEra && track.aiEra && item.aiEra === track.aiEra) score += 2;
    if (item.aiVocalStyle && track.aiVocalStyle && item.aiVocalStyle === track.aiVocalStyle) score += 2;
    getTrackTags(item).forEach(function(tag) {
      if (baseTags.indexOf(tag) !== -1) score += 1;
    });
    deriveTextTags(getTrackLyrics(item), 8).forEach(function(tag) {
      if (baseLyricsTags.indexOf(tag) !== -1) score += 1;
    });
    getTrackAIInstruments(item).forEach(function(tag) {
      if (baseInstruments.indexOf(tag) !== -1) score += 1;
    });
    if (score > 0) return { track:item, score:score };
    return null;
  }).filter(Boolean).sort(function(a, b) {
    return b.score - a.score || trackTimestamp(b.track) - trackTimestamp(a.track);
  }).slice(0, limit || 4).map(function(item) { return item.track; });
}

// Render a rail once: the id list is derived a single time instead of being
// rebuilt inside the per-item map (which also re-sorted the whole library on
// every iteration when the list came from getNewestTracks/getMostPlayed).
function buildMiniRail(list, label, emptyHTML) {
  if (!list.length) return emptyHTML || '';
  var ids = list.map(function(item) { return item.id; });
  return list.map(function(track) { return buildMiniTrackCard(track, label, ids); }).join('');
}

function buildMiniTrackCard(track, queueLabel, queueIds) {
  return ''
    + '<div class="mini-track-card" role="button" tabindex="0"'
    +   ' aria-label="' + attr('Play ' + (track.title || 'track') + ' from ' + (queueLabel || 'Curated shelf')) + '"'
    +   ' onclick="startPlayback(' + jsq(track.id) + ', ' + jsv(queueIds || [track.id]) + ', ' + jsq(queueLabel || 'Curated shelf') + ')">'
    +   buildCoverArt(track, 'xs', false)
    +   '<div class="side-item-copy">'
    +     '<div class="mini-track-title">' + esc(track.title) + '</div>'
    +     '<div class="mini-track-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + '</div>'
    +   '</div>'
    +   (_currentTrack && _currentTrack.id === track.id
            // The whole card is the play control -- role="button" with its own
            // onclick -- so the pill was a non-interactive label repeating
            // that, and at four rails it cost the title more width than the
            // title had. It now appears only to mark the current track.
            ? '<div class="mini-track-play" aria-hidden="true">' + (_isPlaying ? 'II' : '&#9654;') + '</div>'
            : '')
    + '</div>';
}

function buildMoodCards() {
  var counts = {};
  tracks.forEach(function(track) {
    counts[track.mood || 'Other'] = (counts[track.mood || 'Other'] || 0) + 1;
  });
  return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).slice(0, 6).map(function(mood) {
    return '<button class="mood-card" style="--card-glow:' + getMoodColor(mood) + '33" onclick="browseMood(' + jsq(mood) + ')"><div class="mood-name">' + esc(mood) + '</div><div class="mood-meta">' + counts[mood] + ' track' + (counts[mood] !== 1 ? 's' : '') + ' leaning into this mood.</div><div class="mood-count">Open mood shelf</div></button>';
  }).join('');
}

function buildSourceCards() {
  var counts = {};
  tracks.forEach(function(track) {
    counts[track.source || 'Other'] = (counts[track.source || 'Other'] || 0) + 1;
  });
  return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).map(function(source) {
    return '<button class="source-card" style="--card-glow:' + getGenreColor(source === 'Suno' ? 'Synthwave' : source === 'Original' ? 'Folk' : 'Electronic') + '33" onclick="browseSource(' + jsq(source) + ')"><div class="source-name">' + esc(source) + '</div><div class="source-meta">' + counts[source] + ' track' + (counts[source] !== 1 ? 's' : '') + ' imported from this lane.</div><div class="source-count">Browse source</div></button>';
  }).join('');
}

// Shape-matched placeholder for the hero, so the first paint of a syncing
// vault reads as "loading" instead of "empty".
function buildLibrarySkeleton() {
  function block(cls) { return '<div class="skel ' + cls + '"></div>'; }
  return ''
    + '<div class="library-home-stack" aria-busy="true" aria-label="Loading your vault">'
    +   '<div class="hero-stage">'
    +     '<div class="hero-main"><div class="hero-grid">'
    +       '<div class="hero-copy">'
    +         block('skel-eyebrow') + block('skel-title') + block('skel-title short') + block('skel-line') + block('skel-line') + block('skel-line short')
    +         '<div class="hero-summary">'
    +           block('skel-tile') + block('skel-tile') + block('skel-tile') + block('skel-tile')
    +         '</div>'
    +       '</div>'
    +       '<div class="spotlight-card">' + block('skel-cover') + block('skel-line') + block('skel-line short') + '</div>'
    +     '</div></div>'
    +     '<div class="hero-side"><div class="side-card">' + block('skel-line') + block('skel-line short') + '</div><div class="side-card">' + block('skel-line') + block('skel-line') + block('skel-line short') + '</div></div>'
    +   '</div>'
    +   '<div class="rail-grid">'
    +     '<div class="rail-card">' + block('skel-line short') + block('skel-row') + block('skel-row') + block('skel-row') + '</div>'
    +     '<div class="rail-card">' + block('skel-line short') + block('skel-row') + block('skel-row') + block('skel-row') + '</div>'
    +     '<div class="rail-card">' + block('skel-line short') + block('skel-row') + block('skel-row') + block('skel-row') + '</div>'
    +   '</div>'
    + '</div>';
}

function renderLibraryHome() {
  var el = document.getElementById('library-home');
  if (!el) return;

  if (!tracks.length && window.svBootPending) {
    el.innerHTML = buildLibrarySkeleton();
    return;
  }

  if (!tracks.length) {
    el.innerHTML = '<div class="section-card"><div class="section-inner"><div class="empty-state"><strong>Start your private label.</strong>Upload your first Suno track or let the watcher auto-import from your downloads folder. SonicVault will build the cover system, the discovery rails, and the listening-first player on top of the same data model you already use.<div class="modal-actions" style="justify-content:center;margin-top:1rem"><button class="sec-action primary" onclick="switchView(\'upload\')">Import first track</button><button class="sec-action" onclick="startCoverDemo()">Preview cover styles</button></div></div></div></div>';
    return;
  }

  var featuredTrack = getFeaturedTrack();
  var continueTrack = getContinueTrack() || featuredTrack;
  var recentTracks = getNewestTracks(4);
  var hiddenGems = getLeastPlayedTracks(4);
  var mostPlayed = getMostPlayedTracks(4);
  var recentlyPlayed = getRecentlyPlayedTracks(4, getContinueTrack() ? continueTrack.id : '');

  // The old home opened with a marketing hero, four stat tiles, a spotlight
  // card, two side cards, a four-card snapshot grid, and nine rails before a
  // single library track appeared. The stat tiles and snapshot grid restated
  // the Insights page, and the Mood / Source / Discovery-tag rails were the
  // mood, source, and tag filters under different names. What is left is a
  // resume strip and three rails that are genuinely shortcuts, not restatements.
  el.innerHTML = ''
    + '<div class="library-home-stack">'
    +   (_coverDemoActive ? '<div class="browse-summary has-filters"><div><strong>Cover demo mode</strong></div><div>These tracks are memory-only previews and will not be saved.</div><button class="browse-clear-pill" onclick="exitCoverDemo()">Exit demo</button></div>' : '')
    +   '<div class="resume-strip">'
    +     buildCoverArt(continueTrack, 'sm', true)
    +     '<div class="resume-copy">'
    +       '<div class="resume-kicker">' + (getContinueTrack() ? 'Continue listening' : 'Featured') + '</div>'
    +       '<div class="resume-title">' + esc(continueTrack.title) + '</div>'
    +       '<div class="resume-meta">' + esc(continueTrack.genre || 'Other') + ' &middot; ' + esc(continueTrack.mood || 'Mood') + ' &middot; ' + fmtTime(continueTrack.duration || 0) + '</div>'
    +     '</div>'
    +     '<div class="resume-actions">'
    +       '<button class="sec-action primary" onclick="playTrack(' + jsq(continueTrack.id) + ')">Play</button>'
    +       '<button class="sec-action" onclick="switchView(\'upload\')">Import</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="rail-grid">'
    +     '<div class="rail-card"><div class="rail-title">Recently added</div><div class="mini-track-list">' + buildMiniRail(recentTracks, 'Recently added') + '</div></div>'
    +     (recentlyPlayed.length
            ? '<div class="rail-card"><div class="rail-title">Recently played</div><div class="mini-track-list">' + buildMiniRail(recentlyPlayed, 'Recently played') + '</div></div>'
            : '')
    +     '<div class="rail-card"><div class="rail-title">Most played</div><div class="mini-track-list">' + buildMiniRail(mostPlayed, 'Most played') + '</div></div>'
    +     '<div class="rail-card"><div class="rail-title">Rarely played</div><div class="mini-track-list">' + buildMiniRail(hiddenGems, 'Rarely played') + '</div></div>'
    +   '</div>'
    + '</div>';
}
