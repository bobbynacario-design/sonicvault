// The upload studio: the pending batch, its per-track editor, and saving
// the batch through Cloudinary into the vault.

var CLOUDINARY_CLOUD_NAME = 'dtw4em0ob';
var CLOUDINARY_UPLOAD_PRESET = 'sonicvault_web';

async function uploadToCloudinary(file, onProgress) {
  var formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  formData.append('resource_type', 'auto');
  formData.append('folder', 'sonicvault-bob/audio');

  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD_NAME + '/auto/upload');

    xhr.upload.addEventListener('progress', function(e) {
      if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
    });

    xhr.addEventListener('load', function() {
      if (xhr.status === 200) {
        var data = JSON.parse(xhr.responseText);
        resolve(data.secure_url);
      } else {
        reject(new Error('Upload failed: ' + xhr.status));
      }
    });

    xhr.addEventListener('error', function() {
      reject(new Error('Upload network error'));
    });

    xhr.send(formData);
  });
}

var _pendingUploads = [];
var _uploadFocusId = '';
var _isSavingUploads = false;
var _uploadBatchTargetIds = [];

function getUploadDraftById(id) {
  return _pendingUploads.find(function(item) { return item.id === id; }) || null;
}

function getFocusedUploadDraft() {
  return getUploadDraftById(_uploadFocusId) || _pendingUploads[0] || null;
}

function setUploadFocus(id) {
  if (!getUploadDraftById(id)) return;
  _uploadFocusId = id;
  renderPendingPreview();
  renderUploadQueue();
  renderUploadEditor();
}

function stepUploadFocus(delta) {
  if (!_pendingUploads.length) return;
  var currentIndex = _pendingUploads.findIndex(function(item) { return item.id === _uploadFocusId; });
  if (currentIndex === -1) currentIndex = 0;
  var nextIndex = Math.max(0, Math.min(_pendingUploads.length - 1, currentIndex + delta));
  setUploadFocus(_pendingUploads[nextIndex].id);
}

function getBatchDefaults() {
  return {
    genre: document.getElementById('batch-genre') ? document.getElementById('batch-genre').value : 'Other',
    mood: document.getElementById('batch-mood') ? document.getElementById('batch-mood').value : 'Dreamy',
    source: document.getElementById('batch-source') ? document.getElementById('batch-source').value : 'Suno'
  };
}

function makeUploadDraft(file) {
  var defaults = getBatchDefaults();
  var draft = {
    id: 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    file: file,
    objectURL: URL.createObjectURL(file),
    title: file.name.replace(/\.[^.]+$/, ''),
    genre: defaults.genre,
    mood: defaults.mood,
    source: defaults.source,
    prompt: '',
    lyrics: '',
    duration: 0,
    progress: 0,
    status: 'pending',
    error: '',
    aiTags: [],
    aiSummary: '',
    aiMood: '',
    aiGenre: '',
    aiTheme: '',
    aiEnergy: '',
    aiVocalStyle: '',
    aiEra: '',
    aiInstruments: [],
    aiExplicit: false,
    aiSource: '',
    aiMetadataVersion: 0,
    aiGeneratedAt: '',
    aiStatus: 'idle',
    aiError: '',
    aiDirty: false,
    genreEdited: false,
    moodEdited: false
  };
  draft.coverStyle = getCoverStyle(draft);
  return draft;
}

function probeUploadDraft(draft) {
  var tempAudio = new Audio();
  tempAudio.src = draft.objectURL;
  tempAudio.addEventListener('loadedmetadata', function() {
    draft.duration = tempAudio.duration || 0;
    renderPendingPreview();
    renderUploadQueue();
    renderUploadEditor();
  }, { once:true });
  tempAudio.addEventListener('error', function() {
    draft.duration = 0;
    renderPendingPreview();
    renderUploadQueue();
    renderUploadEditor();
  }, { once:true });
  decodeUploadPeaks(draft);
}

