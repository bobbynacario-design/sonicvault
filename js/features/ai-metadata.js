// The AI metadata assist: the device-local endpoint config, the remote call,
// and generating, accepting, or declining suggestions for queued uploads.

var _aiConfig = loadLocalAIConfig();

function loadLocalAIConfig() {
  try {
    var saved = JSON.parse(localStorage.getItem('sv_ai_config') || '{}') || {};
    return {
      endpoint: String(saved.endpoint || '').trim(),
      token: String(saved.token || '').trim(),
      model: String(saved.model || '').trim()
    };
  } catch (e) {
    return { endpoint:'', token:'', model:'' };
  }
}

function persistLocalAIConfig() {
  localStorage.setItem('sv_ai_config', JSON.stringify({
    endpoint: String(_aiConfig.endpoint || '').trim(),
    token: String(_aiConfig.token || '').trim(),
    model: String(_aiConfig.model || '').trim()
  }));
}

function updateAIConfigField(field, value) {
  if (!_aiConfig) _aiConfig = { endpoint:'', token:'', model:'' };
  _aiConfig[field] = String(value || '').trim();
  persistLocalAIConfig();
  updateAIConfigStatus();
}

function hydrateAIConfigInputs() {
  var endpoint = document.getElementById('ai-endpoint');
  var token = document.getElementById('ai-token');
  var model = document.getElementById('ai-model');
  if (endpoint) endpoint.value = _aiConfig.endpoint || '';
  if (token) token.value = _aiConfig.token || '';
  if (model) model.value = _aiConfig.model || '';
}

function updateAIConfigStatus() {
  hydrateAIConfigInputs();
  var el = document.getElementById('upload-ai-status');
  if (!el) return;
  if (_aiConfig.endpoint) {
    var host = '';
    try { host = new URL(_aiConfig.endpoint).host; } catch (e) {}
    el.innerHTML = '<strong>Remote AI ready.</strong> Metadata requests will POST to ' + esc(host || _aiConfig.endpoint) + '. Token ' + (_aiConfig.token ? 'loaded' : 'missing') + '. The bearer token stays in this browser only and is never written into Firestore.';
  } else {
    el.innerHTML = '<strong>Local suggestion mode.</strong> SonicVault can still derive tags, mood, genre, and summaries from title, prompt, and lyrics. Add a secure endpoint if you want hosted AI generation.';
  }
}

async function requestRemoteAIMetadata(input, fallback) {
  if (!_aiConfig.endpoint) return fallback;
  var headers = { 'Content-Type':'application/json' };
  if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
  var response = await fetch(_aiConfig.endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      title: input.title || '',
      prompt: input.prompt || '',
      lyrics: input.lyrics || '',
      model: _aiConfig.model || '',
      fallback: fallback
    })
  });
  var text = '';
  var body = null;
  try {
    body = await response.json();
  } catch (e) {
    text = await response.text();
    body = parseJSONFromText(text);
  }
  if (!response.ok) throw new Error((body && body.error) || text || ('AI endpoint failed with ' + response.status));
  var payload = extractAIMetadataPayload(body);
  if (!payload) throw new Error('AI endpoint returned no metadata payload');
  return normalizeAIMetadata(payload, input);
}

async function generateMetadataForUpload(id, quiet) {
  var item = getUploadDraftById(id);
  if (!item || _isSavingUploads) return;
  if (!hasLyrics(item)) {
    _uploadFocusId = id;
    renderPendingPreview();
    showToast('Lyrics are required before generating metadata');
    return;
  }
  item.aiStatus = 'generating';
  item.aiError = '';
  renderPendingPreview();
  try {
    var input = getAIGenerationInput(item);
    var fallback = buildLocalMetadataSuggestion(input);
    var metadata = _aiConfig.endpoint ? await requestRemoteAIMetadata(input, fallback) : fallback;
    metadata.aiSource = _aiConfig.endpoint ? 'claude' : 'local';
    applyAIMetadataToDraft(item, metadata, false);
    renderPendingPreview();
    if (!quiet) showToast(_aiConfig.endpoint ? 'Claude metadata generated' : 'Local metadata suggestions generated');
  } catch (e) {
    item.aiStatus = 'error';
    item.aiError = e && e.message ? e.message : 'AI metadata failed';
    renderPendingPreview();
    if (!quiet) showToast('AI metadata failed. You can retry or save manually.');
  }
}

async function generateMetadataForAllPending() {
  if (_isSavingUploads) return;
  var items = _pendingUploads.filter(function(item) { return item.status !== 'done'; });
  if (!items.length) {
    showToast('No pending tracks in the queue');
    return;
  }
  var processed = 0;
  for (var i = 0; i < items.length; i++) {
    if (hasLyrics(items[i])) {
      processed++;
      await generateMetadataForUpload(items[i].id, true);
    }
  }
  showToast(processed ? 'Finished generating metadata for queued tracks with lyrics' : 'Add lyrics to queued tracks before generating metadata');
}

function acceptAIMetadata(id) {
  var item = getUploadDraftById(id);
  if (!item || !item.aiGeneratedAt) return;
  applyAIMetadataToDraft(item, item, true);
  item.genreEdited = false;
  item.moodEdited = false;
  renderPendingPreview();
  showToast('Applied AI suggestions to genre and mood');
}

function keepManualMetadata(id) {
  var item = getUploadDraftById(id);
  if (!item) return;
  item.genreEdited = true;
  item.moodEdited = true;
  renderPendingPreview();
  showToast('Keeping your manual genre and mood');
}

function applyBatchLyrics() {
  if (!_pendingUploads.length) {
    showToast('Add tracks to the queue first');
    return;
  }
  if (_isSavingUploads) return;
  var field = document.getElementById('batch-lyrics');
  var value = field ? String(field.value || '') : '';
  if (!value.trim()) {
    showToast('Paste lyrics first if you want to apply them in batch');
    return;
  }
  _pendingUploads.forEach(function(item) {
    if (item.status !== 'done') {
      item.lyrics = value;
      item.aiDirty = true;
    }
  });
  renderPendingPreview();
  showToast('Applied lyrics to queued tracks');
}
