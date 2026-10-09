// Song lab, at the top of the Create page: Claude drafts the next song in
// the songwriter's own voice -- learnt from the songs they play most
// (js/data/song-lab.js) -- as a style and a lyric sheet to paste into
// Suno's boxes, through the AI worker's /songlab. Drafts are kept with the
// vault's settings, so one written on the phone is there to paste on the
// computer, and each says when its song has arrived in the vault.

var SONG_LAB_FORM_KEY = 'sv_song_lab_form';
var SUNO_CREATE_URL = 'https://suno.com/create';
// changes: what is typed in each draft's change box, kept across the
// re-render every sync brings.
var _songLab = { busy:false, revising:'', status:'', hydrated:false, changes:{} };

function songLabDrafts() {
  var lab = appSettings && appSettings.songLab;
  return lab && Array.isArray(lab.drafts) ? lab.drafts : [];
}

function getSongLabDraft(id) {
  return songLabDrafts().filter(function(draft) { return draft.id === id; })[0] || null;
}

function saveSongLabDrafts(list) {
  appSettings = window.appSettings || appSettings || {};
  appSettings.songLab = Object.assign({}, appSettings.songLab, { drafts:list });
  window.appSettings = appSettings;
  save('settings', appSettings);
}

// ─── The form ────────────────────────────────────────────────────────────────

function getSongLabInput() {
  var idea = document.getElementById('lab-idea');
  var language = document.getElementById('lab-language');
  var seed = document.getElementById('lab-seed');
  return {
    idea:String(idea && idea.value || '').trim(),
    language:SONG_LAB_LANGUAGES.indexOf(language && language.value) !== -1 ? language.value : SONG_LAB_LANGUAGES[0],
    seed:String(seed && seed.value || '')
  };
}

function saveSongLabForm() {
  try { localStorage.setItem(SONG_LAB_FORM_KEY, JSON.stringify(getSongLabInput())); } catch (e) {}
  renderSongLabFrom();
}

// The "Sound like" list: the most loved songs first, one take of each.
function fillSongLabSeeds(selected) {
  var select = document.getElementById('lab-seed');
  if (!select) return;
  var songs = pickSongLabExamples(tracks, new Date(), '', 60);
  select.innerHTML = '<option value="">The songs I play most</option>'
    + (songs.length ? '<optgroup label="Or one song">' + songs.map(function(track) {
      return '<option value="' + attr(track.id) + '">' + esc(track.title || 'Untitled') + '</option>';
    }).join('') + '</optgroup>' : '');
  select.value = songs.some(function(track) { return track.id === selected; }) ? selected : '';
}

function hydrateSongLabForm() {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(SONG_LAB_FORM_KEY) || 'null') || {}; } catch (e) {}
  var language = document.getElementById('lab-language');
  if (language && !language.options.length) {
    language.innerHTML = SONG_LAB_LANGUAGES.map(function(name) {
      return '<option value="' + attr(name) + '">' + esc(name) + '</option>';
    }).join('');
  }
  if (!_songLab.hydrated) {
    _songLab.hydrated = true;
    var idea = document.getElementById('lab-idea');
    if (idea && typeof saved.idea === 'string') idea.value = saved.idea;
    if (language && SONG_LAB_LANGUAGES.indexOf(saved.language) !== -1) language.value = saved.language;
  }
  var seed = document.getElementById('lab-seed');
  fillSongLabSeeds(seed && seed.value ? seed.value : saved.seed);
}

// The songs Claude will learn from, named under the button.
function renderSongLabFrom() {
  var el = document.getElementById('lab-from');
  if (!el) return;
  var examples = pickSongLabExamples(tracks, new Date(), getSongLabInput().seed);
  el.textContent = examples.length
    ? 'Learning from ' + examples.map(function(track) { return '“' + (track.title || 'Untitled') + '”'; }).join(', ') + '.'
    : 'Songs with lyrics teach Claude your voice; until the vault has some, it writes from your idea alone.';
}

function setSongLabStatus(html) {
  _songLab.status = html || '';
  var el = document.getElementById('lab-status');
  if (el) el.innerHTML = _songLab.status;
}

// ─── Asking Claude ───────────────────────────────────────────────────────────

async function requestSongLabDraft(body, from) {
  var response = await workerRequest('/songlab', body);
  if (!response.ok) throw new Error(await workerError(response));
  var data = await response.json();
  if (!data || !data.lyrics) throw new Error('Claude returned no lyrics.');
  var draft = songLabDraft(data, { idea:body.idea, change:body.change, language:body.language, from:from }, new Date());
  saveSongLabDrafts(addSongLabDraft(songLabDrafts(), draft));
  return draft;
}