// Read the picked file while it is still in memory -- no Cloudinary
// round-trip needed after saving: the lyric sheet Suno embeds in its tag
// (filled in only when the lyrics box is still empty) and the waveform.
async function decodeUploadPeaks(draft) {
  if (!draft || !draft.file) return;
  var bufferData;
  try {
    bufferData = await draft.file.arrayBuffer();
  } catch (e) {
    return;
  }
  var embedded = findEmbeddedLyrics(new Uint8Array(bufferData));
  if (embedded && !getTrackLyrics(draft)) {
    draft.lyrics = embedded;
    renderUploadQueue();
    renderUploadEditor();
  }
  if (!(window.AudioContext || window.webkitAudioContext)) return;
  try {
    if (!_audioContext) _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var decoded = await _audioContext.decodeAudioData(bufferData);
    draft.loudness = extractWaveformLevels(decoded, 72);
    draft.lufs = measureLoudness(decoded);
  } catch (e) {
    console.warn('Upload waveform decode skipped for', draft && draft.id, e);
  }
}

function renderUploadProgress() {
  var wrap = document.getElementById('upload-progress');
  var bar = document.getElementById('upload-progress-bar');
  var pct = document.getElementById('upload-progress-pct');
  var copy = document.getElementById('upload-progress-copy');
  var stats = document.getElementById('upload-progress-stats');
  if (!wrap || !bar || !pct || !copy || !stats) return;

  if (!_pendingUploads.length && !_uploadBatchTargetIds.length) {
    wrap.style.display = 'none';
    bar.style.width = '0%';
    pct.textContent = '0%';
    stats.innerHTML = '';
    return;
  }

  var targetIds = _uploadBatchTargetIds.length ? _uploadBatchTargetIds.slice() : _pendingUploads.map(function(item) { return item.id; });
  var targetItems = targetIds.map(function(id) { return getUploadDraftById(id); }).filter(Boolean);
  var total = targetIds.length || 1;
  var sum = 0;
  targetItems.forEach(function(item) { sum += Number(item.progress || 0); });
  var overall = Math.round(sum / total);
  var doneCount = _pendingUploads.filter(function(item) { return item.status === 'done'; }).length;
  var errorCount = _pendingUploads.filter(function(item) { return item.status === 'error'; }).length;
  var active = _pendingUploads.find(function(item) { return item.status === 'uploading'; });

  wrap.style.display = 'block';
  bar.style.width = overall + '%';
  pct.textContent = overall + '%';
  copy.textContent = active ? ('Uploading "' + active.title + '" and writing its metadata into the vault.') : (_isSavingUploads ? 'Finishing the current batch and refreshing the library rails.' : 'Batch queued and ready to upload.');
  stats.innerHTML = ''
    + '<span class="upload-progress-stat">' + _pendingUploads.length + ' queued</span>'
    + '<span class="upload-progress-stat">' + doneCount + ' saved</span>'
    + '<span class="upload-progress-stat">' + errorCount + ' failed</span>';
}

