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
// the line was heard), the share of sheet words that were matched, what was
// heard on each line, and when each sheet word was heard (words: one start
// per lyricWordsOf word, line after line, null where none lined up -- the
// karaoke timings).
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
  var result = {
    lines:lines.map(function() { return null; }),
    matched:0,
    heard:lines.map(function() { return ''; }),
    words:sheet.map(function() { return null; })
  };
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
  var paired = new Array(n);   // the heard word each sheet word lined up with, matching or not
  i = n; j = m;
  while (i > 0 || j > 0) {
    var step = move[i * width + j];
    if (step === 1) {
      if (wordMatchScore(sheet[i - 1].w, audio[j - 1].w) > 0) times[i - 1] = audio[j - 1];
      paired[i - 1] = j - 1;
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
  result.words = sheet.map(function(entry, k) { return times[k] ? Math.round(times[k].start * 100) / 100 : null; });
  // What was heard on each line: every heard word from the first to the last
  // one lined up with the line's words, so a sung substitution or an extra
  // word inside the line is kept. '' for a line nothing lined up with.
  var first = [];
  var last = [];
  sheet.forEach(function(entry, k) {
    var at = paired[k];
    if (at === undefined) return;
    if (first[entry.line] === undefined || at < first[entry.line]) first[entry.line] = at;
    if (last[entry.line] === undefined || at > last[entry.line]) last[entry.line] = at;
  });
  result.heard = lines.map(function(line, li) {
    if (first[li] === undefined) return '';
    return audio.slice(first[li], last[li] + 1).map(function(word) { return word.w; }).join(' ');
  });
  return result;
}

// ── What was sung against what was written ──────────────────────────────────

// Words that sound alike when sung, so neither counts as a change.
var SUNG_ALIKE = [
  ['to', 'too', 'two'], ['you', 'ya', 'yah'], ['gonna', 'going'], ['wanna', 'want'], ['gotta', 'got'],
  ['cause', 'because', 'cuz', 'coz'], ['til', 'till', 'until'], ['oh', 'ooh', 'o'], ['yeah', 'yea'],
  ['okay', 'ok'], ['alright', 'allright'], ['tonight', 'tonite'], ['thru', 'through'], ['nothin', 'nothing']
];
var SUNG_ALIKE_GROUP = (function() {
  var map = {};
  SUNG_ALIKE.forEach(function(group, gi) { group.forEach(function(word) { map[word] = gi; }); });
  return map;
})();

// Stricter than wordMatchScore, which lets timing ride over bent words:
// here "chips" and "ships" are different words. The same word, its plural,
// a dropped g ("holdin"), a one-letter slip in a long word, or a sung-alike
// pair count as sung as written.
function sungWordMatch(a, b) {
  if (a === b) return 2;
  if (SUNG_ALIKE_GROUP[a] !== undefined && SUNG_ALIKE_GROUP[a] === SUNG_ALIKE_GROUP[b]) return 2;
  if (a.replace(/s$/, '') === b.replace(/s$/, '')) return 1;
  if (a.replace(/g$/, '') === b.replace(/g$/, '') && Math.min(a.length, b.length) >= 4) return 1;
  if (Math.max(a.length, b.length) >= 7 && editDistance(a, b) <= 1) return 1;
  return -1;
}

// One written line against what was heard on it, word by word: each written
// word 'ok', 'changed' (another word was sung in its place) or 'missing';
// each heard word 'ok', 'changed' or 'extra'. Written words keep their
// punctuation for display. A line `differs` when a word of three letters or
// more was changed or missing: the recogniser drops "a" and "I" under a mix
// often enough that counting them would flag every line.
function compareSungLine(written, heard) {
  var tokens = String(written || '').split(/\s+/).filter(Boolean).map(function(text) {
    return { text:text, words:lyricWordsOf(text), status:'ok', heard:[] };
  });
  var sheet = [];
  tokens.forEach(function(token, ti) { token.words.forEach(function(w) { sheet.push({ w:w, token:ti, status:'ok' }); }); });
  var audio = lyricWordsOf(heard).map(function(w) { return { w:w, status:'ok' }; });
  if (!audio.length) {
    return { tokens:tokens.map(function(t) { return { text:t.text, status:'unheard' }; }), heard:[], differs:false, unheard:true };
  }
  var n = sheet.length;
  var m = audio.length;
  var SKIP = -.6;
  var score = [];
  var move = [];
  for (var i = 0; i <= n; i++) { score[i] = []; move[i] = []; }
  for (i = 0; i <= n; i++) { score[i][0] = i * SKIP; move[i][0] = 2; }
  for (var j = 0; j <= m; j++) { score[0][j] = j * SKIP; move[0][j] = 3; }
  for (i = 1; i <= n; i++) {
    for (j = 1; j <= m; j++) {
      var diag = score[i - 1][j - 1] + sungWordMatch(sheet[i - 1].w, audio[j - 1].w);
      var up = score[i - 1][j] + SKIP;
      var left = score[i][j - 1] + SKIP;
      if (diag >= up && diag >= left) { score[i][j] = diag; move[i][j] = 1; }
      else if (up >= left) { score[i][j] = up; move[i][j] = 2; }
      else { score[i][j] = left; move[i][j] = 3; }
    }
  }
  i = n; j = m;
  while (i > 0 || j > 0) {
    var step = i > 0 && j > 0 ? move[i][j] : (i > 0 ? 2 : 3);
    if (step === 1) {
      if (sungWordMatch(sheet[i - 1].w, audio[j - 1].w) <= 0) {
        sheet[i - 1].status = 'changed';
        audio[j - 1].status = 'changed';
        tokens[sheet[i - 1].token].heard.unshift(audio[j - 1].w);
      }
      i--; j--;
    } else if (step === 2) {
      sheet[i - 1].status = 'missing';
      i--;
    } else {
      audio[j - 1].status = 'extra';
      j--;
    }
  }
  var differs = false;
  sheet.forEach(function(entry) {
    if (entry.status === 'ok') return;
    var token = tokens[entry.token];
    if (token.status !== 'changed') token.status = entry.status;
    if (entry.w.length >= 3) differs = true;
  });
  return {
    tokens:tokens.map(function(t) { return { text:t.text, status:t.status, heard:t.heard.join(' ') }; }),
    heard:audio.map(function(a) { return { text:a.w, status:a.status }; }),
    differs:differs,
    unheard:false
  };
}

// Every sung line of a sheet against the heard text stored with its timing:
// how many were sung as written, how many differ, how many weren't heard.
function checkSungLyrics(lyrics, heardLines) {
  var lines = sungLyricLines(lyrics).map(function(line, i) {
    var result = compareSungLine(line, heardLines ? heardLines[i] : '');
    result.text = line;
    return result;
  });
  var differ = lines.filter(function(line) { return line.differs; }).length;
  var unheard = lines.filter(function(line) { return line.unheard; }).length;
  return { lines:lines, total:lines.length, differ:differ, unheard:unheard, asWritten:lines.length - differ - unheard };
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
// heard (optional): the text heard on each sung line, for checking what was
// sung against what was written. A flat array of strings, which Firestore
// accepts.
// words (optional): when each sheet word was heard (alignLyricsToWords'
// words), for karaoke. A flat array of numbers and nulls.
function packLyricSync(lyrics, lines, source, at, heard, words) {
  var starts = [];
  var ends = [];
  (lines || []).forEach(function(span) {
    var ok = span && isFinite(span[0]);
    starts.push(ok ? Number(span[0]) : null);
    ends.push(ok ? Number(isFinite(span[1]) ? span[1] : span[0]) : null);
  });
  var packed = { key:lyricSyncKey(lyrics), starts:starts, ends:ends, source:source, at:at };
  if (Array.isArray(heard)) packed.heard = heard.map(function(text) { return String(text || ''); });
  if (Array.isArray(words)) {
    packed.words = words.map(function(t) { return typeof t === 'number' && isFinite(t) ? Math.round(t * 100) / 100 : null; });
  }
  return packed;
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
  var safe = {
    key:sync.key,
    starts:lines.map(function(span) { return span ? span[0] : null; }),
    ends:lines.map(function(span) { return span ? span[1] : null; }),
    source:sync.source,
    at:sync.at
  };
  if (Array.isArray(sync.heard)) safe.heard = sync.heard.slice();
  if (Array.isArray(sync.words)) safe.words = sync.words.slice();
  return safe;
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

// ── Karaoke: word by word ───────────────────────────────────────────────────

// Where each sung line's words begin in a sheet's flat word list
// (alignLyricsToWords' words, lyricSync.words), and how many there are.
function lyricWordOffsets(lyrics) {
  var offsets = [];
  var total = 0;
  sungLyricLines(lyrics).forEach(function(line) {
    offsets.push(total);
    total += lyricWordsOf(line).length;
  });
  return { offsets:offsets, total:total };
}

// A sung line as the words to light up in turn, each with when it starts
// and ends. span: the line's [start, end]. starts: when each of its sheet
// words (lyricWordsOf order) was heard, null where it wasn't, or nothing at
// all. Heard times outside the line -- a line re-timed by hand since -- or
// out of order are dropped, and the words without a time are spread between
// the known ones by their length, so the words always run through the line
// in order. Returns [{ text, space, start, end }]: each word as written with
// the space after it; a bit with no letters ("—") rides with the word before.
function karaokeWords(line, span, starts) {
  var chunks = String(line || '').split(/(\s+)/);
  var words = [];
  for (var i = 0; i < chunks.length; i += 2) {
    var text = chunks[i];
    var space = chunks[i + 1] || '';
    if (!text) continue;
    var tokens = lyricWordsOf(text).length;
    if (!tokens && words.length) {
      var prev = words[words.length - 1];
      prev.text += prev.space + text;
      prev.space = space;
      continue;
    }
    words.push({ text:text, space:space, tokens:tokens });
  }
  var lineStart = span && isFinite(span[0]) ? Number(span[0]) : 0;
  var lineEnd = span && isFinite(span[1]) ? Math.max(lineStart, Number(span[1])) : lineStart;
  var tokenList = lyricWordsOf(line);
  var count = tokenList.length;
  var weight = tokenList.map(function(token) { return token.length + 1; });
  var times = new Array(count);
  var last = -Infinity;
  for (var k = 0; k < count; k++) {
    var t = starts ? starts[k] : null;
    if (typeof t === 'number' && isFinite(t) && t >= lineStart - .3 && t <= lineEnd + .3 && t > last) {
      times[k] = Math.max(lineStart, Math.min(lineEnd, t));
      last = times[k];
    } else {
      times[k] = null;
    }
  }
  // Fill each run of untimed words between two known moments.
  var a = -1;
  while (a < count) {
    var b = a + 1;
    while (b < count && times[b] === null) b++;
    if (b > a + 1) {
      var from = a >= 0 ? a : 0;
      var base = a >= 0 ? times[a] : lineStart;
      var until = b < count ? times[b] : lineEnd;
      var total = 0;
      for (k = from; k < b; k++) total += weight[k];
      var run = 0;
      for (k = from; k < b; k++) {
        if (k > a) times[k] = base + Math.max(0, until - base) * (total ? run / total : 0);
        run += weight[k];
      }
    }
    a = b;
  }
  var at = 0;
  words.forEach(function(word) {
    word.start = at < count ? times[at] : lineEnd;
    at += word.tokens;
  });
  return words.map(function(word, w) {
    var next = words[w + 1];
    var end = next ? next.start : lineEnd;
    return {
      text:word.text,
      space:word.space,
      start:Math.round(word.start * 100) / 100,
      end:Math.round(Math.max(word.start, end) * 100) / 100
    };
  });
}
