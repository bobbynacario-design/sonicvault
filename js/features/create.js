// The Create page: describe a song, optionally have Claude write its lyrics,
// and Google's Lyria makes it through the AI worker (/generate, /lyrics,
// /cover -- see cloudflare-worker/worker.js). Each result is a take you can
// listen to here; saving one sends it through the same path as an imported
// file -- AI metadata, Cloudinary, the vault -- with its title, lyrics and
// cover written into the MP3's tag the way Suno's are.
//
// Takes live in this page's memory only: an unsaved take is gone on reload.
// The form itself is kept in localStorage as a per-device draft.

var CREATE_DRAFT_KEY = 'sv_create_draft';
var CREATE_TIMEOUT_MS = 5 * 60 * 1000;
// Starting points: a short label, and the fuller description it fills in.
var CREATE_IDEAS = [
  ['Dreamy synth-pop', 'Dreamy synth-pop with shimmering pads and airy female vocals, 100 BPM'],
  ['Acoustic folk', 'Warm acoustic folk, fingerpicked guitar, soft male vocals, around 90 BPM'],
  ['Lo-fi beat', 'Lo-fi hip hop beat with dusty vinyl crackle and mellow Rhodes, 82 BPM. Instrumental only'],
  ['Cinematic', 'Cinematic orchestral build, solo piano into sweeping strings'],
  ['Funk singalong', 'Upbeat funk with slap bass, tight horns and a big singalong chorus'],
  ['Dark synthwave', 'Dark synthwave in D minor, analog arpeggios and heavy bass, 110 BPM']
];

var _createTakes = [];
var _createReady = { key:'', state:'' };
var _createHydrated = false;
var _createDraftTimer = null;
var _createLyricsUndo = null;
var _createTicker = null;
var _createPreview = new Audio();
var _createPreviewId = '';

function createField(id) {
  return document.getElementById('create-' + id);
}

function getCreateInput() {
  return {
    title: String(createField('title') && createField('title').value || '').trim(),
    style: String(createField('style') && createField('style').value || '').trim(),
    lyrics: String(createField('lyrics') && createField('lyrics').value || '').trim(),
    instrumental: !!(createField('instrumental') && createField('instrumental').checked)
  };
}

function getTake(id) {
  return _createTakes.find(function(take) { return take.id === id; }) || null;
}

function workerRequest(path, body, signal) {
  var headers = { 'Content-Type':'application/json' };
  if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
  return fetch(new URL(path, _aiConfig.endpoint).toString(), {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body || {}),
    signal: signal
  });
}

async function workerError(response) {
  var data = await response.json().catch(function() { return null; });
  return (data && data.error) || ('The worker answered ' + response.status + '.');
}

// ─── The form ────────────────────────────────────────────────────────────────

function loadCreateDraft() {
  try { return JSON.parse(localStorage.getItem(CREATE_DRAFT_KEY) || 'null') || {}; } catch (e) { return {}; }
}

function saveCreateDraft() {
  clearTimeout(_createDraftTimer);
  _createDraftTimer = setTimeout(function() {
    try { localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(getCreateInput())); } catch (e) {}
  }, 300);
}

function hydrateCreateForm() {
  if (_createHydrated) return;
  _createHydrated = true;
  var draft = loadCreateDraft();
  ['title', 'style', 'lyrics'].forEach(function(key) {
    if (createField(key) && typeof draft[key] === 'string') createField(key).value = draft[key];
  });
  if (createField('instrumental')) createField('instrumental').checked = draft.instrumental === true;
  syncCreateForm();
}

// Ideas show only while the sound is undescribed, so picking one never
// replaces what someone wrote. Instrumental puts the lyrics aside.
function syncCreateForm() {
  var input = getCreateInput();
  var ideas = document.getElementById('create-ideas');
  if (ideas) {
    ideas.hidden = !!input.style;
    if (!ideas.innerHTML) {
      ideas.innerHTML = '<span class="create-ideas-label">Start from</span>' + CREATE_IDEAS.map(function(idea, i) {
        return '<button type="button" class="create-idea" title="' + attr(idea[1]) + '" onclick="useCreateIdea(' + i + ')">' + esc(idea[0]) + '</button>';
      }).join('');
    }
  }
  var lyrics = createField('lyrics');
  if (lyrics) lyrics.disabled = input.instrumental;
  var write = createField('write-btn');
  if (write && !write.classList.contains('is-busy')) write.disabled = input.instrumental;
  var lyricsGroup = document.getElementById('create-lyrics-group');
  if (lyricsGroup) lyricsGroup.classList.toggle('is-off', input.instrumental);
}

