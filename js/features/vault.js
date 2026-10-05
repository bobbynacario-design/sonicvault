// The vault itself: tracks, playlists and settings. The tracks' offline
// cache is in IndexedDB (js/features/store.js); playlists and settings stay
// in localStorage. js/app.js replaces the window copies on each sync.
// Track and playlist changes go out through persistTracks() and
// persistPlaylists().

function load(key, def) {
  try { return JSON.parse(localStorage.getItem('sv_' + key)) || def; } catch (e) { return def; }
}

window.tracks = load('tracks', []);
window.playlists = load('playlists', []);
window.appSettings = load('settings', {});
var tracks = window.tracks;
var playlists = window.playlists;
var appSettings = window.appSettings;
// tracks above is only the old localStorage copy, on the first visit after
// the cache moved; the IndexedDB copy arrives a moment later.
hydrateTrackCache();

// Lyric timings from the first lyric-sync build were stored in a shape
// Firestore rejects (an array of [start, end] arrays), so every save of
// those tracks failed and sat in the queue. Convert this device's copy.
tracks.forEach(function(track) {
  if (track && track.lyricSync) track.lyricSync = cloudSafeLyricSync(track.lyricSync);
});

function getTrackById(id) {
  return tracks.find(function(t) { return t.id === id; }) || getPublicTrackPool().find(function(t) { return t.id === id; }) || null;
}

function getPlaylistById(id) {
  return playlists.find(function(pl) { return pl.id === id; }) || getPublicPlaylistList().find(function(pl) { return pl.id === id; }) || null;
}

function getPlaylistTracks(pl) {
  if (pl && Array.isArray(pl.tracks) && pl.tracks.length) return pl.tracks.slice();
  return (pl && pl.trackIds || []).map(function(id) { return getTrackById(id); }).filter(Boolean);
}

function persistPlaylists() {
  window.playlists = playlists;
  save('playlists', playlists);
  playlists.forEach(function(pl) {
    if (pl.shared) syncSharedPlaylist(pl);
  });
}

// Mirror of persistPlaylists() for tracks. All track mutations should
// route through here so the filter cache is busted in one place
// instead of every call site remembering to call invalidateFilterCache().
function persistTracks() {
  window.tracks = tracks;
  if (_coverDemoActive) {
    invalidateFilterCache();
    return;
  }
  // IndexedDB keeps the whole array as the offline cache; Firestore gets
  // only the documents that actually changed.
  cacheTracks(tracks);
  syncTrackDocs();
  invalidateFilterCache();
  if (typeof scheduleShareRefresh === 'function') scheduleShareRefresh();
}
