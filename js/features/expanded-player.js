// The full-screen player: lyrics scroll-along, the large waveform, the
// paged queue panel, add-to-playlist, and the similar-vibe row.

function formatLyricsHTML(rawLyrics) {
  var text = String(rawLyrics || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return '';
  return text.split('\n').map(function(line) {
    var clean = String(line || '');
    var trimmed = clean.trim();
    if (!trimmed) return '<div class="lyric-line">&nbsp;</div>';
    // Suno labels sections "[Verse 1]" in newer exports and "(Verse 1)" in
    // older ones. Parenthesised lines only count when they name a section,
    // so an ad-lib like "(oh-oh)" stays a lyric.
    if (/^\[[^\]]+\]$/.test(trimmed) || /^\((?:intro|verse|pre-?chorus|chorus|post-?chorus|hook|refrain|bridge|break(?:down)?|interlude|instrumental|solo|drop|build(?:-?up)?|outro|end|fade(?: out)?)\b[^)]*\)$/i.test(trimmed)) {
      return '<div class="lyric-section-header">' + esc(trimmed) + '</div>';
    }
    return '<div class="lyric-line">' + esc(clean) + '</div>';
  }).join('');
}

function openExpandedPlayer(event) {
  if (event && event.target && event.target.closest('.np-btn')) return;
  if (!_currentTrack) return;
  // Populate first, then open — openModal places focus on the dialog's first
  // control, so the content it measures has to already be there.
  updateExpandedPlayer();
  openModal('modal-now-playing');
}

function openAddToPlaylist() {
  if (!_currentTrack) return;
  var target = document.getElementById('xp-playlist-list');
  if (target) target.scrollIntoView({ behavior:'smooth', block:'center' });
}

// Toggles the "alive" animations on the expanded player's waveform and cover
// based on whether audio is actually playing. Cheap; safe to call often.
function syncPlayerLiveState() {
  var wave = document.getElementById('xp-wave');
  if (wave) wave.classList.toggle('playing', !!_isPlaying);
  var coverEl = document.querySelector('#xp-cover .cover-art');
  if (coverEl) coverEl.classList.toggle('cover-live', !!_isPlaying);
}

// Approximate lyric scroll-along. Lyrics from Suno are untimed, so the active
// line is mapped proportionally from playback position across the content
// lines. force=true re-applies even if the line index hasn't changed (used
// when the lyric DOM was just rebuilt for a new track).
var _lyricLineIdx = -1;
function updateLyricHighlight(force) {
  var container = document.getElementById('xp-lyrics');
  if (!container || !container.classList.contains('synced')) return;
  var lines = container.querySelectorAll('.lyric-line');
  if (!lines.length || !_audio.duration) return;
  var frac = Math.max(0, Math.min(1, _audio.currentTime / _audio.duration));
  var idx = Math.min(lines.length - 1, Math.floor(frac * lines.length));
  if (idx === _lyricLineIdx && !force) return;
  _lyricLineIdx = idx;
  for (var i = 0; i < lines.length; i++) lines[i].classList.toggle('lyric-current', i === idx);
  var line = lines[idx];
  // Scroll within the lyric box only — never the page.
  container.scrollTop = line.offsetTop - (container.clientHeight / 2) + (line.offsetHeight / 2);
}

function renderExpandedWaveform(track) {
  var bars = getVisualWaveform(track, 72);
  var pct = _audio.duration ? (_audio.currentTime / _audio.duration) : 0;
  var html = '';
  for (var i = 0; i < bars.length; i++) {
    var active = (i / bars.length) <= pct;
    var current = Math.abs((i / bars.length) - pct) < (1 / bars.length);
    html += '<div class="pbar' + (active ? ' active' : '') + (current ? ' current' : '') + '" style="height:' + Math.round(bars[i] * 100) + '%"></div>';
  }
  return html;
}

// ── Queue paging ───────────────────────────────────────────────────────
// The browse shelf has paged since the progressive-rendering work; the queue
// panel never did, and rendered every track at once with two reorder buttons
// each. It pages the same way, but windowed around the current track rather
// than from the top: the rows worth opening this panel for are the one
// playing and the one after it, and at 600 tracks those could be row 400.
var QUEUE_PAGE_SIZE = 40;
var QUEUE_WINDOW_LEAD = 4;   // rows of context kept above the current track
var _queueWindowStart = 0;
var _queueWindowCount = QUEUE_PAGE_SIZE;
var _queueWindowKey = '';
var _queueObserver = null;

