// Ask your vault, at the top of Home: a question about the songs ("which
// ones are about my dad?") or a request ("play half an hour of upbeat
// Tagalog songs"), answered by Claude through the AI worker's /ask. It reads
// a catalog of the whole vault (js/data/ask.js) and the lyrics of the songs
// closest to the question in meaning (the index js/features/meaning.js
// keeps) or holding a "quoted line". A request to play or queue songs is
// carried out; a playlist is one tap to save. The conversation lives in
// this page only.

var ASK_HISTORY_TURNS = 4;
var ASK_TURNS_SHOWN = 6;
var ASK_SONGS_SHOWN = 8;
// The catalog is sent as it was for the rest of a conversation, so Claude's
// cached copy of it still matches; after ten minutes, or once songs are
// added or removed, it is written afresh.
var ASK_CATALOG_TTL_MS = 10 * 60 * 1000;
var ASK_SUGGESTIONS = [
  'What have I been making lately?',
  'Which songs are about family?',
  'Play something upbeat',
  'What haven’t I played in a while?',
  'Make a playlist for a rainy night'
];
var _ask = { turns:[], busy:false, catalog:null, expanded:{} };

function askAvailable() {
  return meaningAvailable() && tracks.length > 0;
}

function askCatalog(now) {
  var cached = _ask.catalog;
  if (cached && cached.count === tracks.length && now.getTime() - cached.at < ASK_CATALOG_TTL_MS) return cached.text;
  _ask.catalog = { text:buildAskCatalog(tracks, playlists, now), at:now.getTime(), count:tracks.length };
  return _ask.catalog.text;
}

// The lyrics to send with a question: songs holding a "quoted line" first,
// then the songs closest to it in meaning, once the songs have been read.
// Songs not read yet are read in the background, for the next question.
async function askPassagesFor(question) {
  var songs = collapseVersions(tracks, tracks).list;
  var picked = [];
  function add(track) {
    if (track && picked.indexOf(track) === -1) picked.push(track);
  }
  quotedPhrases(question).forEach(function(phrase) {
    songsWithPhrase(songs, phrase).slice(0, 5).forEach(add);
  });
  if (Object.keys(_meaningIndex.items).length) {
    try {
      var vector = Float32Array.from((await embedTexts([question]))[0]);
      var byId = {};
      songs.forEach(function(track) { byId[track.id] = track; });
      var scored = songs.map(function(track) {
        var v = songVector(track.id);
        return v ? { id:track.id, score:meaningSimilarity(vector, v) } : null;
      }).filter(Boolean);
      rankMeaningMatches(scored, 10).forEach(function(item) { add(byId[item.id]); });
    } catch (e) {
      console.warn('Ask: no meaning search this time:', e);
    }
  }
  if (!_meaningIndexing && songsNeedingMeaning().length) indexSongsForMeaning();
  return askPassages(picked, 16000);
}

async function askVault(text) {
  var input = document.getElementById('ask-input');
  var question = String(text || (input && input.value) || '').trim();
  if (!question || _ask.busy) return;
  if (!askAvailable()) { showToast('Connect the AI worker to ask your vault.'); return; }
  var turn = { q:question, status:'asking', answer:'', songs:[], action:'none', playlistName:'', error:'', playlistId:'' };
  _ask.turns.push(turn);
  _ask.busy = true;
  if (input) input.value = '';
  renderAskCard();
  try {
    var now = new Date();
    var passages = await askPassagesFor(question);
    var history = _ask.turns.filter(function(item) { return item !== turn && item.status === 'done'; })
      .slice(-ASK_HISTORY_TURNS)
      .map(function(item) { return { q:item.q, a:item.answer, songs:item.songs, action:item.action }; });
    var response = await workerRequest('/ask', {
      question:question,
      catalog:askCatalog(now),
      passages:passages,
      history:history,
      today:localDayKey(now)
    });
    if (!response.ok) throw new Error(await workerError(response));
    var reply = readAskAnswer(await response.json(), function(id) {
      return tracks.some(function(track) { return track.id === id; });
    });
    if (!reply.answer) throw new Error('Claude sent no answer. Try again.');
    Object.assign(turn, reply, { status:'done' });
  } catch (e) {
    turn.status = 'error';
    turn.error = (e && e.message) || 'Something went wrong. Try again.';
  }
  _ask.busy = false;
  var index = _ask.turns.indexOf(turn);
  if (turn.action === 'play') playAskSongs(index);
  else if (turn.action === 'queue') queueAskSongs(index);
  renderAskCard();
}

function askTurnIds(index) {
  var turn = _ask.turns[index];
  return turn ? turn.songs.filter(function(id) { return getTrackById(id); }) : [];
}

function playAskSongs(index) {
  var ids = askTurnIds(index);
  if (!ids.length) return;
  startPlayback(ids[0], ids, trimText(_ask.turns[index].q, 40));
}

function queueAskSongs(index) {
  queueSongs(askTurnIds(index));
}