function renderUploadQueue() {
  var el = document.getElementById('upload-queue-list');
  var summary = document.getElementById('upload-queue-summary');
  var saveBtn = document.getElementById('upload-save-all-btn');
  var clearBtn = document.getElementById('upload-clear-btn');
  if (!el || !summary || !saveBtn || !clearBtn) return;

  document.getElementById('upload-form').style.display = _pendingUploads.length ? 'block' : 'none';
  if (!_pendingUploads.length) {
    summary.textContent = 'Add a batch to start editing the queue.';
    saveBtn.textContent = 'Save all';
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    el.innerHTML = '<div class="pending-preview-empty">Your pending releases will appear here. Select one file or a whole export batch to start editing titles and metadata.</div>';
    return;
  }

  var readyCount = _pendingUploads.filter(function(item) { return item.status === 'pending' || item.status === 'error'; }).length;
  summary.textContent = _pendingUploads.length + ' track' + (_pendingUploads.length !== 1 ? 's' : '') + ' in queue. ' + readyCount + ' still need the save pass.';
  saveBtn.textContent = _isSavingUploads ? 'Uploading...' : 'Save all (' + readyCount + ')';
  saveBtn.disabled = _isSavingUploads || !readyCount;
  clearBtn.disabled = _isSavingUploads;

  el.innerHTML = _pendingUploads.map(function(item, index) {
    var statusLabel = item.status === 'done' ? 'Saved' : item.status === 'error' ? 'Retry' : item.status === 'uploading' ? 'Uploading' : 'Queued';
    var aiSourceLabel = getAIMetadataSourceLabel(item);
    var aiLabel = item.aiStatus === 'generating' ? 'Generating' : item.aiStatus === 'error' ? 'AI retry' : item.aiGeneratedAt ? ((aiSourceLabel || 'AI') + ' ready') : 'AI pending';
    return ''
      + '<div class="upload-queue-item' + (_uploadFocusId === item.id ? ' active' : '') + (item.status === 'done' ? ' done' : '') + (item.status === 'error' ? ' error' : '') + '" onclick="setUploadFocus(' + jsq(item.id) + ')">'
      +   buildCoverArt(item, 'xs', false)
      +   '<div class="upload-queue-main">'
      +     '<input class="form-input upload-queue-title-input" type="text" value="' + attr(item.title) + '" placeholder="Untitled release" ' + (_isSavingUploads ? 'disabled' : '') + ' onclick="event.stopPropagation()" onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('title') + ', this.value)">'
      +     '<div class="upload-queue-meta">' + esc(item.file.name) + ' / ' + formatFileSize(item.file.size) + ' / ' + (item.duration ? fmtTime(item.duration) : 'Length pending') + (item.error ? ' / ' + esc(item.error) : '') + '</div>'
      +     '<div class="upload-queue-pill-row"><span class="meta-pill highlight">' + esc(item.genre || 'Other') + '</span><span class="meta-pill">' + esc(item.mood || 'Mood') + '</span><span class="meta-pill">' + esc(item.source || 'Suno') + '</span><span class="upload-queue-status">' + statusLabel + '</span><span class="upload-queue-status">' + aiLabel + '</span></div>'
      +     (!hasLyrics(item) ? '<div class="upload-queue-alert">Lyrics required before this manual upload can be saved.</div>' : '')
      +     '<div class="upload-queue-progress"><div class="upload-queue-progress-fill" style="width:' + Math.round(item.progress || 0) + '%"></div></div>'
      +   '</div>'
      // The row stays clickable for pointers. Keyboard users get an explicit
      // Edit button rather than a focusable row wrapping a text input.
      +   '<div class="upload-queue-actions"><div class="upload-queue-status">#' + (index + 1) + '</div>'
      +     '<button class="queue-remove-btn" aria-pressed="' + (_uploadFocusId === item.id ? 'true' : 'false') + '" onclick="event.stopPropagation();setUploadFocus(' + jsq(item.id) + ')">' + (_uploadFocusId === item.id ? 'Editing' : 'Edit') + '</button>'
      +     '<button class="queue-remove-btn" ' + (_isSavingUploads ? 'disabled' : '') + ' onclick="event.stopPropagation();removePendingUpload(' + jsq(item.id) + ')">Remove</button>'
      +   '</div>'
      + '</div>';
  }).join('');
}

