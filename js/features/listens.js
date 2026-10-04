// Plays and hearts on share links. Someone listening to a song you shared
// reports a play once it has played ten seconds, and a heart when they tap
// "Love this moment" -- to the AI worker's public /listen, which counts them
// anonymously (cloudflare-worker/worker.js). Your own plays never report.
// The Insights page shows them per song (/listens, with your token).

var LISTEN_AFTER_S = 10;
var _listenReported = {};    // track id -> true once this page load's play went out
var _shareListens = { data:null, at:0, loading:false, error:'' };

// Someone else listening to a shared song: not the signed-in owner, and not
// a song in this browser's vault.
function isVisitorListening(track) {
  if (!track || window.fbOwnerUser || getVaultTrack(track.id)) return false;
  return getPublicTrackPool().some(function(item) { return item.id === track.id; });
}

function reportListen(body) {
  try {
    fetch(SHARE_PREVIEW_ORIGIN + '/listen', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(body),
      keepalive:true
    }).catch(function() {});
  } catch (e) {}
}

_audio.addEventListener('timeupdate', function() {
  var track = _currentTrack;
  if (!track || _listenReported[track.id] || (_audio.currentTime || 0) < LISTEN_AFTER_S) return;
  if (!isVisitorListening(track)) return;
  _listenReported[track.id] = true;
  reportListen({ id:track.id, kind:'play' });
});

// The heart on a share page and in karaoke: the moment playing right now.
function loveSharedMoment(id, button) {
  if (!_currentTrack || _currentTrack.id !== id || !(_audio.currentTime > 0)) {
    showToast('Play the song, then tap ♥ at the moment you love.');
    return;
  }
  var pos = Math.round(_audio.currentTime * 10) / 10;
  if (isVisitorListening(_currentTrack)) {
    reportListen({ id:id, kind:'heart', pos:pos });
    showToast('Loved ' + fmtTime(pos) + '. The songwriter will see it.');
  } else {
    showToast('Hearts from people you share this with show on your Insights page.');
  }
  if (button) {
    button.classList.remove('is-loved');
    void button.offsetWidth;
    button.classList.add('is-loved');
  }
}

function lovedButtonHTML(id, className) {
  return '<button type="button" class="' + (className || 'sec-action has-icon') + ' heart-btn" aria-label="Love this moment" onclick="loveSharedMoment(' + jsq(id) + ', this)">'
    + icon('heart') + '<span>Love this moment</span></button>';
}

// ── On the Insights page ─────────────────────────────────────────────────

async function loadShareListens() {
  if (_shareListens.loading || !_aiConfig || !_aiConfig.endpoint) return;
  _shareListens.loading = true;
  _shareListens.error = '';
  renderShareListens();
  try {
    var headers = { 'Content-Type':'application/json' };
    if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
    var response = await fetch(new URL('/listens', _aiConfig.endpoint).toString(), { method:'POST', headers:headers, body:'{}' });
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.error || ('The worker answered ' + response.status + '.'));
    _shareListens.data = data.tracks || {};
    _shareListens.at = Date.now();
  } catch (e) {
    _shareListens.error = (e && e.message) || 'Couldn’t load the counts.';
  } finally {
    _shareListens.loading = false;
    renderShareListens();
  }
}

// The lyric line at a moment, for "most loved".
function lineAtMoment(track, seconds) {
  if (!hasUsableLyricTimes(track)) return '';
  var times = resolveLyricTimes(getLyricSync(track).lines, Number(track.duration) || 0);
  var idx = currentLyricIndex(times, seconds, 0);
  return idx >= 0 ? sungLyricLines(getTrackLyrics(track))[idx] : '';
}

function renderShareListens() {
  var el = document.getElementById('share-listens');
  if (!el) return;
  var shared = tracks.filter(function(track) { return track && track.shared; });
  if (!shared.length) { el.innerHTML = ''; return; }
  if (!_shareListens.data && !_shareListens.loading && !_shareListens.error && _aiConfig && _aiConfig.endpoint) {
    loadShareListens();
    return;
  }
  var stats = _shareListens.data || {};
  var empty = { plays:0, playsWeek:0, hearts:0, heartsWeek:0, last:0, moments:[] };
  var rows = shared.map(function(track) { return { track:track, s:stats[track.id] || empty }; })
    .sort(function(a, b) { return b.s.plays - a.s.plays || b.s.hearts - a.s.hearts || b.s.last - a.s.last; });
  var body;
  if (!_aiConfig || !_aiConfig.endpoint) {
    body = '<p class="listen-note">Connect the AI worker to see plays and hearts on your share links.</p>';
  } else if (_shareListens.error) {
    body = '<p class="listen-note">' + esc(_shareListens.error) + ' <button type="button" class="lyric-undo" onclick="loadShareListens()">Try again</button></p>';
  } else if (!_shareListens.data) {
    body = '<p class="listen-note">Counting…</p>';
  } else {
    body = '<div class="listen-list">' + rows.map(function(row) {
      var s = row.s;
      var facts = s.plays
        ? fmtCompactNumber(s.plays) + (s.plays === 1 ? ' play' : ' plays') + (s.playsWeek ? ' · ' + fmtCompactNumber(s.playsWeek) + ' this week' : '')
        : 'No plays yet';
      if (s.hearts) facts += ' · ♥ ' + fmtCompactNumber(s.hearts);
      if (s.last) facts += ' · last ' + storyClipAge(s.last);
      var top = s.moments && s.moments[0];
      var line = top ? lineAtMoment(row.track, top.at + 2.5) : '';
      return '<div class="listen-row">' + buildCoverArt(row.track, 'xs', false)
        + '<div class="listen-main"><div class="listen-title">' + esc(row.track.title || 'Untitled') + '</div>'
        + '<div class="listen-facts">' + esc(facts) + '</div>'
        + (top ? '<div class="listen-moment">Most loved: ' + fmtTime(top.at) + (line ? ' · “' + esc(line) + '”' : '') + ' (' + top.hearts + ' ♥)</div>' : '')
        + '</div></div>';
    }).join('') + '</div>';
  }
  el.innerHTML = '<div class="section-card"><div class="section-inner">'
    + '<div class="section-head"><div><div class="section-title">Your share links</div>'
    + '<div class="section-sub">Plays (ten seconds or more) and ♥ from people you’ve sent links to, counted anonymously. Your own plays don’t count.</div></div>'
    + (_aiConfig && _aiConfig.endpoint ? '<div class="section-action-row"><button class="sec-action" onclick="loadShareListens()"' + (_shareListens.loading ? ' disabled' : '') + '>Refresh</button></div>' : '')
    + '</div>' + body + '</div></div>';
}