// Editing after Claude wrote the lyrics makes them yours: the Undo goes.
function onCreateInput() {
  if (_createLyricsUndo) {
    _createLyricsUndo = null;
    setCreateStatus('');
  }
  syncCreateForm();
  saveCreateDraft();
}

function useCreateIdea(index) {
  var field = createField('style');
  if (!field || !CREATE_IDEAS[index]) return;
  field.value = CREATE_IDEAS[index][1];
  field.focus();
  onCreateInput();
}

function setCreateStatus(html) {
  var el = document.getElementById('create-status');
  if (el) el.innerHTML = html || '';
}

// ─── Is the worker ready to make songs? ──────────────────────────────────────

// An empty /generate request makes nothing: the worker answers 501 without
// a Gemini key and 400 with one, so the reply says which. Asked once per
// worker and token.
async function checkCreateReady() {
  var key = _aiConfig.endpoint + '|' + _aiConfig.token;
  if (!_aiConfig.endpoint) {
    _createReady = { key:key, state:'no-worker' };
    renderCreateSetup();
    return;
  }
  if (_createReady.key === key && _createReady.state && _createReady.state !== 'offline') return;
  _createReady = { key:key, state:'checking' };
  var state;
  try {
    var response = await workerRequest('/generate', {});
    var error = await workerError(response);
    if (response.status === 400 && /describe/i.test(error)) state = 'ready';
    else if (response.status === 501) state = 'no-key';
    else if (response.status === 400) state = 'outdated';
    else if (response.status === 401) state = 'unauthorized';
    else if (response.status === 403) state = 'origin';
    else state = 'unknown';
  } catch (e) {
    state = 'offline';
  }
  if (_createReady.key === key) _createReady.state = state;
  renderCreateSetup();
}

function openAIWorkerSettings() {
  switchView('upload');
  setTimeout(function() {
    var card = document.getElementById('ai-worker-card');
    if (card) card.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block:'start' });
  }, 60);
}

function renderCreateSetup() {
  var el = document.getElementById('create-setup');
  var btn = createField('generate-btn');
  if (!el) return;
  var state = _createReady.state;
  var settings = ' <button type="button" class="create-setup-link" onclick="openAIWorkerSettings()">Open AI worker settings</button>';
  var messages = {
    'no-worker': '<strong>Connect the AI worker first.</strong> Songs are made through it, with your keys kept off this page.' + settings,
    'no-key': '<strong>One step left: give the worker a Gemini API key.</strong> Create one in Google AI Studio with billing turned on, then run <code>npx wrangler secret put GEMINI_API_KEY</code> in <code>cloudflare-worker/</code>.',
    'outdated': '<strong>The worker needs redeploying</strong> before it can make songs. Run <code>npx wrangler deploy</code> in <code>cloudflare-worker/</code>.',
    'unauthorized': '<strong>The worker refused this browser’s token.</strong>' + settings,
    'origin': '<strong>The worker doesn’t accept requests from this site.</strong> Add this address to ALLOWED_ORIGIN in wrangler.toml.'
  };
  var message = messages[state] || '';
  el.innerHTML = message;
  el.hidden = !message;
  if (btn && !btn.classList.contains('is-busy')) btn.disabled = !!message;
  var write = createField('write-btn');
  if (write && !write.classList.contains('is-busy')) write.disabled = !_aiConfig.endpoint || getCreateInput().instrumental;
}

// ─── Lyrics by Claude ────────────────────────────────────────────────────────