function renderUploadEditor() {
  var el = document.getElementById('upload-item-editor');
  if (!el) return;
  var item = getFocusedUploadDraft();
  if (!item) {
    el.innerHTML = '<div class="upload-editor-card"><div class="pending-preview-empty">Select a queued track to edit its title, lyrics, metadata, and AI notes.</div></div>';
    return;
  }

  var aiSourceLabel = getAIMetadataSourceLabel(item);
  var aiState = item.aiStatus === 'generating' ? 'Generating metadata...' : item.aiStatus === 'error' ? ('AI metadata failed: ' + esc(item.aiError || 'Unknown error')) : item.aiGeneratedAt ? ((aiSourceLabel || 'AI') + ' metadata generated ' + esc(new Date(item.aiGeneratedAt).toLocaleString())) : 'Generate metadata from title, prompt, and lyrics when you are ready.';
  var aiFacts = [item.aiTheme, item.aiEnergy, item.aiVocalStyle, item.aiEra].filter(Boolean);

  var lyricsBanner = !hasLyrics(item)
    ? '<div class="upload-lyrics-banner" role="alert">⚠ Lyrics required — paste the full lyric sheet below before this track can be saved to the vault.</div>'
    : '';

  el.innerHTML = ''
    + '<div class="upload-editor-card">'
    +   lyricsBanner
    +   '<div class="upload-editor-head"><div class="upload-editor-copy"><div class="section-kicker">Focused release</div><div class="section-title">' + esc(item.title || 'Untitled release') + '</div><div class="upload-editor-meta">' + esc(item.file.name) + ' / ' + formatFileSize(item.file.size) + ' / ' + (item.duration ? fmtTime(item.duration) : 'Length pending') + '</div></div><div class="upload-editor-nav"><button class="sec-action" onclick="stepUploadFocus(-1)"' + (_pendingUploads[0] && _pendingUploads[0].id === item.id ? ' disabled' : '') + '>Prev</button><button class="sec-action" onclick="stepUploadFocus(1)"' + (_pendingUploads[_pendingUploads.length - 1] && _pendingUploads[_pendingUploads.length - 1].id === item.id ? ' disabled' : '') + '>Next</button><div class="upload-queue-status">' + esc(item.status === 'done' ? 'Saved to vault' : item.status === 'error' ? 'Needs retry' : item.status === 'uploading' ? 'Uploading now' : 'Ready to save') + '</div></div></div>'
    +   buildCoverArt(item, 'md', true)
    +   '<div class="form-grid">'
    +     '<div class="form-group"><label class="form-label">Title</label><input class="form-input" type="text" value="' + attr(item.title) + '" ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('title') + ', this.value)"></div>'
    +     '<div class="form-group"><label class="form-label">Genre</label><select class="form-input" ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('genre') + ', this.value)">' + buildSelectOptions(['Synthwave','Lo-fi','Electronic','Ambient','Hip Hop','Rock','Pop','Folk','Jazz','Classical','R&B','Chiptune','Metal','Country','Other'], item.genre) + '</select></div>'
    +     '<div class="form-group"><label class="form-label">Mood</label><select class="form-input" ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('mood') + ', this.value)">' + buildSelectOptions(['Energetic','Chill','Intense','Dreamy','Warm','Playful','Melancholic','Uplifting','Dark'], item.mood) + '</select></div>'
    +     '<div class="form-group"><label class="form-label">Source</label><select class="form-input" ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('source') + ', this.value)">' + buildSelectOptions(['Suno','Lyria','Udio','Original','Other'], item.source) + '</select></div>'
    +     '<div class="form-group"><label class="form-label">Cover style</label><select class="form-input" ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('coverStyle') + ', this.value)">' + buildCoverStyleOptions(getCoverStyle(item)) + '</select></div>'
    +   '</div>'
    +   '<div class="form-group"><label class="form-label">Prompt / notes</label><textarea class="form-input" rows="6" placeholder="Optional notes for this specific release..." ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('prompt') + ', this.value)">' + esc(item.prompt || '') + '</textarea></div>'
    +   '<div class="form-group"><label class="form-label">Lyrics (required for manual uploads)</label><textarea class="form-input upload-lyrics-text" rows="10" placeholder="Paste the full lyric sheet you used before generating this song..." ' + (_isSavingUploads ? 'disabled' : '') + ' onchange="updateUploadDraftField(' + jsq(item.id) + ', ' + jsq('lyrics') + ', this.value)">' + esc(item.lyrics || '') + '</textarea>' + (!hasLyrics(item) ? '<div class="lyrics-status">Lyrics are required before save.</div>' : '') + '</div>'
    +   '<div class="upload-ai-card"><div class="section-kicker" style="margin-bottom:0">Metadata assist</div><div class="upload-ai-copy">' + aiState + '</div>' + (aiSourceLabel ? '<div class="ai-chip-row"><span class="ai-chip">' + esc(aiSourceLabel) + ' source</span></div>' : '') + (item.aiSummary ? '<div class="upload-ai-copy"><strong>Summary</strong> ' + esc(item.aiSummary) + '</div>' : '') + (item.aiTags && item.aiTags.length ? '<div class="ai-chip-row">' + item.aiTags.map(function(tag) { return '<span class="ai-chip">' + esc(tag) + '</span>'; }).join('') + '</div>' : '') + (aiFacts.length || (item.aiInstruments && item.aiInstruments.length) ? '<div class="upload-ai-meta">' + aiFacts.map(function(fact) { return '<span class="ai-chip">' + esc(fact) + '</span>'; }).join('') + (item.aiInstruments || []).map(function(inst) { return '<span class="ai-chip">' + esc(inst) + '</span>'; }).join('') + '</div>' : '') + '<div class="upload-batch-actions"><button class="sec-action" onclick="generateMetadataForUpload(' + jsq(item.id) + ')">' + (item.aiGeneratedAt ? 'Regenerate metadata' : 'Generate AI metadata') + '</button><button class="sec-action" onclick="acceptAIMetadata(' + jsq(item.id) + ')"' + (item.aiGeneratedAt ? '' : ' disabled') + '>Accept suggestions</button><button class="sec-action" onclick="keepManualMetadata(' + jsq(item.id) + ')">Keep my manual values</button></div></div>'
    + '</div>';
}

