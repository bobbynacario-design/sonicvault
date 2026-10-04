// The full-screen player: lyrics scroll-along, the large waveform, the
// paged queue panel, add-to-playlist, and the similar-vibe row.

// Section labels and blank gaps are layout; only sung lines are numbered,
// timed and tappable (js/features/lyric-sync.js).
function formatLyricsHTML(rawLyrics) {
  var rows = parseLyricSheet(rawLyrics);
  if (!rows.some(function(row) { return row.kind !== 'gap'; })) return '';
  return rows.map(function(row) {
    if (row.kind === 'gap') return '<div class="lyric-gap"></div>';
    if (row.kind === 'header') return '<div class="lyric-section-header">' + esc(row.text) + '</div>';
    return '<div class="lyric-line" role="button" tabindex="0" data-line="' + row.index + '" onclick="onLyricLineTap(' + row.index + ')">' + esc(row.text) + '</div>';
  }).join('');
}

// "About this song": the description, the details the AI inferred, the
// prompt, and the tags, in one card. It replaces a "Prompt / notes" box that
// was usually a filler sentence beside an "AI summary" whose tags were
// mostly words lifted from the lyrics.
function renderAboutSong(track) {
  var summaryEl = document.getElementById('xp-ai-summary');
  var factsEl = document.getElementById('xp-facts');
  var tagsEl = document.getElementById('xp-tags');
  if (!summaryEl || !factsEl || !tagsEl) return;
  if (!track) {
    summaryEl.className = 'player-ai-summary is-empty';
    summaryEl.textContent = 'Play a track to see what it\u2019s about.';
    factsEl.hidden = tagsEl.hidden = true;
    return;
  }
  var summary = getTrackSummary(track);
  var canEdit = !!getVaultTrack(track.id);
  summaryEl.className = 'player-ai-summary' + (summary ? '' : ' is-empty');
  summaryEl.innerHTML = summary
    ? esc(summary)
    : 'No description yet.' + (canEdit ? ' <button type="button" class="player-about-action" onclick="openEditTrack(' + jsq(track.id) + ')">Add one</button>' : '');

  var facts = [
    ['Themes', sanitizeMetadataArray(getTrackAITheme(track), 6).join(', ')],
    ['Energy', track.aiEnergy],
    ['Vocals', track.aiVocalStyle],
    ['Era', track.aiEra],
    ['Instruments', getTrackAIInstruments(track).join(', ')]
  ].filter(function(fact) { return String(fact[1] || '').trim(); });
  var prompt = String(track.prompt || '').trim();
  factsEl.innerHTML = facts.map(function(fact) {
    return '<div class="player-fact"><dt>' + fact[0] + '</dt><dd>' + esc(fact[1]) + '</dd></div>';
  }).join('') + (prompt ? '<div class="player-fact is-wide"><dt>Prompt</dt><dd>' + esc(prompt) + '</dd></div>' : '');
  factsEl.hidden = !facts.length && !prompt;

  // The AI's own tags; a track never tagged shows words from its prompt.
  var tags = getTrackAITags(track);
  if (!tags.length) tags = derivePromptTags(prompt);
  tagsEl.innerHTML = tags.slice(0, 8).map(function(tag) { return '<span class="player-tag">' + esc(tag) + '</span>'; }).join('');
  tagsEl.hidden = !tags.length;
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
  // Read from the audio element itself: a lock-screen pause or the end of a
  // track changes it before the app's own state catches up.
  document.body.classList.toggle('is-playing', !!_currentTrack && !_audio.paused);
  var wave = document.getElementById('xp-wave');
  if (wave) wave.classList.toggle('playing', !!_isPlaying);
  var coverEl = document.querySelector('#xp-cover .cover-art');
  if (coverEl) coverEl.classList.toggle('cover-live', !!_isPlaying);
}

