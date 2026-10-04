// Suno makes two takes of every prompt, so the vault holds pairs like
// "Still In (1)" and "Still In (2)": the same song, two performances. They
// are grouped as versions of one song. Takes share their lyric sheet word
// for word, so the sheet is the key; a song without lyrics groups by its
// title (less any "(2)") and prompt. Nothing is stored for a group: it is
// read from the tracks each time. The one a person picks as main carries
// `versionPick: true`.
// Pure: tracks in, groups out.

// The sheet's words alone: no section tags, case, punctuation or spacing,
// so a re-saved sheet still matches its twin.
function versionLyricsText(lyrics) {
  return String(lyrics || '').split(/\r\n?|\n/).filter(function(line) {
    return line.trim() && !isLyricSectionHeader(line);
  }).join(' ').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "Still In (2)", "Still In v2", "Still In - Take 2", "Still In [2]" -> "Still In".
function baseSongTitle(title) {
  return String(title || '').trim()
    .replace(/\s*(?:\(\s*\d+\s*\)|\[\s*\d+\s*\]|[-–—]?\s*(?:v|take|version)\s*\.?\s*\d+)\s*$/i, '')
    .trim();
}

// The key a song's versions share, or '' for a song that cannot be matched
// with confidence (short or missing lyrics, and no prompt to go on).
function versionKey(track) {
  var words = versionLyricsText(track && track.lyrics);
  if (words.length >= 60) return 'l:' + hashString(words);
  var prompt = String(track && track.prompt || '').toLowerCase().replace(/\s+/g, ' ').trim();
  var base = baseSongTitle(track && track.title).toLowerCase();
  if (prompt.length >= 20 && base) return 'p:' + hashString(base + '|' + prompt);
  return '';
}

// Groups of two or more, by key. keyOf lets a caller pass a memoised
// versionKey.
function versionGroups(list, keyOf) {
  var key = keyOf || versionKey;
  var groups = {};
  (list || []).forEach(function(track) {
    var k = key(track);
    if (!k) return;
    (groups[k] = groups[k] || []).push(track);
  });
  Object.keys(groups).forEach(function(k) {
    if (groups[k].length < 2) delete groups[k];
    else groups[k].sort(function(a, b) { return trackIdTimestamp(a) - trackIdTimestamp(b) || String(a.id).localeCompare(String(b.id)); });
  });
  return groups;
}

// The version that stands for the song: the one picked as main, else the
// most played, else the first made.
function primaryVersion(group) {
  var picked = group.filter(function(track) { return track.versionPick === true; })[0];
  if (picked) return picked;
  return group.slice().sort(function(a, b) {
    return Number(b.plays || 0) - Number(a.plays || 0) || trackIdTimestamp(a) - trackIdTimestamp(b);
  })[0];
}

// A list with each song once. The version shown is the main one when the
// list holds it (a search can match just one take), placed where the song's
// first version falls in the list's order. `versions` maps each shown id to
// the whole group, first made first.
function collapseVersions(list, allTracks, keyOf) {
  var key = keyOf || versionKey;
  var groups = versionGroups(allTracks || list, key);
  var inList = {};
  (list || []).forEach(function(track) { inList[track.id] = true; });
  var seen = {};
  var out = [];
  var versions = {};
  (list || []).forEach(function(track) {
    var k = key(track);
    var group = k && groups[k];
    if (!group) { out.push(track); return; }
    if (seen[k]) return;
    seen[k] = true;
    var main = primaryVersion(group);
    var shown = inList[main.id] ? main : track;
    out.push(shown);
    versions[shown.id] = group;
  });
  return { list: out, versions: versions };
}