function buildSelectOptions(list, current) {
  return list.map(function(item) {
    return '<option value="' + attr(item) + '"' + (item === current ? ' selected' : '') + '>' + esc(item) + '</option>';
  }).join('');
}

function renderPendingPreview() {
  var el = document.getElementById('upload-preview');
  if (!el) return;
  updateAIConfigStatus();
  var item = getFocusedUploadDraft();
  if (!item) {
    el.innerHTML = '<div class="pending-preview-empty">Select one or more audio files to preview the generated cover identity before uploading. The batch studio adapts the art live from each title, genre, mood, source, prompt, and lyrics.</div>';
    renderUploadQueue();
    renderUploadEditor();
    renderUploadProgress();
    return;
  }

  var savedCount = _pendingUploads.filter(function(entry) { return entry.status === 'done'; }).length;
  el.innerHTML = '<div class="section-kicker">Pending release</div><div class="spotlight-card" style="grid-template-columns:110px minmax(0,1fr);padding:0;background:none;border:none">' + buildCoverArt(item, 'md', true) + '<div class="spotlight-meta"><div class="spotlight-title" style="font-size:26px">' + esc(item.title || 'Untitled release') + '</div><div class="spotlight-sub">' + esc(getTrackSummary(item) || getTrackPromptExcerpt(item, 140)) + '</div><div class="pill-row"><span class="meta-pill highlight">' + esc(item.genre || item.aiGenre || 'Other') + '</span><span class="meta-pill">' + esc(item.mood || item.aiMood || 'Mood') + '</span><span class="meta-pill">' + esc(item.source || 'Suno') + '</span><span class="meta-pill">' + (item.duration ? fmtTime(item.duration) : 'Length pending') + '</span>' + (!hasLyrics(item) ? '<span class="meta-pill" style="color:var(--danger);border-color:rgba(255,124,116,.3)">Lyrics required</span>' : '') + '</div>' + (item.aiTags && item.aiTags.length ? '<div class="ai-chip-row">' + item.aiTags.slice(0, 6).map(function(tag) { return '<span class="ai-chip">' + esc(tag) + '</span>'; }).join('') + '</div>' : '') + '<div class="track-stats"><span>' + _pendingUploads.length + ' in queue / ' + savedCount + ' saved</span><span>' + esc(item.file.name) + '</span></div></div></div>';
  renderUploadQueue();
  renderUploadEditor();
  renderUploadProgress();
}

function updateUploadDraftField(id, field, value) {
  var item = getUploadDraftById(id);
  if (!item || _isSavingUploads) return;
  item[field] = field === 'title' ? String(value || '') : value;
  if (field === 'title') item.title = item.title.trimStart();
  if (field === 'error') item.error = value;
  if (field === 'genre') item.genreEdited = true;
  if (field === 'mood') item.moodEdited = true;
  if (field === 'title' || field === 'prompt' || field === 'lyrics') item.aiDirty = true;
  renderPendingPreview();
}

