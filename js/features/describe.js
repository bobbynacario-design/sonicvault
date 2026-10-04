// Describing the vault with Claude: one button for every song without an AI
// description (old fallback-tagged songs, imports), and new watcher imports
// described as they arrive. Runs in this tab, one song at a time, through
// the AI worker. The panel lives in the AI worker card on the Import page.

var DESCRIBE_GAP_MS = 600;
var AUTO_DESCRIBE_DELAY_MS = 15000;
var _describeRun = null;          // { ids, index, done, failed, stopped, auto, error }
var _describeFailed = {};         // track id -> true, not retried automatically this session
var _autoDescribeTimer = null;
var _describeLastError = '';      // why the last run described nothing

function describeWorkerReady() {
  return !!(_aiConfig && _aiConfig.endpoint && window.fbOwnerUser)
    && !(typeof _coverDemoActive !== 'undefined' && _coverDemoActive);
}

function autoDescribeEnabled() {
  return !(appSettings && appSettings.autoDescribe === false);
}

function setAutoDescribe(on) {
  appSettings = window.appSettings || appSettings || {};
  appSettings.autoDescribe = !!on;
  window.appSettings = appSettings;
  save('settings', appSettings);
  renderDescribePanel();
  if (on) scheduleAutoDescribe();
}

// Claude's description for one song, saved into it. What a person chose
// stays: a genre other than "Other", the mood, and the cover style -- except
// on a raw watcher import (genre "Other", never described), whose
// "Energetic" is the watcher's placeholder, so Claude's mood replaces it.
async function describeTrackWithClaude(track) {
  var input = {
    title: String(track.title || '').trim(),
    prompt: String(track.prompt || '').trim(),
    lyrics: getTrackLyrics(track),
    genre: String(track.genre || '').trim(),
    mood: String(track.mood || '').trim()
  };
  var metadata = await requestRemoteAIMetadata(input, buildLocalMetadataSuggestion(input));
  metadata.aiSource = 'claude';
  var coverStyle = track.coverStyle;
  var rawImport = !String(track.aiSource || '').trim() && (!input.genre || lower(input.genre) === 'other');
  track.genreEdited = !!input.genre && lower(input.genre) !== 'other';
  track.moodEdited = !!input.mood && !rawImport;
  applyAIMetadataToDraft(track, metadata, false);
  if (coverStyle) track.coverStyle = coverStyle;
  ['genreEdited', 'moodEdited', 'aiStatus', 'aiError', 'aiDirty'].forEach(function(key) { delete track[key]; });
  persistTracks();
}

async function runDescribe(ids, auto) {
  if (_describeRun || !ids.length) return;
  _describeRun = { ids:ids, index:0, done:0, failed:0, stopped:false, auto:!!auto, error:'' };
  renderDescribePanel();
  for (var i = 0; i < ids.length; i++) {
    if (_describeRun.stopped || !describeWorkerReady()) break;
    _describeRun.index = i;
    renderDescribePanel();
    var track = tracks.find(function(item) { return item.id === ids[i]; });
    if (!track || !needsDescription(track)) continue;
    try {
      await describeTrackWithClaude(track);
      _describeRun.done++;
      if (_currentTrack && _currentTrack.id === track.id) updateExpandedPlayer();
    } catch (e) {
      _describeFailed[track.id] = true;
      _describeRun.failed++;
      _describeRun.error = (e && e.message) || 'The worker refused the request.';
      // The same answer would come back for every song (no credit, a bad
      // token): stop rather than spend the list on it.
      if (_describeRun.failed >= 2 && !_describeRun.done) break;
    }
    await new Promise(function(resolve) { setTimeout(resolve, DESCRIBE_GAP_MS); });
  }
  var run = _describeRun;
  _describeRun = null;
  window.refreshAll();
  if (run.done) showToast((run.auto ? 'Claude described ' : 'Described ') + run.done + ' song' + (run.done === 1 ? '' : 's'));
  else if (run.failed && !run.auto) showToast('Couldn’t describe the songs. See the AI worker card.');
  _describeLastError = run.failed && !run.done ? run.error : '';
  renderDescribePanel();
}

function describeAllSongs() {
  if (!describeWorkerReady()) return;
  _describeLastError = '';
  runDescribe(tracks.filter(needsDescription).map(function(track) { return track.id; }), false);
}

function stopDescribing() {
  if (_describeRun) _describeRun.stopped = true;
  renderDescribePanel();
}

// New watcher imports, described without asking -- in a visible tab, a
// while after the vault has synced, never twice in a session after failing.
function scheduleAutoDescribe() {
  clearTimeout(_autoDescribeTimer);
  _autoDescribeTimer = setTimeout(function() {
    if (_describeRun || !describeWorkerReady() || !autoDescribeEnabled()) return;
    if (document.visibilityState !== 'visible' || window.svBootPending) return;
    var now = Date.now();
    var ids = tracks.filter(function(track) {
      return isNewUndescribed(track, now) && !_describeFailed[track.id];
    }).map(function(track) { return track.id; });
    if (ids.length) runDescribe(ids, true);
  }, AUTO_DESCRIBE_DELAY_MS);
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') scheduleAutoDescribe();
});

function renderDescribePanel() {
  var el = document.getElementById('describe-panel');
  if (!el) return;
  if (!_aiConfig.endpoint || !window.fbOwnerUser) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  var waiting = tracks.filter(needsDescription).length;
  var line;
  if (_describeRun) {
    var total = _describeRun.ids.length;
    line = '<span>Describing ' + Math.min(_describeRun.index + 1, total) + ' of ' + total + ' song' + (total === 1 ? '' : 's') + ' with Claude…</span>'
      + (_describeRun.stopped ? '' : '<button type="button" class="sec-action" onclick="stopDescribing()">Stop</button>');
  } else if (waiting) {
    line = '<span><strong>' + waiting + ' song' + (waiting === 1 ? ' has' : 's have') + ' no description from Claude.</strong> Less than a cent each.</span>'
      + '<button type="button" class="sec-action" onclick="describeAllSongs()">Describe ' + (waiting === 1 ? 'it' : 'them') + '</button>';
  } else {
    line = '<span>Every song has a description from Claude.</span>';
  }
  el.innerHTML = '<div class="describe-line">' + line + '</div>'
    + (_describeLastError ? '<div class="describe-error" role="alert">' + esc(_describeLastError) + '</div>' : '')
    + '<label class="create-toggle describe-auto"><input type="checkbox"' + (autoDescribeEnabled() ? ' checked' : '') + ' onchange="setAutoDescribe(this.checked)"> Describe new songs automatically when they arrive</label>';
}
