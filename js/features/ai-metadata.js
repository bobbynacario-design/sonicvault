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

// The field being typed in is left alone: rewriting its value on every
// keystroke moved the caret to the end.
function hydrateAIConfigInputs() {
  ['endpoint', 'token', 'model'].forEach(function(field) {
    var input = document.getElementById('ai-' + field);
    if (input && input !== document.activeElement) input.value = _aiConfig[field] || '';
  });
}

function updateAIConfigStatus() {
  hydrateAIConfigInputs();
  var el = document.getElementById('upload-ai-status');
  if (!el) return;
  if (_aiConfig.endpoint) {
    var host = '';
    try { host = new URL(_aiConfig.endpoint).host; } catch (e) {}
    el.innerHTML = '<strong>Worker set:</strong> ' + esc(host || _aiConfig.endpoint) + '. ' + (_aiConfig.token
      ? 'Token saved in this browser (never synced). Use Test connection to check it.'
      : 'No access token yet, so the worker will refuse requests.');
  } else {
    el.innerHTML = '<strong>No worker set.</strong> Tags come from local suggestions and lyric timing is estimated. Paste the worker URL and its access token to turn both on.';
  }
}

// Checks the URL and token without running any AI: an empty request to
// /transcribe is refused for the missing audio only after the token has
// been accepted, so the status code says which part is wrong.
async function testAIWorker() {
  var el = document.getElementById('upload-ai-status');
  var btn = document.getElementById('ai-test-btn');
  if (!el) return;
  if (!_aiConfig.endpoint) {
    el.innerHTML = '<strong>No worker set.</strong> Paste the worker URL first.';
    return;
  }
  var url;
  try { url = new URL('/transcribe', _aiConfig.endpoint).toString(); } catch (e) {
    el.innerHTML = '<strong>That URL doesn\u2019t look right.</strong> It should start with https://';
    return;
  }
  if (btn) btn.disabled = true;
  el.innerHTML = 'Checking\u2026';
  var message;
  try {
    var headers = { 'Content-Type':'application/json' };
    if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
    var response = await fetch(url, { method:'POST', headers:headers, body:'{}' });
    var data = await response.json().catch(function() { return {}; });
    var error = String(data && data.error || '');
    if (response.status === 400 && /audioURL/i.test(error)) {
      message = '<strong>Connected.</strong> The token was accepted. New tracks will be tagged and lyrics timed through this worker.';
    } else if (response.status === 400 && /title/i.test(error)) {
      message = '<strong>Connected, but the worker is out of date.</strong> It can tag tracks but not time lyrics. Redeploy it from cloudflare-worker/.';
    } else if (response.status === 401) {
      message = '<strong>The worker refused this token.</strong> Check it matches the worker\u2019s SONICVAULT_CLIENT_TOKEN.';
    } else if (response.status === 403) {
      message = '<strong>The worker doesn\u2019t accept requests from this site.</strong> Add this address to ALLOWED_ORIGIN in wrangler.toml.';
    } else {
      message = '<strong>Unexpected answer (' + response.status + ').</strong> ' + esc(error || 'Is this the SonicVault worker URL?');
    }
  } catch (e) {
    message = '<strong>Couldn\u2019t reach the worker.</strong> Check the URL and your connection.';
  }
  if (btn) btn.disabled = false;
  el.innerHTML = message;
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
