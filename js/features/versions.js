// Versions of a song (js/data/versions.js) in the library, the home rails,
// the play queue and the expanded player: each song once, with its takes a
// click away, a main take to stand for it, and a switch between takes at
// the same point in the song. Grouping can be turned off per device.

var _groupVersionsOn = (function() {
  try { return localStorage.getItem('sv_group_versions') !== 'off'; } catch (e) { return true; }
})();
var _openVersions = {};      // shown track id -> versions list open
var _shelfVersions = {};     // shown track id -> its whole group, from the last shelf render
var _versionKeyMemo = {};    // track id -> { sig, key }
var _versionGroupsCache = { version:-1, groups:{} };

// versionKey, remembered per track until its title, prompt or lyrics change:
// every shelf render asks for every track's key.
function memoVersionKey(track) {
  if (!track || !track.id) return versionKey(track);
  var sig = String(track.title || '') + '\u0001' + String(track.prompt || '') + '\u0001' + String(track.lyrics || '');
  var memo = _versionKeyMemo[track.id];
  if (memo && memo.sig === sig) return memo.key;
  var key = versionKey(track);
  _versionKeyMemo[track.id] = { sig:sig, key:key };
  return key;
}

function getVersionGroups() {
  if (_versionGroupsCache.version !== _tracksVersion) {
    _versionGroupsCache = { version:_tracksVersion, groups:versionGroups(tracks, memoVersionKey) };
  }
  return _versionGroupsCache.groups;
}

// The track's whole group (first made first), or null when it has no twin.
function getVersionGroup(track) {
  var key = track && memoVersionKey(track);
  return (key && getVersionGroups()[key]) || null;
}

// The shelf's list: each song once when grouping is on.
function shelfCollapse(filtered) {
  if (!_groupVersionsOn) return { list:filtered, versions:{} };
  return collapseVersions(filtered, tracks, memoVersionKey);
}

// What playing from the shelf queues: the songs as shown.
function getShelfQueueTracks() {
  return shelfCollapse(getFilteredTracks()).list;
}

// A shelf queue with this take in place of whichever take of its song the
// shelf shows -- else "next" has nowhere to go from a take not in the queue.
function queueWithVersion(ids, track) {
  var group = getVersionGroup(track);
  var out = ids.slice();
  var at = group ? out.findIndex(function(id) { return group.some(function(take) { return take.id === id; }); }) : -1;
  if (at !== -1) out[at] = track.id;
  else out.unshift(track.id);
  return out;
}

