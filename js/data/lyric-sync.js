// Lyric timing: lining a song's lyric sheet up against the words a speech
// recogniser heard in the audio (the worker's POST /transcribe), and reading
// the current line back out at a playback position. Suno's files carry the
// lyrics but no timings, so this is where the timings come from.
// Pure: strings and numbers in, plain values out.

// "[Verse 1]" in newer Suno exports, "(Verse 1)" in older ones. A bracketed
// line is always a label; a parenthesised one only when it names a section,
// so an ad-lib like "(oh-oh)" stays a sung line.
function isLyricSectionHeader(line) {
  var t = String(line || '').trim();
  if (/^\[[^\]]+\]$/.test(t)) return true;
  return /^\((?:intro|verse|pre-?chorus|chorus|post-?chorus|hook|refrain|bridge|break(?:down)?|interlude|instrumental|solo|drop|build(?:-?up)?|outro|end|fade(?: out)?)\b[^)]*\)$/i.test(t);
}

// Share links made before 2026-10-04 stored their lyrics excerpt with every
// line break collapsed into a space: one long run with the [Verse] tags
// inline. A sheet of any length comes in lines, so a long single line is
// one of those.
function isFlattenedLyrics(text) {
  var t = String(text || '').trim();
  return t.length > 120 && t.indexOf('\n') === -1;
}

// Gives a flattened excerpt its sections back: each [tag] on its own line
// after a gap. The lines inside a section cannot be recovered from the
// text alone (the song file has them -- see js/features/artwork.js).
function unflattenLyrics(text) {
  var t = String(text || '').trim();
  if (!isFlattenedLyrics(t)) return t;
  return t.replace(/\s*(\[[^\]\n]{1,40}\])\s*/g, '\n\n$1\n').trim();
}

// The sheet as rows the player renders: section labels, blank gaps, and the
// sung lines, numbered in order. Timings belong to sung lines only.
function parseLyricSheet(lyrics) {
  var rows = [];
  var sung = 0;
  String(lyrics || '').replace(/\r\n?/g, '\n').split('\n').forEach(function(raw) {
    var text = raw.replace(/\s+$/, '');
    if (!text.trim()) rows.push({ kind:'gap' });
    else if (isLyricSectionHeader(text)) rows.push({ kind:'header', text:text.trim() });
    else rows.push({ kind:'line', text:text, index:sung++ });
  });
  return rows;
}

function sungLyricLines(lyrics) {
  return parseLyricSheet(lyrics).filter(function(row) { return row.kind === 'line'; }).map(function(row) { return row.text; });
}

// Identifies one version of a sheet, so timings stop applying the moment the
// lyrics are edited.
function lyricSyncKey(lyrics) {
  return 'v1:' + hashString(sungLyricLines(lyrics).join('\n'));
}