function applyBatchField(field) {
  if (!_pendingUploads.length) {
    showToast('Add tracks to the queue first');
    return;
  }
  if (_isSavingUploads) return;
  var value = getBatchDefaults()[field];
  _pendingUploads.forEach(function(item) {
    if (item.status !== 'done') {
      item[field] = value;
      if (field === 'genre') item.genreEdited = true;
      if (field === 'mood') item.moodEdited = true;
    }
  });
  renderPendingPreview();
  showToast('Applied ' + field + ' to queued tracks');
}

function removePendingUpload(id) {
  if (_isSavingUploads) return;
  var item = getUploadDraftById(id);
  if (!item) return;
  if (item.objectURL) URL.revokeObjectURL(item.objectURL);
  _pendingUploads = _pendingUploads.filter(function(entry) { return entry.id !== id; });
  if (_uploadFocusId === id) _uploadFocusId = _pendingUploads[0] ? _pendingUploads[0].id : '';
  renderPendingPreview();
}

function handleFileUpload(files) {
  if (!files || !files.length) return;
  var list = Array.prototype.slice.call(files);
  var existing = {};
  _pendingUploads.forEach(function(item) {
    existing[item.file.name + '|' + item.file.size + '|' + item.file.lastModified] = 1;
  });

  var added = [];
  var skippedAudio = 0;
  var skippedSize = 0;
  var skippedDup = 0;

  list.forEach(function(file) {
    var key = file.name + '|' + file.size + '|' + file.lastModified;
    if (existing[key]) {
      skippedDup++;
      return;
    }
    if (!String(file.type || '').startsWith('audio/')) {
      skippedAudio++;
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      skippedSize++;
      return;
    }
    existing[key] = 1;
    var draft = makeUploadDraft(file);
    added.push(draft);
    probeUploadDraft(draft);
  });

  if (added.length) {
    _pendingUploads = _pendingUploads.concat(added);
    if (!_uploadFocusId) _uploadFocusId = added[0].id;
    document.getElementById('upload-form').style.display = 'block';
    renderPendingPreview();
  }

  var notes = [];
  if (added.length) notes.push(added.length + ' added');
  if (skippedAudio) notes.push(skippedAudio + ' not audio');
  if (skippedSize) notes.push(skippedSize + ' over 100MB');
  if (skippedDup) notes.push(skippedDup + ' duplicate');
  if (notes.length) showToast(notes.join(' / '));

  var picker = document.getElementById('file-picker');
  if (picker) picker.value = '';
}

function cancelUpload() {
  if (_isSavingUploads) return;
  _pendingUploads.forEach(function(item) {
    if (item.objectURL) URL.revokeObjectURL(item.objectURL);
  });
  _pendingUploads = [];
  _uploadFocusId = '';
  _uploadBatchTargetIds = [];
  document.getElementById('upload-form').style.display = 'none';
  document.getElementById('upload-progress').style.display = 'none';
  renderPendingPreview();
}

// The vault track for a draft whose file is now at audioURL. Also used by
// the Create page, whose songs are saved as drafts too. `offset` keeps ids
// apart within one batch.
function trackFromUploadDraft(item, audioURL, offset) {
  return {
    id: 't-' + (Date.now() + (offset || 0)),
    title: String(item.title || '').trim(),
    genre: item.genre || 'Other',
    mood: item.mood || 'Dreamy',
    source: item.source || 'Suno',
    coverStyle: getCoverStyle(item),
    prompt: item.prompt || '',
    lyrics: getTrackLyrics(item),
    audioURL: audioURL,
    duration: item.duration || 0,
    waveform: [],
    loudness: Array.isArray(item.loudness) && item.loudness.length ? item.loudness.slice() : [],
    lufs: isMeasuredLoudness(item.lufs) ? item.lufs : null,
    created: new Date().toISOString().split('T')[0],
    plays: 0,
    shared: false,
    fileSize: item.file.size,
    fileName: item.file.name,
    aiTags: sanitizeMetadataArray(item.aiTags, 10),
    aiSummary: item.aiSummary || '',
    aiMood: item.aiMood || '',
    aiGenre: item.aiGenre || '',
    aiTheme: item.aiTheme || '',
    aiEnergy: item.aiEnergy || '',
    aiVocalStyle: item.aiVocalStyle || '',
    aiEra: item.aiEra || '',
    aiInstruments: sanitizeMetadataArray(item.aiInstruments, 6),
    aiExplicit: !!item.aiExplicit,
    aiSource: item.aiSource || '',
    aiMetadataVersion: Number(item.aiMetadataVersion || 0),
    aiGeneratedAt: item.aiGeneratedAt || ''
  };
}