async function writeLyricsWithClaude() {
  var btn = createField('write-btn');
  var input = getCreateInput();
  if (!_aiConfig.endpoint) { renderCreateSetup(); return; }
  if (!input.title && !input.style && !input.lyrics) {
    setCreateStatus('Give the song a title or describe its sound first, so Claude knows what to write about.');
    return;
  }
  btn.classList.add('is-busy');
  btn.disabled = true;
  btn.textContent = 'Writing…';
  setCreateStatus(input.lyrics ? 'Claude is working from your draft…' : 'Claude is writing lyrics…');
  try {
    // Written in the songwriter's voice, from their own songs (js/data/song-lab.js),
    // on the worker's writing model rather than the tagging model in settings.
    var examples = pickSongLabExamples(tracks, new Date(), '', 5, songLabDrafts()).map(songLabExample);
    var response = await workerRequest('/lyrics', { title:input.title, style:input.style, draft:input.lyrics, examples:examples });
    if (!response.ok) throw new Error(await workerError(response));
    var data = await response.json();
    if (!data || !data.lyrics) throw new Error('Claude returned no lyrics.');
    _createLyricsUndo = { lyrics:createField('lyrics').value, title:createField('title').value };
    createField('lyrics').value = data.lyrics;
    if (!input.title && data.title) createField('title').value = data.title;
    syncCreateForm();
    saveCreateDraft();
    setCreateStatus('Claude wrote these lyrics. Edit them freely. <button type="button" class="create-setup-link" onclick="undoClaudeLyrics()">Undo</button>');
  } catch (e) {
    setCreateStatus('<strong>Couldn’t write lyrics.</strong> ' + esc(e && e.message || 'Try again.'));
  }
  btn.classList.remove('is-busy');
  btn.textContent = 'Write with Claude';
  btn.disabled = getCreateInput().instrumental;
}

function undoClaudeLyrics() {
  if (!_createLyricsUndo) return;
  createField('lyrics').value = _createLyricsUndo.lyrics;
  createField('title').value = _createLyricsUndo.title;
  _createLyricsUndo = null;
  syncCreateForm();
  saveCreateDraft();
  setCreateStatus('');
}

// ─── Making a song ───────────────────────────────────────────────────────────

// FLUX draws at 1024px; covers are shown at most a few hundred pixels wide
// and are read from the head of the file, so they are kept small.
async function shrinkCover(bytes) {
  try {
    var bitmap = await createImageBitmap(new Blob([bytes], { type:'image/jpeg' }));
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 640;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 640, 640);
    if (bitmap.close) bitmap.close();
    var blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.86); });
    if (!blob) throw new Error('no blob');
    return { mime:'image/jpeg', data:new Uint8Array(await blob.arrayBuffer()) };
  } catch (e) {
    return { mime:sniffImageMime(bytes) || 'image/jpeg', data:bytes };
  }
}

async function requestCover(take) {
  try {
    var response = await workerRequest('/cover', { title:take.title, style:take.style });
    if (!response.ok) return null;
    var data = await response.json();
    if (!data || !data.image) return null;
    return await shrinkCover(base64ToBytes(data.image));
  } catch (e) {
    return null;
  }
}

async function generateSong() {
  var input = getCreateInput();
  var btn = createField('generate-btn');
  if (!_aiConfig.endpoint) { checkCreateReady(); return; }
  if (!input.style && !(input.lyrics && !input.instrumental)) {
    setCreateStatus('Describe the sound you want first.');
    if (createField('style')) createField('style').focus();
    return;
  }
  setCreateStatus('');
  var take = {
    id: 'take-' + Date.now(),
    title: input.title,
    style: input.style,
    lyrics: input.instrumental ? '' : input.lyrics,
    instrumental: input.instrumental,
    status: 'generating',
    startedAt: Date.now(),
    error: ''
  };
  _createTakes.unshift(take);
  renderTakes();
  startCreateTicker();
  var takesCard = document.getElementById('create-takes-card');
  if (takesCard) takesCard.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block:'start' });

  // The cover is drawn while the song is made; a song without one keeps
  // its generated cover.
  var coverPromise = requestCover(take);
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function() { if (controller) controller.abort(); }, CREATE_TIMEOUT_MS);
  try {
    var response = await workerRequest('/generate', {
      title: take.title,
      style: take.style,
      lyrics: take.lyrics,
      instrumental: take.instrumental
    }, controller ? controller.signal : undefined);
    if (!response.ok) throw new Error(await workerError(response));
    var result = readLyriaResponse(await response.json());
    if (!result.audio) throw new Error(describeLyriaRefusal(result.reason));
    var bytes = base64ToBytes(result.audio.data);
    take.texts = result.texts;
    take.mime = looksLikeMP3(bytes) ? 'audio/mpeg' : result.audio.mime;
    take.audio = bytes;
    if (!take.instrumental) take.lyrics = take.lyrics || lyricsFromLyriaText(result.texts);
    take.title = deriveSongTitle(take.title, take.lyrics, take.style);
    take.objectURL = URL.createObjectURL(new Blob([bytes], { type:take.mime }));
    take.cover = await coverPromise;
    if (take.cover) take.coverURL = URL.createObjectURL(new Blob([take.cover.data], { type:take.cover.mime }));
    take.status = 'ready';
    probeTakeDuration(take);
  } catch (e) {
    take.status = 'error';
    take.error = e && e.name === 'AbortError'
      ? 'Lyria took longer than five minutes, so SonicVault stopped waiting. Try again.'
      : (e && e.message) || 'Something went wrong. Try again.';
  }
  clearTimeout(timer);
  renderTakes();
}

