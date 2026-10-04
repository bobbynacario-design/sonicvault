// Translate and explain: the Translate button in the lyrics card asks the
// AI worker's /translate (Claude) for each sung line in another language --
// shown under its original, so it stays timed to the music, in karaoke too
// -- and what the song is about, with notes on idioms and local references.
// Saved on the track as track.translation, so it is paid for once and
// syncs; editing the lyrics retires it.
//
// track.translation = { key: lyricSyncKey(lyrics), lang, from, same,
//                       lines: [one per sung line], about, notes: [{ line, note }], at }

var TRANSLATE_LANGUAGES = ['English', 'Filipino', 'Bikol', 'Cebuano', 'Spanish', 'Japanese', 'Korean', 'Chinese', 'French', 'German'];
var _translateOpen = '';      // id of the track showing its translation
var _translateJobs = {};      // track id -> language, while a request is out
var _translateFailed = {};    // track id -> reason, this page load

function translateLanguage() {
  var saved = '';
  try { saved = localStorage.getItem('sv_translate_lang') || ''; } catch (e) {}
  return TRANSLATE_LANGUAGES.indexOf(saved) !== -1 ? saved : 'English';
}

function translateEndpoint() {
  if (!_aiConfig || !_aiConfig.endpoint) return '';
  try { return new URL('/translate', _aiConfig.endpoint).toString(); } catch (e) { return ''; }
}

// The saved translation when it still belongs to these lyrics and this
// language. A shared song's visitors get whichever language was saved.
function getTranslation(track, lang) {
  var tr = track && track.translation;
  if (!tr || !hasLyrics(track) || tr.key !== lyricSyncKey(getTrackLyrics(track))) return null;
  if (getVaultTrack(track.id) && tr.lang !== (lang || translateLanguage())) return null;
  return tr;
}

// The translation the lyrics should show right now, or null.
function shownTranslation(track) {
  return track && _translateOpen === track.id ? getTranslation(track) : null;
}

function shownTranslationLines(track) {
  var tr = shownTranslation(track);
  return tr && !tr.same && Array.isArray(tr.lines) ? tr.lines : null;
}

function translateTrack() {
  if (!_currentTrack) return null;
  return getVaultTrack(_currentTrack.id) || (_currentTrack.translation ? _currentTrack : null);
}

function toggleTranslation() {
  var track = translateTrack();
  if (!track || !hasLyrics(track)) return;
  _translateOpen = _translateOpen === track.id ? '' : track.id;
  if (_translateOpen && typeof _sungCheckOpen !== 'undefined') _sungCheckOpen = '';
  if (_translateOpen && !getTranslation(track) && getVaultTrack(track.id) && translateEndpoint()) requestTranslation(track, translateLanguage());
  refreshTranslationViews();
}

function setTranslateLanguage(lang) {
  if (TRANSLATE_LANGUAGES.indexOf(lang) === -1) return;
  try { localStorage.setItem('sv_translate_lang', lang); } catch (e) {}
  var track = translateTrack();
  if (track && _translateOpen === track.id && !getTranslation(track) && translateEndpoint()) requestTranslation(track, lang);
  refreshTranslationViews();
}

async function requestTranslation(track, lang) {
  if (_translateJobs[track.id]) return;
  _translateJobs[track.id] = lang;
  delete _translateFailed[track.id];
  refreshTranslationViews();
  try {
    var lyrics = getTrackLyrics(track);
    var headers = { 'Content-Type':'application/json' };
    if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
    // No model: the worker translates with a stronger one than it describes songs with.
    var body = { title:track.title || '', lyrics:lyrics, lines:sungLyricLines(lyrics), language:lang };
    var response = await fetch(translateEndpoint(), { method:'POST', headers:headers, body:JSON.stringify(body) });
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.error || ('The worker answered ' + response.status + '.'));
    // The lyrics may have been edited while the request was out.
    if (getTrackLyrics(track) !== lyrics) return;
    track.translation = {
      key:lyricSyncKey(lyrics),
      lang:lang,
      from:String(data.from || ''),
      same:data.same === true,
      lines:Array.isArray(data.lines) ? data.lines.map(function(line) { return String(line || ''); }) : [],
      about:String(data.about || ''),
      notes:(Array.isArray(data.notes) ? data.notes : []).map(function(item) {
        return { line:Number(item.line) || 0, note:String(item.note || '') };
      }),
      at:new Date().toISOString()
    };
    persistTracks();
  } catch (e) {
    _translateFailed[track.id] = (e && e.message) || 'The translation failed.';
    console.warn('Translation skipped for', track.id, e);
  } finally {
    delete _translateJobs[track.id];
    refreshTranslationViews();
  }
}