// Recentre only when the queue itself changes. Pausing must not throw away
// a window the listener has scrolled through.
function queueWindowKey(list) {
  return [_playQueueLabel, list.length, _currentTrack ? _currentTrack.id : '', _shuffleMode ? 's' : ''].join('|');
}

function resetQueueWindow(list) {
  var idx = 0;
  if (_currentTrack) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === _currentTrack.id) { idx = i; break; }
    }
  }
  _queueWindowStart = Math.max(0, idx - QUEUE_WINDOW_LEAD);
  _queueWindowCount = QUEUE_PAGE_SIZE;
}

function showEarlierQueue() {
  var take = Math.min(QUEUE_PAGE_SIZE, _queueWindowStart);
  if (!take) return;
  _queueWindowStart -= take;
  _queueWindowCount += take;
  updateExpandedPlayer();
}

function showMoreQueue() {
  _queueWindowCount += QUEUE_PAGE_SIZE;
  updateExpandedPlayer();
}

// The live queue is already in _playQueueIds. Serialising it into every row's
// onclick made this panel's HTML grow quadratically with the queue -- 716KB
// for 40 rendered rows at a 600-track queue. Resolve it at click time, the
// same way buildTrackCard already does.
function playFromQueue(id) {
  startPlayback(id, _playQueueIds.slice(), _playQueueLabel);
}

function observeQueueSentinel() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (_queueObserver) _queueObserver.disconnect();
  var sentinel = document.getElementById('queue-sentinel');
  if (!sentinel) return;
  _queueObserver = new IntersectionObserver(function(entries) {
    if (entries.some(function(entry) { return entry.isIntersecting; })) showMoreQueue();
  }, { rootMargin: '400px 0px' });
  _queueObserver.observe(sentinel);
}