function probeTakeDuration(take) {
  var probe = new Audio();
  probe.preload = 'metadata';
  probe.src = take.objectURL;
  probe.addEventListener('loadedmetadata', function() {
    take.duration = isFinite(probe.duration) ? probe.duration : 0;
    renderTakes();
  }, { once:true });
}

function retryTake(id) {
  var take = getTake(id);
  if (!take) return;
  if (createField('title')) createField('title').value = take.title;
  if (createField('style')) createField('style').value = take.style;
  if (createField('lyrics')) createField('lyrics').value = take.lyrics;
  if (createField('instrumental')) createField('instrumental').checked = take.instrumental;
  discardTake(id);
  syncCreateForm();
  saveCreateDraft();
  generateSong();
}

// One timer for every take still being made: their elapsed clocks tick
// without re-rendering the list.
function startCreateTicker() {
  if (_createTicker) return;
  _createTicker = setInterval(function() {
    var busy = _createTakes.filter(function(take) { return take.status === 'generating'; });
    if (!busy.length) {
      clearInterval(_createTicker);
      _createTicker = null;
      return;
    }
    busy.forEach(function(take) {
      var el = document.querySelector('[data-take-elapsed="' + take.id + '"]');
      if (el) el.textContent = fmtTime((Date.now() - take.startedAt) / 1000);
    });
  }, 1000);
}

// ─── Listening ───────────────────────────────────────────────────────────────

function toggleTakePreview(id) {
  var take = getTake(id);
  if (!take || !take.objectURL) return;
  if (_createPreviewId === id && !_createPreview.paused) {
    _createPreview.pause();
    return;
  }
  if (_isPlaying) togglePlayback();
  if (_createPreviewId !== id) {
    _createPreviewId = id;
    _createPreview.src = take.objectURL;
  }
  _createPreview.play().catch(function() { showToast('Playback failed in this browser'); });
}

function stopTakePreview() {
  if (!_createPreview.paused) _createPreview.pause();
}

function seekTake(event, id) {
  var take = getTake(id);
  if (!take || _createPreviewId !== id || !_createPreview.duration) return;
  var rect = event.currentTarget.getBoundingClientRect();
  _createPreview.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * _createPreview.duration;
}

function paintTakePreview() {
  _createTakes.forEach(function(take) {
    var active = take.id === _createPreviewId;
    var playing = active && !_createPreview.paused;
    var btn = document.querySelector('[data-take-play="' + take.id + '"]');
    if (btn) setPlayButton(btn, playing);
    var fill = document.querySelector('[data-take-fill="' + take.id + '"]');
    var duration = (active && _createPreview.duration) || take.duration || 0;
    var at = active ? _createPreview.currentTime : 0;
    if (fill) fill.style.width = (duration ? Math.min(100, at / duration * 100) : 0) + '%';
    var time = document.querySelector('[data-take-time="' + take.id + '"]');
    if (time) time.textContent = fmtTime(at) + ' / ' + (duration ? fmtTime(duration) : '--:--');
  });
}

['play', 'pause', 'timeupdate', 'ended', 'loadedmetadata'].forEach(function(name) {
  _createPreview.addEventListener(name, paintTakePreview);
});
// The vault's player and a take never play over each other.
_audio.addEventListener('play', stopTakePreview);

// ─── Keeping a take ──────────────────────────────────────────────────────────