function saveAskPlaylist(index) {
  var turn = _ask.turns[index];
  var ids = askTurnIds(index);
  if (!turn || !ids.length) return;
  if (turn.playlistId && getPlaylistById(turn.playlistId)) { viewPlaylist(turn.playlistId); return; }
  var name = turn.playlistName || playlistNameFromSentence(turn.q);
  var playlist = {
    id:'pl-' + Date.now(),
    name:name,
    color:PLAYLIST_COLOR_OPTIONS[hashString(turn.q) % PLAYLIST_COLOR_OPTIONS.length].value,
    desc:'Asked for: “' + turn.q + '”',
    trackIds:ids
  };
  playlists.push(playlist);
  persistPlaylists();
  renderPlaylists();
  turn.playlistId = playlist.id;
  renderAskCard();
  showToast('Saved “' + name + '” with ' + ids.length + (ids.length === 1 ? ' song' : ' songs'));
}

function retryAsk(index) {
  var turn = _ask.turns[index];
  if (!turn || _ask.busy) return;
  _ask.turns.splice(index, 1);
  askVault(turn.q);
}

function clearAsk() {
  if (_ask.busy) return;
  _ask.turns = [];
  _ask.expanded = {};
  _ask.catalog = null;
  renderAskCard();
  var input = document.getElementById('ask-input');
  if (input) input.focus();
}

function toggleAskSongs(index) {
  _ask.expanded[index] = !_ask.expanded[index];
  renderAskCard();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function askAnswerHTML(text) {
  return String(text || '').split(/\n{2,}/).map(function(part) {
    return '<p>' + esc(part.trim()).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

function askTurnHTML(turn, index) {
  var head = '<div class="ask-q">' + esc(turn.q) + '</div>';
  if (turn.status === 'asking') {
    return '<div class="ask-turn">' + head + '<div class="ask-a ask-thinking"><span class="create-take-pulse" aria-hidden="true"></span>Reading your vault…</div></div>';
  }
  if (turn.status === 'error') {
    return '<div class="ask-turn">' + head
      + '<div class="ask-a ask-error" role="alert">' + esc(turn.error) + '</div>'
      + '<div class="ask-actions"><button type="button" class="sec-action" onclick="retryAsk(' + index + ')">Try again</button></div></div>';
  }
  var list = askTurnIds(index).map(getTrackById);
  var shown = _ask.expanded[index] ? list : list.slice(0, ASK_SONGS_SHOWN);
  var ids = list.map(function(track) { return track.id; });
  var label = trimText(turn.q, 40);
  var songs = list.length
    ? '<div class="ask-songs">' + shown.map(function(track) { return buildMiniTrackCard(track, label, ids); }).join('') + '</div>'
      + (list.length > ASK_SONGS_SHOWN
        ? '<button type="button" class="create-setup-link ask-more" onclick="toggleAskSongs(' + index + ')">' + (_ask.expanded[index] ? 'Show fewer' : 'Show all ' + list.length) + '</button>'
        : '')
    : '';
  var actions = list.length
    ? '<div class="ask-actions">'
      + '<button type="button" class="sec-action primary has-icon" onclick="playAskSongs(' + index + ')">' + icon('play') + '<span>Play ' + (list.length === 1 ? 'it' : 'these') + '</span></button>'
      + '<button type="button" class="sec-action" onclick="queueAskSongs(' + index + ')">Add to queue</button>'
      + '<button type="button" class="sec-action" onclick="saveAskPlaylist(' + index + ')">'
      +   (turn.playlistId ? 'Open the playlist' : 'Save as playlist' + (turn.playlistName ? ' “' + esc(turn.playlistName) + '”' : ''))
      + '</button>'
      + '</div>'
    : '';
  return '<div class="ask-turn">' + head + '<div class="ask-a">' + askAnswerHTML(turn.answer) + '</div>' + songs + actions + '</div>';
}

function renderAskCard() {
  var card = document.getElementById('ask-card');
  if (!card) return;
  card.hidden = !askAvailable();
  if (card.hidden) return;
  var thread = document.getElementById('ask-thread');
  var start = Math.max(0, _ask.turns.length - ASK_TURNS_SHOWN);
  if (thread) {
    thread.innerHTML = _ask.turns.length
      ? '<div class="ask-thread-head"><span>Ask your vault</span><button type="button" class="create-setup-link" onclick="clearAsk()"' + (_ask.busy ? ' disabled' : '') + '>New question</button></div>'
        + _ask.turns.slice(start).map(function(turn, i) { return askTurnHTML(turn, start + i); }).join('')
      : '';
  }
  var chips = document.getElementById('ask-chips');
  if (chips) {
    chips.hidden = _ask.turns.length > 0;
    if (!chips.innerHTML) {
      chips.innerHTML = ASK_SUGGESTIONS.map(function(text) {
        return '<button type="button" class="create-idea" onclick="askVault(' + jsq(text) + ')">' + esc(text) + '</button>';
      }).join('');
    }
  }
  var input = document.getElementById('ask-input');
  if (input) input.placeholder = _ask.turns.length ? 'Ask a follow-up: “only the Bikol ones”' : 'Which songs are about my dad?';
  var btn = document.getElementById('ask-btn');
  if (btn) {
    btn.disabled = _ask.busy;
    btn.textContent = _ask.busy ? 'Asking…' : 'Ask';
  }
  var label = document.getElementById('ask-label');
  if (label) label.hidden = _ask.turns.length > 0;
}
