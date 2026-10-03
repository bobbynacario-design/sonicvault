// The edit-track dialog for tracks already in the vault, with the same AI
// metadata assist the upload editor uses.

var EDIT_GENRES = ['Synthwave','Lo-fi','Electronic','Ambient','Hip Hop','Rock','Pop','Folk','Jazz','Classical','R&B','Chiptune','Metal','Country','Other'];
var EDIT_MOODS = ['Energetic','Chill','Intense','Dreamy','Warm','Playful','Melancholic','Uplifting','Dark'];
var EDIT_SOURCES = ['Suno','Udio','Original','Other'];
var _editingTrackId = '';
var _editTrackAI = null;

// Make sure the track's current value is selectable even if it isn't one of
// the canonical options (e.g. watcher imports with freeform genres).
function buildEditSelectOptions(list, current) {
  var options = list.slice();
  if (current && options.indexOf(current) === -1) options.unshift(current);
  return buildSelectOptions(options, current || options[0]);
}

function openEditTrack(id) {
  var track = getTrackById(id);
  if (!track) return;
  _editingTrackId = id;
  _editTrackAI = null;
  document.getElementById('edit-title').value = track.title || '';
  document.getElementById('edit-genre').innerHTML = buildEditSelectOptions(EDIT_GENRES, track.genre || 'Other');
  document.getElementById('edit-mood').innerHTML = buildEditSelectOptions(EDIT_MOODS, track.mood || 'Chill');
  document.getElementById('edit-source').innerHTML = buildEditSelectOptions(EDIT_SOURCES, track.source || 'Suno');
  document.getElementById('edit-cover-style').innerHTML = buildCoverStyleOptions(getCoverStyle(track));
  document.getElementById('edit-prompt').value = track.prompt || '';
  document.getElementById('edit-lyrics').value = getTrackLyrics(track);
  document.getElementById('edit-ai-chips').innerHTML = '';
  document.getElementById('edit-ai-status').textContent = getTrackSummary(track) || 'Generate AI metadata from the current title, prompt, and lyrics. Uses your Claude worker when configured, otherwise local suggestions.';
  var btn = document.getElementById('edit-ai-btn');
  btn.disabled = false;
  btn.textContent = getTrackSummary(track) ? 'Regenerate AI metadata' : 'Generate AI metadata';
  openModal('modal-edit-track');
}

function readEditDraftInput() {
  return {
    title: document.getElementById('edit-title').value.trim(),
    prompt: document.getElementById('edit-prompt').value.trim(),
    lyrics: document.getElementById('edit-lyrics').value.trim(),
    genre: document.getElementById('edit-genre').value,
    mood: document.getElementById('edit-mood').value
  };
}

async function regenerateTrackMetadata() {
  if (!_editingTrackId) return;
  var track = getTrackById(_editingTrackId);
  var input = readEditDraftInput();
  if (!input.title) { showToast('Add a title before generating metadata'); return; }
  var btn = document.getElementById('edit-ai-btn');
  var statusEl = document.getElementById('edit-ai-status');
  btn.disabled = true;
  statusEl.textContent = 'Generating metadata...';
  try {
    var fallback = buildLocalMetadataSuggestion(input);
    var metadata = _aiConfig.endpoint ? await requestRemoteAIMetadata(input, fallback) : fallback;
    metadata.aiSource = _aiConfig.endpoint ? 'claude' : 'local';
    _editTrackAI = metadata;
    var coverSelect = document.getElementById('edit-cover-style');
    if (coverSelect && metadata.coverStyle) coverSelect.value = normalizeCoverStyle(metadata.coverStyle, track);
    statusEl.textContent = metadata.aiSummary || (_aiConfig.endpoint ? 'Claude metadata ready.' : 'Local suggestions ready.');
    var chips = (metadata.aiTags || []).concat([metadata.aiMood, metadata.aiGenre, metadata.aiEnergy, getCoverStyleName(metadata.coverStyle)].filter(Boolean));
    document.getElementById('edit-ai-chips').innerHTML = chips.map(function(c) { return '<span class="ai-chip">' + esc(c) + '</span>'; }).join('');
    showToast(_aiConfig.endpoint ? 'Claude metadata generated' : 'Local metadata suggestions generated');
  } catch (e) {
    statusEl.textContent = 'AI metadata failed: ' + (e && e.message ? e.message : 'unknown error');
    showToast('AI metadata failed. Save still works.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regenerate AI metadata';
  }
}

function saveEditTrack() {
  if (!_editingTrackId) return;
  var track = getTrackById(_editingTrackId);
  if (!track) { closeModal('modal-edit-track'); return; }
  var input = readEditDraftInput();
  if (!input.title) { showToast('Title cannot be empty'); return; }
  if (_editTrackAI) applyAIMetadataToDraft(track, _editTrackAI, false);
  // The explicit form values always win over anything AI assignment touched.
  track.title = input.title;
  track.genre = input.genre;
  track.mood = input.mood;
  track.source = document.getElementById('edit-source').value;
  track.coverStyle = document.getElementById('edit-cover-style').value || getCoverStyle(track);
  track.prompt = input.prompt;
  track.lyrics = input.lyrics;
  _mediaSessionArtworkCache = {};
  persistTracks();
  _editingTrackId = '';
  _editTrackAI = null;
  closeModal('modal-edit-track');
  renderTracks();
  if (_currentTrack && _currentTrack.id === track.id) updateNowPlaying();
  showToast('Track updated');
}

function cycleTrackCover(id) {
  var track = getTrackById(id);
  if (!track) return;
  track.coverStyle = getNextCoverStyle(getCoverStyle(track));
  _mediaSessionArtworkCache = {};
  persistTracks();
  renderTracks();
  if (_currentTrack && _currentTrack.id === track.id) updateNowPlaying();
  showToast('Cover style: ' + getCoverStyleName(track.coverStyle));
}