// Kept as typed, so a re-render while someone is typing (another take
// finishing) does not undo it; an emptied title falls back when saved.
function renameTake(id, value) {
  var take = getTake(id);
  if (take) take.title = String(value || '').trim();
}

// The same path as an imported file: the waveform read from the bytes, AI
// metadata from Claude (or local suggestions), the upload, and the vault.
async function saveTake(id) {
  var take = getTake(id);
  if (!take || take.status !== 'ready') return;
  take.title = deriveSongTitle(take.title, take.lyrics, take.style);
  take.status = 'saving';
  take.stage = 'Tagging';
  take.progress = 0;
  take.error = '';
  renderTakes();
  var draft = null;
  try {
    var tagged = looksLikeMP3(take.audio)
      ? writeSongTag(take.audio, { title:take.title, lyrics:take.lyrics, cover:take.cover })
      : take.audio;
    var file = new File([tagged], songFileName(take.title), { type:take.mime || 'audio/mpeg' });
    draft = makeUploadDraft(file);
    // Not the Import page's batch defaults (Synthwave, Energetic): the AI,
    // or the local tagger reading the description, decides.
    draft.genre = 'Other';
    draft.mood = 'Dreamy';
    draft.title = take.title;
    draft.prompt = take.style;
    draft.lyrics = take.lyrics;
    draft.source = 'Lyria';
    draft.duration = take.duration || 0;
    await decodeUploadPeaks(draft);

    take.stage = 'Describing';
    renderTakes();
    var input = getAIGenerationInput(draft);
    var fallback = buildLocalMetadataSuggestion(input);
    var metadata;
    try {
      metadata = _aiConfig.endpoint ? await requestRemoteAIMetadata(input, fallback) : fallback;
      metadata.aiSource = _aiConfig.endpoint ? 'claude' : 'local';
    } catch (e) {
      metadata = fallback;
      metadata.aiSource = 'local';
    }
    applyAIMetadataToDraft(draft, metadata, true);

    take.stage = 'Uploading';
    renderTakes();
    var audioURL = await uploadToCloudinary(file, function(pct) {
      take.progress = pct;
      var label = document.querySelector('[data-take-stage="' + take.id + '"]');
      if (label) label.textContent = 'Uploading ' + Math.round(pct) + '%';
    });
    var track = trackFromUploadDraft(draft, audioURL, 0);
    addTracksToVault([track]);
    if (take.cover) rememberTrackArt(track, take.cover, !!track.lyrics).catch(function() {});
    take.status = 'saved';
    take.trackId = track.id;
    window.refreshAll();
    showToast('“' + track.title + '” is in your vault');
  } catch (e) {
    console.error('Saving take failed:', e);
    take.status = 'ready';
    take.error = 'Couldn’t save it: ' + ((e && e.message) || 'try again') + '.';
  }
  if (draft && draft.objectURL) URL.revokeObjectURL(draft.objectURL);
  renderTakes();
}

function discardTake(id) {
  var take = getTake(id);
  if (!take || take.status === 'saving') return;
  if (_createPreviewId === id) {
    _createPreview.pause();
    _createPreview.removeAttribute('src');
    _createPreviewId = '';
  }
  if (take.objectURL) URL.revokeObjectURL(take.objectURL);
  if (take.coverURL) URL.revokeObjectURL(take.coverURL);
  _createTakes = _createTakes.filter(function(item) { return item.id !== id; });
  renderTakes();
}

function playSavedTake(id) {
  var take = getTake(id);
  if (!take || !take.trackId) return;
  stopTakePreview();
  playTrack(take.trackId);
}

function hasUnsavedTakes() {
  return _createTakes.some(function(take) {
    return take.status === 'generating' || take.status === 'ready' || take.status === 'saving';
  });
}

window.addEventListener('beforeunload', function(event) {
  if (!hasUnsavedTakes()) return;
  event.preventDefault();
  event.returnValue = '';
});

// ─── Rendering ───────────────────────────────────────────────────────────────

function takeCoverHTML(take) {
  if (take.coverURL) {
    return '<div class="cover-art cover-sm has-art create-take-cover"><img class="cover-img" src="' + attr(take.coverURL) + '" alt=""></div>';
  }
  return '<div class="create-take-cover">' + buildCoverArt({ title:take.title || take.style || 'New song', genre:'Other', mood:'Dreamy', source:'Lyria' }, 'sm', true) + '</div>';
}