// Rails show each song once too: the first take of it in the rail's order.
function dedupeVersions(list) {
  if (!_groupVersionsOn) return list;
  var seen = {};
  return list.filter(function(track) {
    var key = memoVersionKey(track);
    if (!key || !getVersionGroups()[key]) return true;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function toggleGroupVersions() {
  _groupVersionsOn = !_groupVersionsOn;
  try { localStorage.setItem('sv_group_versions', _groupVersionsOn ? 'on' : 'off'); } catch (e) {}
  renderGroupVersionsToggle();
  renderTracks();
  showToast(_groupVersionsOn ? 'Versions grouped: each song once' : 'Every version listed separately');
}

function renderGroupVersionsToggle() {
  var btn = document.getElementById('versions-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', _groupVersionsOn ? 'true' : 'false');
  btn.classList.toggle('active', _groupVersionsOn);
}

function versionLabel(track, group) {
  return 'Version ' + (group.indexOf(track) + 1);
}

// The "2 versions" chip on a shelf row or card.
function versionChipHTML(track) {
  var group = _shelfVersions[track.id];
  if (!group) return '';
  var open = !!_openVersions[track.id];
  return '<button type="button" class="version-chip" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="versions-' + attr(track.id) + '" onclick="event.stopPropagation();toggleVersions(' + jsq(track.id) + ')">' + group.length + ' versions</button>';
}

// Every take of the song, with which one is main, and Play / Make main.
function versionListHTML(track) {
  var group = _shelfVersions[track.id];
  if (!group || !_openVersions[track.id]) return '';
  var main = primaryVersion(group);
  return '<div class="version-list" id="versions-' + attr(track.id) + '" role="list" aria-label="' + attr('Versions of ' + baseSongTitle(track.title)) + '">'
    + group.map(function(take) {
      var isMain = take === main;
      var isCurrent = _currentTrack && _currentTrack.id === take.id;
      var name = versionLabel(take, group) + (take.title !== track.title ? ' · ' + take.title : '');
      return '<div class="version-row' + (isCurrent ? ' current' : '') + '" role="listitem">'
        + '<span class="version-name">' + (isCurrent ? eqBars() : '') + esc(name) + '</span>'
        + '<span class="version-facts">' + fmtTime(take.duration || 0) + ' · ' + fmtCompactNumber(take.plays || 0) + (Number(take.plays) === 1 ? ' play' : ' plays')
        // Which take sang the sheet best, once they have been checked.
        + (sungCheckSummary(take) ? ' · ' + sungCheckSummary(take) : '') + '</span>'
        + (isMain ? '<span class="version-main">Main</span>' : '<button type="button" class="sec-action" onclick="event.stopPropagation();setMainVersion(' + jsq(take.id) + ')">Make main</button>')
        + '<button type="button" class="sec-action" onclick="event.stopPropagation();playVersion(' + jsq(take.id) + ', ' + jsq(track.id) + ')">' + (isCurrent && _isPlaying ? 'Pause' : 'Play') + '</button>'
        + '</div>';
    }).join('')
    + '</div>';
}

// Rebuild one shelf entry in place: re-rendering the shelf would drop the
// pages scrolled in below it.
function refreshShelfItem(id) {
  var el = document.getElementById('card-' + id);
  var track = getTrackById(id);
  if (!el || !track) return;
  el.outerHTML = _shelfView === 'list' ? buildTrackRow(track, Number(el.getAttribute('data-index')) || 0) : buildTrackCard(track);
}

function toggleVersions(id) {
  _openVersions[id] = !_openVersions[id];
  refreshShelfItem(id);
}

// Play a take from the shelf, queued in the song's place among the others.
function playVersion(id, shownId) {
  if (_currentTrack && _currentTrack.id === id) { togglePlayback(); refreshShelfItem(shownId); return; }
  var queue = getShelfQueueTracks().map(function(track) { return track.id === shownId ? id : track.id; });
  if (queue.indexOf(id) === -1) queue.unshift(id);
  startPlayback(id, queue, 'Filtered shelf');
}

function setMainVersion(id) {
  var track = getTrackById(id);
  var group = track && getVersionGroup(track);
  if (!group) return;
  group.forEach(function(take) {
    if (take.id === id) take.versionPick = true;
    else delete take.versionPick;
  });
  persistTracks();
  renderTracks();
  showToast(versionLabel(track, group) + ' is now the main version');
}

// The expanded player's "Version 1 of 2" line, with the other takes to
// switch to at the same point in the song.
function renderPlayerVersions(track) {
  var el = document.getElementById('xp-versions');
  if (!el) return;
  var group = track && getVersionGroup(track);
  if (!group) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '<span>' + versionLabel(track, group) + ' of ' + group.length + '</span>'
    + group.filter(function(take) { return take !== track; }).map(function(take) {
      return '<button type="button" class="version-switch" onclick="switchToVersion(' + jsq(take.id) + ')">Switch to ' + versionLabel(take, group).toLowerCase() + '</button>';
    }).join('')
    + '<button type="button" class="version-switch is-compare" onclick="compareCurrentTrack()">Compare takes</button>';
}

function switchToVersion(id) {
  if (!_currentTrack) return;
  var at = _audio.currentTime || 0;
  var wasPlaying = _isPlaying;
  var queue = (_playQueueIds.length ? _playQueueIds : [_currentTrack.id]).map(function(qid) { return qid === _currentTrack.id ? id : qid; });
  startPlayback(id, queue, _playQueueLabel);
  _audio.addEventListener('loadedmetadata', function() {
    if (_audio.duration && at < _audio.duration - 1) _audio.currentTime = at;
    if (!wasPlaying) togglePlayback();
  }, { once:true });
}