// Lowercase words with accents, punctuation and apostrophes stripped:
// "It’s" and "its", "Tawan" and "tawan" compare equal.
function lyricWordsOf(text) {
  var plain = String(text || '').toLowerCase();
  if (plain.normalize) plain = plain.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return plain.replace(/['’`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

function editDistance(a, b) {
  if (a === b) return 0;
  var prev = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    var cur = [i];
    for (var k = 1; k <= b.length; k++) {
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// How well a heard word stands for a sheet word: 2 the same, 1 close enough
// that singing or the recogniser bent it ("gonna"/"going", "nandito"/
// "andito"), otherwise a penalty.
function wordMatchScore(a, b) {
  if (a === b) return 2;
  var longest = Math.max(a.length, b.length);
  if (longest >= 4 && editDistance(a, b) / longest <= .34) return 1;
  if (Math.min(a.length, b.length) >= 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return 1;
  return -1;
}

// Line up the sheet against the heard words: a global alignment that may
// skip words on either side at a small cost -- the recogniser misses lines
// under a loud mix and invents a few words in instrumental passages -- so the
// match follows the order of the song and repeated choruses land on their
// own repeats. Returns one [start, end] per sung line (null where nothing on
// the line was heard), and the share of sheet words that were matched.
// heard: [[word, start, end], ...] as the worker sends it.
function alignLyricsToWords(lyrics, heard) {
  var lines = sungLyricLines(lyrics);
  var sheet = [];
  lines.forEach(function(line, li) {
    lyricWordsOf(line).forEach(function(w) { sheet.push({ w:w, line:li }); });
  });
  var audio = [];
  (heard || []).forEach(function(entry) {
    var start = Number(entry && entry[1]);
    var end = Number(entry && entry[2]);
    if (!isFinite(start) || !isFinite(end)) return;
    lyricWordsOf(entry[0]).forEach(function(w) { audio.push({ w:w, start:start, end:Math.max(start, end) }); });
  });
  var n = sheet.length;
  var m = audio.length;
  var result = { lines:lines.map(function() { return null; }), matched:0 };
  if (!n || !m) return result;

  var SKIP = -.6;
  var width = m + 1;
  var score = new Float32Array((n + 1) * width);
  var move = new Uint8Array((n + 1) * width);   // 1 diagonal, 2 skip sheet word, 3 skip heard word
  for (var i = 1; i <= n; i++) { score[i * width] = i * SKIP; move[i * width] = 2; }
  for (var j = 1; j <= m; j++) { score[j] = j * SKIP; move[j] = 3; }
  for (i = 1; i <= n; i++) {
    var sw = sheet[i - 1].w;
    for (j = 1; j <= m; j++) {
      var diag = score[(i - 1) * width + j - 1] + wordMatchScore(sw, audio[j - 1].w);
      var up = score[(i - 1) * width + j] + SKIP;
      var left = score[i * width + j - 1] + SKIP;
      var at = i * width + j;
      if (diag >= up && diag >= left) { score[at] = diag; move[at] = 1; }
      else if (up >= left) { score[at] = up; move[at] = 2; }
      else { score[at] = left; move[at] = 3; }
    }
  }

  var times = new Array(n);
  i = n; j = m;
  while (i > 0 || j > 0) {
    var step = move[i * width + j];
    if (step === 1) {
      if (wordMatchScore(sheet[i - 1].w, audio[j - 1].w) > 0) times[i - 1] = audio[j - 1];
      i--; j--;
    } else if (step === 2) {
      i--;
    } else {
      j--;
    }
  }

  var matched = 0;
  var lead = [];    // words sung before the first one heard, per line
  var position = 0;
  sheet.forEach(function(entry, k) {
    if (k > 0 && sheet[k - 1].line !== entry.line) position = 0;
    var hit = times[k];
    if (hit) {
      matched++;
      var span = result.lines[entry.line];
      if (!span) {
        result.lines[entry.line] = [hit.start, hit.end];
        lead[entry.line] = position;
      } else {
        span[1] = Math.max(span[1], hit.end);
      }
    }
    position++;
  });
  // A line whose opening words went unheard ("Thirty-four" transcribed as
  // "34") starts that many words earlier than its first match -- but never
  // before the previous line has finished.
  var previousEnd = 0;
  result.lines.forEach(function(span, li) {
    if (!span) return;
    if (lead[li]) span[0] = Math.max(previousEnd, span[0] - lead[li] * .4);
    span[0] = Math.round(span[0] * 100) / 100;
    previousEnd = span[1];
  });
  result.matched = matched / n;
  return result;
}

// Every sung line's [start, end], with starts that never run backwards.
// Lines the alignment could not place -- or that a hand-made sync has not
// reached -- are spread between their timed neighbours: after the earlier
// one ends when that leaves room, across the whole gap when it does not.
// Before the first timed line they count back from it; after the last they
// run on to the end of the track.
// spans: [[start, end] | null, ...]; duration in seconds.
function resolveLyricTimes(spans, duration) {
  var count = spans ? spans.length : 0;
  var total = Number(duration) || 0;
  var out = [];
  var anchors = [];
  var floor = -Infinity;
  for (var i = 0; i < count; i++) {
    var span = spans[i];
    // Out-of-order times are dropped rather than trusted.
    if (span && isFinite(span[0]) && span[0] > floor) {
      anchors.push(i);
      floor = span[0];
    }
    out.push(null);
  }
  if (!anchors.length) {
    var even = total > 0 ? total / Math.max(1, count) : 4;
    return out.map(function(_, k) { return [k * even, (k + 1) * even]; });
  }
  anchors.forEach(function(a, k) {
    var start = Math.max(0, spans[a][0]);
    var end = Math.max(start, Number(spans[a][1]) || start);
    // A line ends no later than the next timed line starts.
    if (k + 1 < anchors.length) end = Math.min(end, spans[anchors[k + 1]][0]);
    out[a] = [start, end];
  });
  var first = anchors[0];
  var last = anchors[anchors.length - 1];
  var avg = anchors.length > 1 ? Math.max(1.5, (out[last][0] - out[first][0]) / (last - first)) : 3.5;

  for (i = first - 1; i >= 0; i--) {
    out[i] = [Math.max(0, out[i + 1][0] - avg), out[i + 1][0]];
  }
  for (var k = 0; k + 1 < anchors.length; k++) {
    var a0 = anchors[k];
    var a1 = anchors[k + 1];
    var gap = a1 - a0 - 1;
    if (gap <= 0) continue;
    var lo = out[a0][1];
    var hi = out[a1][0];
    var step, g;
    if (hi - lo >= gap * .6) {
      step = (hi - lo) / gap;
      for (g = 1; g <= gap; g++) out[a0 + g] = [lo + step * (g - 1), lo + step * g];
    } else {
      step = (hi - out[a0][0]) / (gap + 1);
      for (g = 1; g <= gap; g++) out[a0 + g] = [out[a0][0] + step * g, out[a0][0] + step * (g + 1)];
    }
  }
  var tail = count - 1 - last;
  if (tail > 0) {
    var from = out[last][1] > out[last][0] ? out[last][1] : out[last][0] + avg;
    var to = total > from + tail * 1.5 ? total : from + tail * avg;
    var stepTail = (to - from) / tail;
    for (var q = 1; q <= tail; q++) out[last + q] = [from + stepTail * (q - 1), from + stepTail * q];
  }
  return out;
}

// The sung line playing at time t, or -1 before the first line and in a
// long instrumental gap after a line has ended. lead pulls each line in a
// moment early so the highlight arrives with the voice, not after it.
function currentLyricIndex(times, t, lead) {
  var at = Number(t) + (typeof lead === 'number' ? lead : .25);
  var idx = -1;
  for (var i = 0; i < times.length; i++) {
    if (times[i][0] <= at) idx = i;
    else break;
  }
  if (idx === -1) return -1;
  var next = times[idx + 1];
  if (at > times[idx][1] + 4 && (!next || next[0] - at > 2)) return -1;
  return idx;
}

// How timings are stored on a track. Firestore cannot hold an array
// directly inside another array -- it rejects the whole document -- so the
// [start, end] pairs are kept as two flat arrays of the same length, null
// where a line is untimed:
//   { key, starts:[s|null...], ends:[e|null...], source, at }
// (The first build stored lines:[[start, end]...]; every save of a timed
// track failed. cloudSafeLyricSync converts those.)
function packLyricSync(lyrics, lines, source, at) {
  var starts = [];
  var ends = [];
  (lines || []).forEach(function(span) {
    var ok = span && isFinite(span[0]);
    starts.push(ok ? Number(span[0]) : null);
    ends.push(ok ? Number(isFinite(span[1]) ? span[1] : span[0]) : null);
  });
  return { key:lyricSyncKey(lyrics), starts:starts, ends:ends, source:source, at:at };
}

// The [start, end] | null per line a stored sync describes, from either shape.
function unpackLyricLines(sync) {
  if (!sync) return null;
  if (Array.isArray(sync.starts)) {
    var ends = Array.isArray(sync.ends) ? sync.ends : [];
    return sync.starts.map(function(start, i) {
      if (start === null || start === undefined || !isFinite(start)) return null;
      var end = ends[i];
      return [Number(start), end === null || end === undefined || !isFinite(end) ? Number(start) : Number(end)];
    });
  }
  if (Array.isArray(sync.lines)) {
    return sync.lines.map(function(span) {
      return span && isFinite(span[0]) ? [Number(span[0]), Number(isFinite(span[1]) ? span[1] : span[0])] : null;
    });
  }
  return null;
}

// A stored sync in the shape Firestore accepts; anything already in it, or
// not a sync at all, comes back unchanged.
function cloudSafeLyricSync(sync) {
  if (!sync || typeof sync !== 'object' || !Array.isArray(sync.lines)) return sync;
  var lines = unpackLyricLines(sync);
  return {
    key:sync.key,
    starts:lines.map(function(span) { return span ? span[0] : null; }),
    ends:lines.map(function(span) { return span ? span[1] : null; }),
    source:sync.source,
    at:sync.at
  };
}

// A hand correction: line index starts at t. Neighbours that would now be
// out of order are pulled just clear of it, so the sheet keeps its order.
function fixLyricLine(spans, index, t) {
  var out = (spans || []).map(function(span) { return span ? [span[0], span[1]] : null; });
  if (index < 0 || index >= out.length) return out;
  var time = Math.max(0, Math.round(Number(t) * 100) / 100);
  var old = out[index];
  var length = old ? Math.max(1, old[1] - old[0]) : 3;
  out[index] = [time, time + length];
  for (var i = index - 1; i >= 0; i--) {
    if (out[i] && out[i][0] >= time) out[i] = null;
  }
  for (i = index + 1; i < out.length; i++) {
    if (out[i] && out[i][0] <= time) out[i] = null;
  }
  return out;
}