// The lyrics (rebuilt with or without the translation under each line),
// the panel, the button, and karaoke if it is open.
function refreshTranslationViews() {
  if (typeof updateExpandedPlayer === 'function' && _currentTrack) updateExpandedPlayer();
  renderTranslatePanel();
  if (typeof renderSungCheck === 'function') renderSungCheck();
}

function renderTranslateButton() {
  var btn = document.getElementById('xp-translate-btn');
  if (!btn) return;
  var track = translateTrack();
  var can = !!(track && hasLyrics(track) && (track.translation || translateEndpoint()));
  var open = can && _translateOpen === track.id;
  btn.hidden = !can;
  btn.textContent = open ? 'Hide translation' : 'Translate';
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
}

// Above the lyrics while a translation shows: the language, what the song
// is about, and the notes on particular lines.
function renderTranslatePanel() {
  renderTranslateButton();
  var panel = document.getElementById('xp-translate');
  if (!panel) return;
  var track = translateTrack();
  var open = !!(track && _translateOpen === track.id && hasLyrics(track));
  var checking = typeof _sungCheckOpen !== 'undefined' && track && _sungCheckOpen === track.id;
  panel.hidden = !open || checking;
  if (panel.hidden) { panel.innerHTML = ''; return; }
  var lang = translateLanguage();
  var tr = getTranslation(track, lang);
  var mine = !!getVaultTrack(track.id);
  if (!mine) {
    // A visitor sees the owner's saved translation, in its language.
    panel.innerHTML = tr ? '<div class="translate-head"><span class="player-copy-kicker">What it means</span><span class="translate-lang">' + esc(tr.lang) + '</span></div>'
      + (tr.about ? '<p class="translate-about">' + esc(tr.about) + '</p>' : '') : '';
    panel.hidden = !tr;
    return;
  }
  var picker = '<label class="translate-lang"><span>Into</span><select onchange="setTranslateLanguage(this.value)" aria-label="Translate into">'
    + TRANSLATE_LANGUAGES.map(function(name) {
        return '<option' + (name === lang ? ' selected' : '') + '>' + esc(name) + '</option>';
      }).join('')
    + '</select></label>';
  var body;
  if (_translateJobs[track.id]) {
    body = '<div class="translate-note"><span class="create-take-pulse" aria-hidden="true"></span>Translating into ' + esc(_translateJobs[track.id]) + '… a few seconds.</div>';
  } else if (!tr) {
    body = '<div class="translate-note">' + (_translateFailed[track.id]
      ? 'Couldn’t translate just now. <button type="button" class="lyric-undo" onclick="requestTranslation(translateTrack(), translateLanguage())">Try again</button>'
      : translateEndpoint()
        ? '<button type="button" class="lyric-undo" onclick="requestTranslation(translateTrack(), translateLanguage())">Translate into ' + esc(lang) + '</button>'
        : 'Connect the AI worker to translate.') + '</div>';
  } else {
    var lines = sungLyricLines(getTrackLyrics(track));
    var from = tr.same ? 'Already in ' + esc(lang) + '.' : (tr.from ? 'From ' + esc(tr.from) + ', line by line.' : '');
    body = (from ? '<div class="translate-from">' + from + '</div>' : '')
      + (tr.about ? '<p class="translate-about">' + esc(tr.about) + '</p>' : '')
      + (tr.notes && tr.notes.length ? '<details class="translate-details"><summary>Notes on ' + tr.notes.length + (tr.notes.length === 1 ? ' line' : ' lines') + '</summary><ul class="translate-notes">' + tr.notes.map(function(item) {
          var line = lines[item.line - 1];
          return '<li>' + (line ? '<span class="translate-quote">“' + esc(line) + '”</span>' : '') + esc(item.note) + '</li>';
        }).join('') + '</ul></details>' : '');
  }
  panel.innerHTML = '<div class="translate-head"><span class="player-copy-kicker">What it means</span>' + picker + '</div>' + body;
}