async function draftSongLab() {
  if (_songLab.busy) return;
  if (!_aiConfig.endpoint) { renderSongLab(); return; }
  var input = getSongLabInput();
  var examples = pickSongLabExamples(tracks, new Date(), input.seed);
  if (!examples.length && !input.idea) {
    setSongLabStatus('Say what the song is about first: the vault has no songs with lyrics to learn your voice from yet.');
    return;
  }
  _songLab.busy = true;
  renderSongLabButton();
  setSongLabStatus('Claude is reading ' + (examples.length ? examples.length + ' of your songs' : 'your idea') + ' and writing. This takes about half a minute.');
  try {
    var draft = await requestSongLabDraft({
      idea:input.idea,
      language:input.language,
      examples:examples.map(songLabExample)
    }, examples.map(function(track) { return track.title || 'Untitled'; }));
    setSongLabStatus('');
    renderSongLabDrafts(draft.id);
  } catch (e) {
    setSongLabStatus('<strong>Couldn’t write it.</strong> ' + esc(e && e.message || 'Try again.'));
  }
  _songLab.busy = false;
  renderSongLabButton();
}

// A change to a draft ("make the chorus catchier") comes back as a new
// draft on top; the one it came from stays below.
async function reviseSongLabDraft(id) {
  var draft = getSongLabDraft(id);
  var change = String(_songLab.changes[id] || '').trim();
  if (!draft || !change || _songLab.revising) return;
  _songLab.revising = id;
  renderSongLabDrafts(id);
  var examples = pickSongLabExamples(tracks, new Date(), '', 3);
  try {
    var next = await requestSongLabDraft({
      language:draft.language,
      idea:draft.idea,
      examples:examples.map(songLabExample),
      previous:{ title:draft.title, style:draft.style, lyrics:draft.lyrics },
      change:change
    }, draft.from);
    _songLab.revising = '';
    delete _songLab.changes[id];
    renderSongLabDrafts(next.id);
    showToast('Rewritten: “' + (next.title || 'Untitled') + '”');
  } catch (e) {
    _songLab.revising = '';
    renderSongLabDrafts(id);
    showToast('Couldn’t rewrite it: ' + ((e && e.message) || 'try again'));
  }
}

// ─── Using a draft ───────────────────────────────────────────────────────────

var SONG_LAB_FIELD_NAMES = { title:'title', style:'style', lyrics:'lyrics' };

// The clipboard API, else the older copy command, which some embedded
// browsers still allow when they refuse the API.
function copyText(text) {
  function copyCommand() {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(area);
    return ok;
  }
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(function(e) {
      if (!copyCommand()) throw e;
    });
  }
  return copyCommand() ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