// New tracks go to the top of the vault, their waveforms (read from the
// file before upload) straight into the cache.
function addTracksToVault(createdTracks) {
  var wfCache = getWaveformCache();
  createdTracks.forEach(function(t) {
    if (Array.isArray(t.loudness) && t.loudness.length) {
      wfCache[t.id] = t.loudness.slice();
      invalidateVisualWaveform(t.id);
    }
  });
  saveWaveformCache();
  tracks = createdTracks.concat(tracks);
  persistTracks();
}

async function saveAllUploads() {
  var pending = _pendingUploads.filter(function(item) {
    return item.status === 'pending' || item.status === 'error';
  });
  if (!pending.length) {
    showToast('No queued tracks to save');
    return;
  }

  var missingTitle = pending.find(function(item) { return !String(item.title || '').trim(); });
  if (missingTitle) {
    _uploadFocusId = missingTitle.id;
    renderPendingPreview();
    showToast('Every queued track needs a title');
    return;
  }
  var missingLyrics = pending.find(function(item) { return !hasLyrics(item); });
  if (missingLyrics) {
    _uploadFocusId = missingLyrics.id;
    renderPendingPreview();
    showToast('Lyrics are required before manual uploads can be saved');
    return;
  }

  _isSavingUploads = true;
  _uploadBatchTargetIds = pending.map(function(item) { return item.id; });
  pending.forEach(function(item) {
    item.progress = 0;
    if (item.status !== 'done') item.status = 'pending';
    item.error = '';
  });
  renderPendingPreview();

  var createdTracks = [];
  for (var i = 0; i < pending.length; i++) {
    var item = pending[i];
    item.status = 'uploading';
    renderPendingPreview();

    try {
      var audioURL = await uploadToCloudinary(item.file, function(pct) {
        item.progress = pct;
        renderUploadQueue();
        renderUploadProgress();
      });

      item.progress = 100;
      item.status = 'done';
      createdTracks.push(trackFromUploadDraft(item, audioURL, i));
      renderPendingPreview();
    } catch (e) {
      console.error('Upload failed:', e);
      item.status = 'error';
      item.progress = 0;
      item.error = 'Upload failed';
      renderPendingPreview();
    }
  }

  if (createdTracks.length) addTracksToVault(createdTracks);

  var failedCount = _pendingUploads.filter(function(item) { return item.status === 'error'; }).length;
  var completedIds = {};
  _pendingUploads.filter(function(item) { return item.status === 'done'; }).forEach(function(item) {
    completedIds[item.id] = 1;
    if (item.objectURL) URL.revokeObjectURL(item.objectURL);
  });
  _pendingUploads = _pendingUploads.filter(function(item) { return !completedIds[item.id]; });
  _uploadFocusId = _pendingUploads[0] ? _pendingUploads[0].id : '';
  _isSavingUploads = false;
  _uploadBatchTargetIds = [];

  renderPendingPreview();
  window.refreshAll();

  if (createdTracks.length && !failedCount) {
    switchView('library');
    showToast(createdTracks.length + ' track' + (createdTracks.length !== 1 ? 's' : '') + ' saved');
  } else if (createdTracks.length && failedCount) {
    showToast(createdTracks.length + ' saved / ' + failedCount + ' failed');
  } else {
    showToast('Batch upload failed');
  }
}

var dropZone = document.getElementById('upload-drop');
if (dropZone) {
  dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', function() { dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files);
  });
}