function takeHTML(take) {
  var title = take.title || deriveSongTitle('', take.lyrics, take.style);
  var sub = take.instrumental ? 'Instrumental' + (take.style ? ' · ' + take.style : '') : take.style;
  var body = '';
  var actions = '';
  if (take.status === 'generating') {
    body = '<div class="create-take-making"><span class="create-take-pulse" aria-hidden="true"></span>Making your song <span class="create-take-elapsed" data-take-elapsed="' + attr(take.id) + '">' + fmtTime((Date.now() - take.startedAt) / 1000) + '</span></div>';
  } else if (take.status === 'error') {
    body = '<div class="create-take-error" role="alert">' + esc(take.error) + '</div>';
    actions = '<button type="button" class="sec-action" onclick="retryTake(' + jsq(take.id) + ')">Try again</button>'
      + '<button type="button" class="sec-action" onclick="discardTake(' + jsq(take.id) + ')">Dismiss</button>';
  } else {
    body = '<div class="create-take-player">'
      + '<button type="button" class="create-take-play" data-take-play="' + attr(take.id) + '" onclick="toggleTakePreview(' + jsq(take.id) + ')" aria-label="Play">' + icon('play') + '</button>'
      + '<div class="create-take-scrub" onclick="seekTake(event, ' + jsq(take.id) + ')"><div class="create-take-fill" data-take-fill="' + attr(take.id) + '"></div></div>'
      + '<span class="create-take-time" data-take-time="' + attr(take.id) + '">0:00 / ' + (take.duration ? fmtTime(take.duration) : '--:--') + '</span>'
      + '</div>'
      + (take.error ? '<div class="create-take-error" role="alert">' + esc(take.error) + '</div>' : '')
      + (take.lyrics ? '<details class="create-take-lyrics"><summary>Lyrics</summary><div class="create-take-lyrics-text">' + esc(take.lyrics) + '</div></details>' : '');
    if (take.status === 'ready') {
      actions = '<button type="button" class="sec-action primary" onclick="saveTake(' + jsq(take.id) + ')">Save to vault</button>'
        + '<button type="button" class="sec-action" onclick="discardTake(' + jsq(take.id) + ')">Discard</button>';
    } else if (take.status === 'saving') {
      actions = '<span class="create-take-stage" data-take-stage="' + attr(take.id) + '">' + esc(take.stage === 'Uploading' ? 'Uploading ' + Math.round(take.progress || 0) + '%' : take.stage + '…') + '</span>';
    } else if (take.status === 'saved') {
      actions = '<span class="create-take-saved">Saved</span>'
        + '<button type="button" class="sec-action" onclick="playSavedTake(' + jsq(take.id) + ')">Play in vault</button>';
    }
  }
  var titleHTML = take.status === 'ready'
    ? '<input class="create-take-title-input" type="text" maxlength="120" value="' + attr(title) + '" aria-label="Song title" oninput="renameTake(' + jsq(take.id) + ', this.value)">'
    : '<div class="create-take-title">' + esc(title) + '</div>';
  return ''
    + '<article class="create-take is-' + take.status + '">'
    +   takeCoverHTML(take)
    +   '<div class="create-take-main">'
    +     titleHTML
    +     (sub ? '<div class="create-take-sub">' + esc(trimText(sub, 140)) + '</div>' : '')
    +     body
    +   '</div>'
    +   (actions ? '<div class="create-take-actions">' + actions + '</div>' : '')
    + '</article>';
}

function renderTakes() {
  var card = document.getElementById('create-takes-card');
  var list = document.getElementById('create-takes');
  if (!card || !list) return;
  card.hidden = !_createTakes.length;
  list.innerHTML = _createTakes.map(takeHTML).join('');
  paintTakePreview();
  var btn = createField('generate-btn');
  var busy = _createTakes.some(function(take) { return take.status === 'generating'; });
  if (btn) btn.textContent = busy ? 'Make another' : 'Make the song';
}

function renderCreate() {
  renderSongLab();
  hydrateCreateForm();
  renderTakes();
  renderCreateSetup();
  checkCreateReady();
}
