// Facts about a track or playlist object itself: how the vault orders them,
// and the fingerprint the per-track sync diffs against.
// Pure: no DOM, no app state, nothing outside js/data.

// Key order differs between a locally built object and one returned by
// Firestore, so sort before comparing or every track looks dirty.
function trackFingerprint(track) {
  var out = {};
  Object.keys(track || {}).filter(function(k) {
    return k !== 'audioData' && track[k] !== undefined;
  }).sort().forEach(function(k) { out[k] = track[k]; });
  return JSON.stringify(out);
}

function stripAudioData(track) {
  var copy = Object.assign({}, track);
  delete copy.audioData;
  return copy;
}

function trackTimestamp(track) {
  if (track && track.created) {
    var parsed = Date.parse(track.created);
    if (!isNaN(parsed)) return parsed;
  }
  return trackIdTimestamp(track);
}

// `created` is date-only, so every track imported on the same day ties. The
// array order used to break that tie -- the watcher prepended, so the newest
// import sorted first. Per-track documents arrive in document-id order
// instead, which would have flipped same-day imports to oldest-first. Track
// ids carry their own epoch, so use that as the tiebreaker explicitly rather
// than depending on the order the snapshot happens to arrive in.
function trackIdTimestamp(track) {
  var match = String(track && track.id || '').match(/^t-(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function compareNewestFirst(a, b) {
  return (trackTimestamp(b) - trackTimestamp(a)) || (trackIdTimestamp(b) - trackIdTimestamp(a));
}

function playlistTimestamp(pl) {
  var match = String(pl && pl.id || '').match(/^pl-(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function getCollectionDuration(list) {
  return list.reduce(function(sum, track) { return sum + Number(track.duration || 0); }, 0);
}

// ── Days played ─────────────────────────────────────────────────────────────
// Each play is counted against the day it happened (track.playDays,
// 'YYYY-MM-DD' -> plays, in the listener's own time zone), for a look back
// at a year in songs. A map grows by one entry a day a song is played, so a
// year of daily listening is a few KB on the track.

function localDayKey(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// A copy of the map with one more play on the day.
function addPlayDay(playDays, date) {
  var out = {};
  var map = playDays && typeof playDays === 'object' && !Array.isArray(playDays) ? playDays : {};
  Object.keys(map).forEach(function(key) { out[key] = Number(map[key]) || 0; });
  var key = localDayKey(date);
  if (key) out[key] = (out[key] || 0) + 1;
  return out;
}

// ── Play next / Add to queue ────────────────────────────────────────────────
// The queue with a song put right after the one playing ('next') or at the
// end ('end'). The player finds its place in the queue by song, so a song
// is in it once: one already queued moves rather than appearing twice. The
// song playing stays where it is. With nothing playing, 'next' goes first.
function queueWithSong(ids, currentId, id, where) {
  var list = (ids || []).filter(function(item) { return item !== id || item === currentId; });
  if (id === currentId) return list;
  if (where === 'next') {
    var at = list.indexOf(currentId);
    list.splice(at + 1, 0, id);
  } else {
    list.push(id);
  }
  return list;
}
