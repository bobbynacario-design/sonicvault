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
