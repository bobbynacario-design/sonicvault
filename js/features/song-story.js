// The story behind a song: a short note in the songwriter's own words, like
// liner notes, at the top of the expanded player's About card and on the
// song's share page. Written by hand, or drafted by Claude (the worker's
// /story) from a few notes and the song, then edited. Saved on the track as
// songStory, so it syncs and its share page updates.

var SONG_STORY_LIMIT = 1200;
var _songStory = { trackId:'', editing:false, text:'', notes:'', busy:false, error:'', drafted:false };
var _songStoryKey = '';

function songStoryTrack() {
  return _currentTrack ? (getVaultTrack(_currentTrack.id) || _currentTrack) : null;
}

function songStoryEndpoint() {
  if (!_aiConfig || !_aiConfig.endpoint) return '';
  try { return new URL('/story', _aiConfig.endpoint).toString(); } catch (e) { return ''; }
}

function renderSongStory(force) {
  var el = document.getElementById('xp-song-story');
  if (!el) return;
  var track = songStoryTrack();
  if (!track) {
    el.hidden = true;
    el.innerHTML = '';
    _songStoryKey = '';
    return;
  }
  var mine = !!getVaultTrack(track.id);
  if (_songStory.trackId !== track.id) _songStory = { trackId:track.id, editing:false, text:'', notes:'', busy:false, error:'', drafted:false };
  var story = String(track.songStory || '').trim();
  // Rebuilt only when something shown changes, so typing keeps its place.
  var key = [track.id, story, mine, _songStory.editing, _songStory.busy, _songStory.error, _songStory.drafted, songStoryEndpoint()].join('|');
  if (!force && key === _songStoryKey) return;
  _songStoryKey = key;
  var label = '<div class="song-story-label">Behind the song</div>';
  if (mine && _songStory.editing) {
    var note = _songStory.busy ? '<span class="create-take-pulse" aria-hidden="true"></span>Drafting from your notes and the song…'
      : _songStory.error ? esc(_songStory.error)
      : _songStory.drafted ? 'Drafted from your notes. Make it yours, then save. <button type="button" class="lyric-undo" onclick="undoSongStoryDraft()">Back to my notes</button>'
      : 'Who it’s for, when you made it, what it means to you.' + (songStoryEndpoint() ? ' A few notes are enough for Claude to draft from.' : '');
    el.innerHTML = label
      + '<textarea id="song-story-text" class="song-story-input" rows="5" maxlength="' + SONG_STORY_LIMIT + '" aria-label="The story behind the song"'
      +   ' placeholder="For my brother’s 47th. We played poker every Friday for twenty years…" oninput="_songStory.text = this.value"'
      +   (_songStory.busy ? ' disabled' : '') + '>' + esc(_songStory.text) + '</textarea>'
      + '<div class="song-story-note' + (_songStory.error ? ' is-error' : '') + '" aria-live="polite">' + note + '</div>'
      + '<div class="song-story-actions">'
      +   (songStoryEndpoint() ? '<button type="button" class="sec-action" onclick="draftSongStory()"' + (_songStory.busy ? ' disabled' : '') + '>Draft with Claude</button>' : '')
      +   '<button type="button" class="sec-action" onclick="cancelSongStory()">Cancel</button>'
      +   '<button type="button" class="sec-action primary" onclick="saveSongStory()"' + (_songStory.busy ? ' disabled' : '') + '>Save</button>'
      + '</div>';
    el.hidden = false;
    return;
  }
  if (story) {
    el.innerHTML = label + '<p class="song-story-text">' + esc(story) + '</p>'
      + (mine ? '<button type="button" class="player-about-action song-story-edit" onclick="startSongStory()">Edit</button>' : '');
    el.hidden = false;
    return;
  }
  el.innerHTML = mine ? '<button type="button" class="player-about-action song-story-add" onclick="startSongStory()">Add the story behind this song</button>' : '';
  el.hidden = !mine;
}

function startSongStory() {
  var track = songStoryTrack();
  if (!track || !getVaultTrack(track.id)) return;
  _songStory = { trackId:track.id, editing:true, text:String(track.songStory || ''), notes:'', busy:false, error:'', drafted:false };
  renderSongStory(true);
  var input = document.getElementById('song-story-text');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function cancelSongStory() {
  _songStory.editing = false;
  _songStory.drafted = false;
  _songStory.error = '';
  renderSongStory(true);
}

function saveSongStory() {
  var track = getVaultTrack(_songStory.trackId);
  if (!track) return;
  var text = String(_songStory.text || '').trim().slice(0, SONG_STORY_LIMIT);
  if (text) track.songStory = text;
  else delete track.songStory;
  persistTracks();
  _songStory.editing = false;
  _songStory.drafted = false;
  renderSongStory(true);
  showToast(text ? 'Saved the story behind the song' : 'Removed the story behind the song');
}

async function draftSongStory() {
  var track = getVaultTrack(_songStory.trackId);
  if (!track || _songStory.busy || !songStoryEndpoint()) return;
  var notes = String(_songStory.text || '').trim();
  _songStory.busy = true;
  _songStory.error = '';
  renderSongStory(true);
  try {
    var headers = { 'Content-Type':'application/json' };
    if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
    var response = await fetch(songStoryEndpoint(), {
      method:'POST',
      headers:headers,
      body:JSON.stringify({ title:track.title || '', prompt:track.prompt || '', lyrics:getTrackLyrics(track), summary:getTrackSummary(track), notes:notes })
    });
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.error || ('The worker answered ' + response.status + '.'));
    if (_songStory.trackId !== track.id || !_songStory.editing) return;
    _songStory.notes = notes;
    _songStory.text = String(data.story || '');
    _songStory.drafted = true;
  } catch (e) {
    _songStory.error = 'Couldn’t draft it just now: ' + ((e && e.message) || 'try again.');
  } finally {
    _songStory.busy = false;
    renderSongStory(true);
  }
}

function undoSongStoryDraft() {
  _songStory.text = _songStory.notes;
  _songStory.drafted = false;
  renderSongStory(true);
}