function updateExpandedPlayer() {
  var title = document.getElementById('xp-title');
  if (!title) return;
  updatePlayerModeUI();
  if (!_currentTrack) {
    title.textContent = 'Choose a track';
    document.getElementById('xp-cover').innerHTML = '';
    paintPlayerBackdrop();
    document.getElementById('xp-kicker').textContent = 'Listening room';
    document.getElementById('xp-meta').textContent = 'Genre / mood / source will appear here.';
    document.getElementById('xp-prompt').textContent = 'Prompt and notes appear here once a track is active.';
    document.getElementById('xp-lyrics').innerHTML = 'Lyrics appear here once a track is active.';
    document.getElementById('xp-lyrics').className = 'player-lyrics empty';
    document.getElementById('xp-ai-summary').textContent = 'AI summary and curation tags will appear here after metadata generation.';
    document.getElementById('xp-ai-tags').innerHTML = '';
    document.getElementById('xp-ai-facts').innerHTML = '';
    document.getElementById('xp-current').textContent = '0:00';
    document.getElementById('xp-total').textContent = '0:00';
    document.getElementById('xp-progress-fill').style.width = '0%';
    document.getElementById('xp-wave').innerHTML = '';
    setPlayButton(document.getElementById('xp-play-btn'), false);
    document.getElementById('xp-queue-copy').textContent = 'The active queue will show up here.';
    document.getElementById('xp-queue-list').innerHTML = '<div class="empty-state" style="padding:1rem"><strong style="font-size:24px;margin-bottom:.3rem">No queue yet</strong>Start playback to open the full player.</div>';
    document.getElementById('xp-playlist-list').innerHTML = '<div class="empty-state" style="padding:1rem"><strong style="font-size:24px;margin-bottom:.3rem">No track selected</strong>Choose a record first.</div>';
    document.getElementById('xp-related').innerHTML = '';
    return;
  }

  ensureWaveformForTrack(_currentTrack);
  document.getElementById('xp-cover').innerHTML = buildCoverArt(_currentTrack, 'lg', true);
  paintPlayerBackdrop();
  document.getElementById('xp-kicker').textContent = 'Playing from ' + (_playQueueLabel || 'your vault');
  document.getElementById('xp-title').textContent = _currentTrack.title;
  document.getElementById('xp-meta').textContent = (_currentTrack.genre || 'Other') + ' / ' + (_currentTrack.mood || 'Mood') + ' / ' + (_currentTrack.source || 'Suno') + ' / ' + fmtCompactNumber(_currentTrack.plays || 0) + (Number(_currentTrack.plays) === 1 ? ' play' : ' plays');
  document.getElementById('xp-prompt').textContent = _currentTrack.prompt || promptFallback(_currentTrack);
  document.getElementById('xp-lyrics').innerHTML = hasLyrics(_currentTrack) ? formatLyricsHTML(getTrackLyrics(_currentTrack)) : 'Lyrics have not been added yet for this track.';
  document.getElementById('xp-lyrics').className = 'player-lyrics' + (hasLyrics(_currentTrack) ? ' synced' : ' empty');
  _lyricLineIdx = -1;
  document.getElementById('xp-ai-summary').textContent = getTrackSummary(_currentTrack) || 'No AI summary yet. Generate metadata from the upload flow to add a richer editorial read on this track.';
  document.getElementById('xp-ai-tags').innerHTML = getTrackTags(_currentTrack).slice(0, 8).map(function(tag) {
    return '<span class="player-ai-pill">' + esc(tag) + '</span>';
  }).join('');
  document.getElementById('xp-ai-facts').innerHTML = [getTrackAITheme(_currentTrack), _currentTrack.aiEnergy, _currentTrack.aiVocalStyle, _currentTrack.aiEra].filter(Boolean).map(function(item) {
    return '<span class="player-ai-pill">' + esc(item) + '</span>';
  }).join('') + (getTrackAIInstruments(_currentTrack).map(function(item) { return '<span class="player-ai-pill">' + esc(item) + '</span>'; }).join(''));
  document.getElementById('xp-current').textContent = fmtTime(_audio.currentTime || 0);
  document.getElementById('xp-total').textContent = fmtTime(_audio.duration || _currentTrack.duration || 0);
  var pct = _audio.duration ? (_audio.currentTime / _audio.duration) * 100 : 0;
  document.getElementById('xp-progress-fill').style.width = pct + '%';
  document.getElementById('xp-wave').innerHTML = renderExpandedWaveform(_currentTrack);
  setPlayButton(document.getElementById('xp-play-btn'), _isPlaying);
  syncPlayerLiveState();
  updateLyricHighlight(true);

  var queueTracks = getOrderedQueueTracks();
  // Every row in a queue is queued, so labelling them all said nothing 59
  // times over. Only the two rows that carry information are labelled now.
  // Repeat-one is excluded deliberately: the 'ended' handler replays the
  // current track and never consults getNextTrack(), so the track it returns
  // is not what plays next -- nothing is, and the current row already reads
  // "Playing".
  var nextInQueue = _repeatMode === 'one' ? null : getNextTrack();
  var nextQueueId = (nextInQueue && (!_currentTrack || nextInQueue.id !== _currentTrack.id))
    ? nextInQueue.id : '';
  document.getElementById('xp-queue-copy').textContent = queueTracks.length ? _playQueueLabel + (_shuffleMode ? ' / Shuffle' : '') + ' / ' + queueTracks.length + ' track' + (queueTracks.length !== 1 ? 's' : '') : 'The active queue will show up here.';
  var queueKey = queueWindowKey(queueTracks);
  if (queueKey !== _queueWindowKey) { _queueWindowKey = queueKey; resetQueueWindow(queueTracks); }
  var queueEnd = Math.min(queueTracks.length, _queueWindowStart + _queueWindowCount);
  var queueSlice = queueTracks.slice(_queueWindowStart, queueEnd);
  var queueAfter = queueTracks.length - queueEnd;
  var earlierHTML = _queueWindowStart > 0
    ? '<div class="queue-sentinel"><button class="sec-action" onclick="showEarlierQueue()">Show ' + Math.min(QUEUE_PAGE_SIZE, _queueWindowStart) + ' earlier</button></div>'
    : '';
  var moreHTML = queueAfter > 0
    ? '<div class="queue-sentinel" id="queue-sentinel">'
      + '<button class="sec-action" onclick="showMoreQueue()">Show ' + Math.min(QUEUE_PAGE_SIZE, queueAfter) + ' more</button>'
      + '<div class="shelf-sentinel-copy">' + queueEnd + ' of ' + queueTracks.length + ' in the queue</div>'
      + '</div>'
    : '';
  document.getElementById('xp-queue-list').innerHTML = queueTracks.length ? earlierHTML + queueSlice.map(function(track, sliceIndex) {
    // Absolute position: the row number and the reorder bounds are relative
    // to the whole queue, not the rendered window.
    var index = _queueWindowStart + sliceIndex;
    var isActive = _currentTrack && _currentTrack.id === track.id;
    var isNext = !isActive && !!nextQueueId && track.id === nextQueueId;
    var state = isActive ? (_isPlaying ? 'Playing' : 'Paused') : (isNext ? 'Next' : '');
    var reorder = '<div class="queue-reorder">'
      + '<button title="Move up" onclick="event.stopPropagation();moveQueueTrack(' + jsq(track.id) + ', -1)"' + (index === 0 ? ' disabled' : '') + '>&#9650;</button>'
      + '<button title="Move down" onclick="event.stopPropagation();moveQueueTrack(' + jsq(track.id) + ', 1)"' + (index === queueTracks.length - 1 ? ' disabled' : '') + '>&#9660;</button>'
      + '</div>';
    return '<div class="queue-item' + (isActive ? ' active' : '') + '" role="button" tabindex="0"' + (isActive ? ' aria-current="true"' : '') + ' aria-label="' + attr('Play ' + (track.title || 'track') + ', queue position ' + (index + 1) + (state ? ', ' + state.toLowerCase() : '')) + '" onclick="playFromQueue(' + jsq(track.id) + ')"><div class="queue-num" aria-hidden="true">' + (index + 1) + '</div>' + buildCoverArt(track, 'xs', false) + '<div class="queue-copy"><div class="queue-title">' + esc(track.title) + '</div><div class="queue-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + fmtTime(track.duration || 0) + '</div></div><div class="queue-state' + (isNext ? ' is-next' : '') + '">' + esc(state) + '</div>' + reorder + '</div>';
  }).join('') + moreHTML : '<div class="empty-state" style="padding:1rem"><strong style="font-size:24px;margin-bottom:.3rem">No queue yet</strong>Play something to build the queue.</div>';
  observeQueueSentinel();

  document.getElementById('xp-playlist-list').innerHTML = playlists.length ? playlists.map(function(playlist) {
    var present = (playlist.trackIds || []).indexOf(_currentTrack.id) !== -1;
    return '<div class="playlist-chip"><div class="playlist-chip-copy"><div class="playlist-chip-title">' + esc(playlist.name) + '</div><div class="playlist-chip-sub">' + esc(playlist.desc || (playlist.trackIds || []).length + ' track mix') + '</div></div><button class="sec-action' + (present ? '' : ' primary') + '" onclick="addTrackToPlaylist(' + jsq(playlist.id) + ', ' + jsq(_currentTrack.id) + ')">' + (present ? 'Added' : 'Add') + '</button></div>';
  }).join('') : '<div class="empty-state" style="padding:1rem"><strong style="font-size:24px;margin-bottom:.3rem">No playlists yet</strong>Create a playlist on the playlist page, then add the current track here.</div>';

  var related = getSimilarTracks(_currentTrack, 4);
  document.getElementById('xp-related').innerHTML = related.length ? related.map(function(track) {
    return '<div class="related-card" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track') + ' from Similar vibe') + '" onclick="startPlayback(' + jsq(track.id) + ', ' + jsv(related.map(function(item) { return item.id; })) + ', ' + jsq('Similar vibe') + ')">' + buildCoverArt(track, 'sm', false) + '<div><div class="related-title">' + esc(track.title) + '</div><div class="related-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + trimText(getTrackPromptExcerpt(track, 72), 72) + '</div></div></div>';
  }).join('') : '<div class="empty-state" style="padding:1rem"><strong style="font-size:24px;margin-bottom:.3rem">Need more context</strong>Add more tracks to surface a stronger related row.</div>';
}
