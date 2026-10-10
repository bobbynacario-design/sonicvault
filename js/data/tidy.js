// Tidying the vault (js/features/tidy.js): what needs fixing, and what the
// fix would be -- titles still carrying their file name, the same file
// imported twice, a song whose other take is clearly better than the one
// standing for it, and songs with no lyrics that aren't instrumentals.
// Pure: tracks in, plain values out.

var TIDY_UNTITLED = /^(untitled( song)?|new recording|audio|track)( \d+)?$/i;

// A title cleaned of what its file name left in it: an extension, a long
// number in front (Suno's downloads), a "- Suno" tail, underscores and
// runs of spaces. A title made only of capitals, or only of lower case from
// a file name, gets capitals on each word. "Untitled" is named from the
// first sung line. '' when the title is fine as it is.
function tidyTitle(title, lyrics, prompt) {
  var original = String(title || '');
  var text = original.trim();
  var fromFile = /_|\.(mp3|wav|m4a|flac|ogg|aac)$|^\d{6,}/i.test(text);
  text = text.replace(/\.(mp3|wav|m4a|flac|ogg|aac)$/i, '')
    .replace(/^\d{6,}[\s_-]*/, '')
    .replace(/\s*[-–]\s*suno(\s*ai)?\s*$/i, '')
    .replace(/\s*\(suno[^)]*\)\s*$/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–.]+|[\s\-–.]+$/g, '');
  var letters = text.replace(/[^A-Za-z]/g, '');
  var words = text.split(' ').filter(Boolean);
  var shouting = letters.length > 4 && words.length > 1 && letters === letters.toUpperCase();
  var flat = fromFile && letters.length > 0 && letters === letters.toLowerCase();
  if (shouting || flat) {
    text = text.toLowerCase().replace(/(^|\s|\()([a-z])/g, function(all, lead, ch) { return lead + ch.toUpperCase(); });
  }
  if (!text || TIDY_UNTITLED.test(text)) {
    var named = getLyricContentLines(lyrics || '').length ? deriveSongTitle('', lyrics, prompt) : '';
    text = named || text;
  }
  return text && text !== original ? text : '';
}

// Whether a song should have lyrics and has none: not an instrumental by
// its description, and with audio to listen to.
function needsLyrics(track) {
  return !!track && !hasLyrics(track) && !!(track.audioURL || track.audioData)
    && !/instrument/i.test(String(track.aiVocalStyle || ''));
}

// The same file in the vault twice: the same Cloudinary address, or the
// same size in bytes and a length within a second -- an upload and a
// watcher import of one download, say, or a file dropped twice before the
// uploader checked (findVaultCopy). Suno's two takes of a prompt differ in
// both. [{ keep, drop }], keeping the most played (then the main take, then
// the first imported) of each set.
function findDuplicates(list) {
  var groups = [];
  var placed = {};
  var all = (list || []).filter(function(track) { return track && track.id; });
  all.forEach(function(track, i) {
    if (placed[track.id]) return;
    var set = [track];
    for (var j = i + 1; j < all.length; j++) {
      var other = all[j];
      if (placed[other.id]) continue;
      var sameFile = track.audioURL && track.audioURL === other.audioURL;
      var sameBytes = Number(track.fileSize) > 0 && Number(track.fileSize) === Number(other.fileSize)
        && Math.abs((Number(track.duration) || 0) - (Number(other.duration) || 0)) < 1;
      if (sameFile || sameBytes) set.push(other);
    }
    if (set.length < 2) return;
    set.forEach(function(item) { placed[item.id] = true; });
    groups.push(set);
  });
  var out = [];
  groups.forEach(function(set) {
    var keep = set.slice().sort(function(a, b) {
      return Number(b.plays || 0) - Number(a.plays || 0)
        || (b.versionPick === true) - (a.versionPick === true)
        || trackIdTimestamp(a) - trackIdTimestamp(b);
    })[0];
    set.forEach(function(item) { if (item !== keep) out.push({ keep:keep, drop:item }); });
  });
  return out;
}

function mergeDayMaps(a, b) {
  var out = {};
  [a, b].forEach(function(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    Object.keys(map).forEach(function(day) { out[day] = (out[day] || 0) + (Number(map[day]) || 0); });
  });
  return Object.keys(out).length ? out : null;
}

// What the kept copy carries once its duplicate goes: both play counts and
// day maps added together, every karaoke take, and lyrics or a prompt the
// kept one lacked. null fields are to be removed.
function mergedTrackFields(keep, drop) {
  var takes = (Array.isArray(keep.takes) ? keep.takes : []).concat(Array.isArray(drop.takes) ? drop.takes : []);
  return {
    plays:Number(keep.plays || 0) + Number(drop.plays || 0),
    playDays:mergeDayMaps(keep.playDays, drop.playDays),
    skipDays:mergeDayMaps(keep.skipDays, drop.skipDays),
    takes:takes.length ? takes : null,
    lyrics:hasLyrics(keep) ? keep.lyrics : (drop.lyrics || keep.lyrics || ''),
    prompt:String(keep.prompt || '').trim() ? keep.prompt : (drop.prompt || keep.prompt || '')
  };
}

// The take a song should stand for, when the evidence points away from the
// one that does now: the take winning lately (winningTake) -- even against
// a main take picked by hand, since you keep choosing the other -- else,
// with no main picked, the take that sang clearly more of the sheet as
// written (two lines or more, with both checked).
// sungOf(take) -> { asWritten, total } or null. { take, reason } or null.
function suggestMainTake(group, now, sungOf) {
  if (!group || group.length < 2) return null;
  var current = primaryVersion(group);
  var win = winningTake(group, now);
  if (win) {
    return win.take === current ? null : { take:win.take, reason:win.plays + ' plays to ' + win.runnerUpPlays + ' lately' };
  }
  if (group.some(function(take) { return take.versionPick === true; })) return null;
  var checked = group.map(function(take) { return { take:take, check:sungOf(take) }; })
    .filter(function(item) { return item.check && item.check.total; });
  if (checked.length < group.length) return null;
  checked.sort(function(a, b) { return b.check.asWritten - a.check.asWritten; });
  if (checked[0].check.asWritten - checked[1].check.asWritten < 2 || checked[0].take === current) return null;
  return { take:checked[0].take, reason:'sang ' + checked[0].check.asWritten + ' of ' + checked[0].check.total + ' lines as written, against ' + checked[1].check.asWritten };
}

// A lyric sheet from the words Whisper heard ([[word, start, end], ...]): a
// new line at a pause of 0.7 seconds or after twelve words, a blank line
// between sections at a pause of three seconds. No section tags: nothing
// heard says which part is the chorus.
function sheetFromWords(words) {
  var lines = [];
  var line = [];
  var lastEnd = null;
  (words || []).forEach(function(item) {
    var text = String(item && item[0] || '').trim();
    var start = Number(item && item[1]);
    var end = Number(item && item[2]);
    if (!text) return;
    var gap = lastEnd === null || !isFinite(start) ? 0 : start - lastEnd;
    if (line.length && (gap >= 0.7 || line.length >= 12)) {
      lines.push(line.join(' '));
      line = [];
      if (gap >= 3) lines.push('');
    }
    line.push(text);
    if (isFinite(end)) lastEnd = end;
  });
  if (line.length) lines.push(line.join(' '));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
