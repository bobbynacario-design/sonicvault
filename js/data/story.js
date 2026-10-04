// Story clips: a song as a short vertical video (1080x1920) to post as an
// Instagram, Facebook or TikTok story -- the cover, the lines as they are
// sung, and the sound moving under them. This file is the arithmetic: which
// part of the song to use, how text wraps, what the browser can record.
// js/features/story.js draws and records.
// Pure: numbers and strings in, plain values out.

var STORY_WIDTH = 1080;
var STORY_HEIGHT = 1920;
var STORY_LENGTHS = [15, 30];
var STORY_LEAD_IN = .8;   // seconds of music before the first line, so the voice doesn't start on frame one

// Where a clip starts: just before the first chorus when the lyrics are
// timed, else just before the line sung most, else where the singing
// starts. With no timings, a third of the way in, where a Suno song is
// usually past its intro.
// rows: parseLyricSheet(lyrics); times: [[start, end]...] per sung line,
// real timings only (null when the lyrics are not timed).
// Returns { start, reason: 'chorus' | 'hook' | 'first-line' | 'middle' }.
function pickStoryStart(rows, times, duration, length) {
  var latest = Math.max(0, (Number(duration) || 0) - (Number(length) || 15));
  function at(t, reason) {
    return { start:Math.round(Math.min(latest, Math.max(0, t)) * 10) / 10, reason:reason };
  }
  if (times && times.length) {
    var section = '';
    var i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind === 'header') section = row.text;
      else if (row.kind === 'line' && times[row.index] && /chorus|hook|refrain/i.test(section) && !/(pre|post)-?chorus/i.test(section)) {
        return at(times[row.index][0] - STORY_LEAD_IN, 'chorus');
      }
    }
    var seen = {};
    var best = -1;
    var bestCount = 1;
    rows.forEach(function(row) {
      if (row.kind !== 'line') return;
      var key = lyricWordsOf(row.text).join(' ');
      if (!key) return;
      if (!seen[key]) seen[key] = { first:row.index, count:0 };
      seen[key].count++;
      if (seen[key].count > bestCount) {
        bestCount = seen[key].count;
        best = seen[key].first;
      }
    });
    if (best >= 0 && times[best]) return at(times[best][0] - STORY_LEAD_IN, 'hook');
    if (times[0]) return at(times[0][0] - STORY_LEAD_IN, 'first-line');
  }
  return at((Number(duration) || 0) / 3, 'middle');
}

// Words into lines no wider than maxWidth, by the caller's measure (a
// canvas's measureText). Past maxLines the last line ends in an ellipsis.
// A single word wider than the line keeps a line to itself.
function wrapStoryText(text, measure, maxWidth, maxLines) {
  var words = String(text || '').trim().split(/\s+/).filter(Boolean);
  var lines = [];
  var line = '';
  words.forEach(function(word) {
    var next = line ? line + ' ' + word : word;
    if (!line || measure(next) <= maxWidth) {
      line = next;
      return;
    }
    lines.push(line);
    line = word;
  });
  if (line) lines.push(line);
  if (!maxLines || lines.length <= maxLines) return lines;
  var kept = lines.slice(0, maxLines);
  var last = kept[maxLines - 1];
  while (last.indexOf(' ') !== -1 && measure(last + '…') > maxWidth) last = last.replace(/\s+\S+$/, '');
  kept[maxLines - 1] = last + '…';
  return kept;
}

// What to record in, best first. MP4 leads because Instagram and the
// iPhone's Photos app won't take WebM; Chrome records MP4 from version 126,
// Safari only records MP4.
var STORY_FORMATS = [
  { type:'video/mp4;codecs=avc1,mp4a.40.2', ext:'mp4' },
  { type:'video/mp4;codecs=avc1.640028,mp4a.40.2', ext:'mp4' },
  { type:'video/mp4;codecs=avc1,opus', ext:'mp4' },
  { type:'video/mp4', ext:'mp4' },
  { type:'video/webm;codecs=vp9,opus', ext:'webm' },
  { type:'video/webm;codecs=vp8,opus', ext:'webm' },
  { type:'video/webm', ext:'webm' }
];

function pickStoryFormat(isTypeSupported) {
  for (var i = 0; i < STORY_FORMATS.length; i++) {
    try {
      if (isTypeSupported(STORY_FORMATS[i].type)) return STORY_FORMATS[i];
    } catch (e) {}
  }
  return null;
}

function storyFileName(title, ext) {
  var base = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return (base || 'Song') + ' - SonicVault clip.' + (ext || 'mp4');
}

// An analyser's frequency bins (0-255 each) as `count` bar heights from 0
// to 1, low notes first. Bars are spaced more finely at the low end, where
// the music is, and lifted a little so quiet passages still move.
function storyBarLevels(freq, count) {
  var n = freq ? freq.length : 0;
  var out = [];
  var lo = 2;
  var hi = Math.max(lo + count, Math.floor(n * .6));
  for (var i = 0; i < count; i++) {
    if (!n) { out.push(0); continue; }
    var a = Math.floor(lo + (hi - lo) * Math.pow(i / count, 1.8));
    var b = Math.max(a + 1, Math.floor(lo + (hi - lo) * Math.pow((i + 1) / count, 1.8)));
    var sum = 0;
    var used = 0;
    for (var j = a; j < b && j < n; j++) { sum += freq[j]; used++; }
    var v = used ? sum / used / 255 : 0;
    out.push(Math.min(1, Math.pow(v, 1.5) * 1.3));
  }
  return out;
}

// Opacity of the whole frame: in from black at the start, out at the end.
function storyFade(t, length) {
  if (t < .35) return Math.max(0, t / .35);
  if (t > length - .6) return Math.max(0, (length - t) / .6);
  return 1;
}

// 'hsl(200 80% 62%)' or 'hsla(200, 80%, 62%, .5)' at another opacity, for
// gradients that fade a colour out rather than through grey.
function hslWithAlpha(color, alpha) {
  var m = /hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(String(color || ''));
  if (!m) return 'rgba(255, 255, 255, ' + alpha + ')';
  return 'hsla(' + m[1] + ', ' + m[2] + '%, ' + m[3] + '%, ' + alpha + ')';
}
