// The edit-track dialog for tracks already in the vault, with the same AI
// metadata assist the upload editor uses.

var EDIT_GENRES = ['Synthwave','Lo-fi','Electronic','Ambient','Hip Hop','Rock','Pop','Folk','Jazz','Classical','R&B','Chiptune','Metal','Country','Other'];
var EDIT_MOODS = ['Energetic','Chill','Intense','Dreamy','Warm','Playful','Melancholic','Uplifting','Dark'];
var EDIT_SOURCES = ['Suno','Lyria','Udio','Original','Other'];
var _editingTrackId = '';
var _editTrackAI = null;

// Make sure the track's current value is selectable even if it isn't one of
// the canonical options (e.g. watcher imports with freeform genres).
function buildEditSelectOptions(list, current) {
  var options = list.slice();
  if (current && options.indexOf(current) === -1) options.unshift(current);
  return buildSelectOptions(options, current || options[0]);
}

// What the metadata panel says before anything is generated: the song's
// description, and -- in a browser without the AI worker -- that suggestions
// here come only from the song's own words.
function renderEditMetadataPanel(track) {
  var worker = !!_aiConfig.endpoint;
  var summary = getTrackSummary(track);
  document.getElementById('edit-ai-status').textContent = summary || (worker
    ? 'No description yet. Claude can write one from the title, prompt and lyrics.'
    : 'No description yet.');
  document.getElementById('edit-ai-facts').hidden = true;
  document.getElementById('edit-ai-chips').innerHTML = '';
  // Claude's description is never replaced by basic suggestions, so with it
  // in place and no worker here there is nothing useful to offer but the
  // way to connect.
  var keepsClaude = !worker && hasAIDescription(track);
  var connect = ' <button type="button" class="edit-ai-link" onclick="closeModal(\'modal-edit-track\'); openAIWorkerSettings();">Connect the AI worker</button>';
  var note = document.getElementById('edit-ai-note');
  note.hidden = worker;
  note.innerHTML = worker ? '' : keepsClaude
    ? 'This browser isn\u2019t connected to the AI worker, so it can\u2019t describe the song again.' + connect
    : 'This browser isn\u2019t connected to the AI worker, so suggestions come only from the song\u2019s own words, with no description.' + connect;
  var btn = document.getElementById('edit-ai-btn');
  btn.disabled = false;
  btn.hidden = keepsClaude;
  btn.textContent = worker ? (summary ? 'Describe again with Claude' : 'Describe with Claude') : 'Suggest from the lyrics';
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
  renderEditMetadataPanel(track);
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
  var worker = !!_aiConfig.endpoint;
  btn.disabled = true;
  statusEl.textContent = worker ? 'Claude is listening to the words\u2026' : 'Reading the words\u2026';
  try {
    var fallback = buildLocalMetadataSuggestion(input);
    var metadata = worker ? await requestRemoteAIMetadata(input, fallback) : fallback;
    metadata.aiSource = worker ? 'claude' : 'local';
    _editTrackAI = metadata;
    var coverSelect = document.getElementById('edit-cover-style');
    if (coverSelect && metadata.coverStyle) coverSelect.value = normalizeCoverStyle(metadata.coverStyle, track);
    statusEl.textContent = metadata.aiSummary || (worker
      ? 'Claude sent no description this time.'
      : 'Suggestions from the song\u2019s words. Save to keep them.');
    // The facts on one line, the tags as chips. The cover style is shown by
    // its own picker, so it is not a tag.
    var facts = [metadata.aiGenre, metadata.aiMood, metadata.aiEnergy ? metadata.aiEnergy + ' energy' : '', metadata.aiTheme].filter(Boolean);
    var factsEl = document.getElementById('edit-ai-facts');
    factsEl.textContent = facts.join(' \u00b7 ');
    factsEl.hidden = !facts.length;
    document.getElementById('edit-ai-chips').innerHTML = (metadata.aiTags || []).map(function(c) { return '<span class="ai-chip">' + esc(c) + '</span>'; }).join('');
    showToast(worker ? 'Claude described the song. Save to keep it.' : 'Suggestions ready. Save to keep them.');
  } catch (e) {
    statusEl.textContent = 'Couldn\u2019t describe the song: ' + (e && e.message ? e.message : 'unknown error');
    showToast('Describing the song failed. Save still works.');
  } finally {
    btn.disabled = false;
    btn.textContent = worker ? 'Describe again with Claude' : 'Suggest from the lyrics';
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