// Copied for pasting into Suno; where nothing can copy, the text is
// selected instead, ready for the device's own Copy.
function copySongLabField(id, field) {
  var draft = getSongLabDraft(id);
  if (!draft || !SONG_LAB_FIELD_NAMES[field] || !draft[field]) return;
  copyText(draft[field]).then(function() {
    showToast('Copied the ' + SONG_LAB_FIELD_NAMES[field] + '. Paste it into Suno.');
  }).catch(function() {
    var box = document.querySelector('[data-lab-text="' + id + ':' + field + '"]');
    if (box && window.getSelection) {
      var range = document.createRange();
      range.selectNodeContents(box);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
    showToast(box ? 'Couldn’t copy here, so the ' + SONG_LAB_FIELD_NAMES[field] + ' is selected: copy it from there.' : 'Couldn’t copy here. Select the text and copy it instead.');
  });
}

// Into the Lyria form below, for when the Gemini key can make songs.
function useSongLabDraft(id) {
  var draft = getSongLabDraft(id);
  if (!draft) return;
  if (createField('title')) createField('title').value = draft.title;
  if (createField('style')) createField('style').value = draft.style;
  if (createField('lyrics')) createField('lyrics').value = draft.lyrics;
  if (createField('instrumental')) createField('instrumental').checked = false;
  syncCreateForm();
  saveCreateDraft();
  var form = document.getElementById('create-form');
  if (form) form.scrollIntoView({ behavior:motionAllowed() ? 'smooth' : 'auto', block:'start' });
}

function deleteSongLabDraft(id) {
  var draft = getSongLabDraft(id);
  if (!draft || !confirm('Delete the draft “' + (draft.title || 'Untitled') + '”?')) return;
  saveSongLabDrafts(songLabDrafts().filter(function(item) { return item.id !== id; }));
  renderSongLabDrafts();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderSongLabButton() {
  var btn = document.getElementById('lab-btn');
  if (!btn) return;
  btn.disabled = _songLab.busy || !_aiConfig.endpoint;
  btn.classList.toggle('is-busy', _songLab.busy);
  btn.textContent = _songLab.busy ? 'Writing…' : (songLabDrafts().length ? 'Draft another' : 'Draft my next song');
}

function songLabCount(draft, field) {
  var length = String(draft[field] || '').length;
  var over = length > SUNO_LIMITS[field];
  return '<span class="lab-count' + (over ? ' is-over' : '') + '"' + (over ? ' title="Longer than Suno takes"' : '') + '>'
    + length.toLocaleString() + ' / ' + SUNO_LIMITS[field].toLocaleString() + '</span>';
}

function songLabField(draft, field, label, body) {
  return '<div class="lab-field">'
    + '<div class="lab-field-head"><span class="lab-field-label">' + esc(label) + '</span>' + songLabCount(draft, field)
    + '<button type="button" class="sec-action" onclick="copySongLabField(' + jsq(draft.id) + ', ' + jsq(field) + ')">Copy</button></div>'
    + body
    + '</div>';
}

function songLabMeta(draft) {
  var when = '';
  var at = new Date(draft.at);
  if (!isNaN(at.getTime())) when = at.toLocaleDateString(undefined, { day:'numeric', month:'short' });
  return [draft.language && draft.language !== SONG_LAB_LANGUAGES[0] ? draft.language : '', when,
    draft.change ? 'changed: “' + trimText(draft.change, 60) + '”' : (draft.idea ? '“' + trimText(draft.idea, 60) + '”' : '')]
    .filter(Boolean).join(' · ');
}

function songLabDraftHTML(draft, open) {
  var made = songLabMadeAs(draft, tracks);
  var busy = _songLab.revising === draft.id;
  var badge = made
    ? '<button type="button" class="lab-made" onclick="playTrack(' + jsq(made.id) + ')">' + icon('play') + '<span>In your vault as “' + esc(made.title || 'Untitled') + '”</span></button>'
    : '';
  return '<details class="lab-draft"' + (open ? ' open' : '') + '>'
    + '<summary class="lab-draft-head">'
    +   '<span class="lab-draft-title">' + esc(draft.title || 'Untitled') + '</span>'
    +   '<span class="lab-draft-meta">' + esc(songLabMeta(draft)) + '</span>'
    + '</summary>'
    + '<div class="lab-draft-body">'
    +   badge
    +   (draft.about ? '<p class="lab-draft-about">' + esc(draft.about) + '</p>' : '')
    +   songLabField(draft, 'style', 'Style of Music', '<div class="lab-field-text" data-lab-text="' + attr(draft.id) + ':style">' + esc(draft.style || '') + '</div>')
    +   songLabField(draft, 'lyrics', 'Lyrics', '<div class="lab-field-text lab-lyrics" data-lab-text="' + attr(draft.id) + ':lyrics">' + esc(draft.lyrics) + '</div>')
    +   '<div class="lab-draft-actions">'
    +     '<a class="sec-action primary" href="' + SUNO_CREATE_URL + '" target="_blank" rel="noopener">Open Suno</a>'
    +     '<button type="button" class="sec-action" onclick="copySongLabField(' + jsq(draft.id) + ', \'title\')">Copy title</button>'
    +     '<button type="button" class="sec-action" onclick="useSongLabDraft(' + jsq(draft.id) + ')">Use with Lyria</button>'
    +     '<button type="button" class="sec-action" onclick="deleteSongLabDraft(' + jsq(draft.id) + ')">Delete</button>'
    +   '</div>'
    +   '<form class="pl-sentence-row lab-change" onsubmit="event.preventDefault(); reviseSongLabDraft(' + jsq(draft.id) + ')">'
    +     '<label class="sr-only" for="lab-change-' + attr(draft.id) + '">Ask for a change</label>'
    +     '<input type="text" id="lab-change-' + attr(draft.id) + '" maxlength="500" autocomplete="off" placeholder="Change something: a catchier chorus, more Bikol, a sadder ending"'
    +       ' value="' + attr(_songLab.changes[draft.id] || '') + '" oninput="_songLab.changes[' + jsq(draft.id) + '] = this.value"' + (busy ? ' disabled' : '') + '>'
    +     '<button type="submit" class="sec-action"' + (_songLab.revising ? ' disabled' : '') + '>' + (busy ? 'Rewriting…' : 'Rewrite') + '</button>'
    +   '</form>'
    + '</div>'
    + '</details>';
}

// The newest draft opens, or the one just written or being rewritten.
function renderSongLabDrafts(openId) {
  var el = document.getElementById('lab-drafts');
  if (!el) return;
  var drafts = songLabDrafts();
  var open = openId || (drafts[0] && drafts[0].id);
  el.innerHTML = drafts.length
    ? '<div class="lab-drafts-label">Your drafts</div>' + drafts.map(function(draft) { return songLabDraftHTML(draft, draft.id === open); }).join('')
    : '';
  renderSongLabButton();
}

function renderSongLab() {
  var setup = document.getElementById('lab-setup');
  if (!setup) return;
  var message = _aiConfig.endpoint ? '' : '<strong>Connect the AI worker first.</strong> Claude writes through it, with your keys kept off this page. <button type="button" class="create-setup-link" onclick="openAIWorkerSettings()">Open AI worker settings</button>';
  setup.innerHTML = message;
  setup.hidden = !message;
  hydrateSongLabForm();
  renderSongLabFrom();
  setSongLabStatus(_songLab.status);
  renderSongLabDrafts();
}