// Lyric scroll-along, from the track's lyric timings (lyric-sync.js) or an
// even spread until it has some. Nothing is lit before the first line or in
// a long instrumental break. force=true re-applies even if the line has not
// changed (used when the lyric DOM was just rebuilt).
var _lyricLineIdx = -1;
function updateLyricHighlight(force) {
  var container = document.getElementById('xp-lyrics');
  if (!container || !container.classList.contains('synced')) return;
  var lines = container.querySelectorAll('.lyric-line');
  if (!lines.length) return;
  var times = getCurrentLyricTimes();
  var idx = times && times.length === lines.length ? currentLyricIndex(times, _audio.currentTime || 0) : -1;
  if (idx === _lyricLineIdx && !force) return;
  _lyricLineIdx = idx;
  for (var i = 0; i < lines.length; i++) {
    lines[i].classList.toggle('lyric-current', i === idx);
    lines[i].classList.toggle('lyric-past', idx >= 0 && i < idx);
  }
  if (idx < 0) return;
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
    document.getElementById('xp-cover').removeAttribute('data-cover');
    paintPlayerBackdrop();
    document.getElementById('xp-kicker').textContent = 'Listening room';
    document.getElementById('xp-meta').textContent = 'Genre / mood / source will appear here.';
    renderPlayerVersions(null);
    document.getElementById('xp-lyrics').innerHTML = 'Lyrics appear here once a track is active.';
    document.getElementById('xp-lyrics').className = 'player-lyrics empty';
    document.getElementById('xp-lyrics').removeAttribute('data-key');
    renderLyricStatus();
    renderAboutSong(null);
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
  swapCover(document.getElementById('xp-cover'), _currentTrack, 'lg', true);
  paintPlayerBackdrop();
  document.getElementById('xp-kicker').textContent = 'Playing from ' + (_playQueueLabel || 'your vault');
  document.getElementById('xp-title').textContent = _currentTrack.title;
  document.getElementById('xp-meta').textContent = (_currentTrack.genre || 'Other') + ' / ' + (_currentTrack.mood || 'Mood') + ' / ' + (_currentTrack.source || 'Suno') + ' / ' + fmtCompactNumber(_currentTrack.plays || 0) + (Number(_currentTrack.plays) === 1 ? ' play' : ' plays');
  renderPlayerVersions(getVaultTrack(_currentTrack.id));
  // Rebuilt only when the track or its lyrics change: this runs on every
  // play/pause, and rebuilding threw away the scroll position each time.
  // The vault's copy of the track, since lyrics can arrive after playback
  // started (the artwork sweep fills empty sheets from the file).
  var lyricTrack = getVaultTrack(_currentTrack.id) || _currentTrack;
  var lyricsEl = document.getElementById('xp-lyrics');
  var lyricsKey = _currentTrack.id + '|' + (hasLyrics(lyricTrack) ? lyricSyncKey(getTrackLyrics(lyricTrack)) : 'none');
  if (lyricsEl.getAttribute('data-key') !== lyricsKey) {
    lyricsEl.setAttribute('data-key', lyricsKey);
    lyricsEl.innerHTML = hasLyrics(lyricTrack) ? formatLyricsHTML(getTrackLyrics(lyricTrack)) : 'Lyrics have not been added yet for this track.';
    lyricsEl.className = 'player-lyrics' + (hasLyrics(lyricTrack) ? ' synced' : ' empty');
    lyricsEl.scrollTop = 0;
    _lyricLineIdx = -1;
    _lyricTimesCache = null;
  }
  renderLyricStatus();
  renderAboutSong(getVaultTrack(_currentTrack.id) || _currentTrack);
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
    return '<div class="queue-item' + (isActive ? ' active' : '') + '" role="button" tabindex="0"' + (isActive ? ' aria-current="true"' : '') + ' aria-label="' + attr('Play ' + (track.title || 'track') + ', queue position ' + (index + 1) + (state ? ', ' + state.toLowerCase() : '')) + '" onclick="playFromQueue(' + jsq(track.id) + ')"><div class="queue-num" aria-hidden="true">' + (index + 1) + '</div>' + buildCoverArt(track, 'xs', false) + '<div class="queue-copy"><div class="queue-title">' + esc(track.title) + '</div><div class="queue-sub">' + esc(track.genre || 'Other') + ' / ' + esc(track.mood || 'Mood') + ' / ' + fmtTime(track.duration || 0) + '</div></div><div class="queue-state' + (isNext ? ' is-next' : '') + '">' + (isActive ? eqBars() : '') + esc(state) + '</div>' + reorder + '</div>';
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
