// Synced lyrics as LRC files, the format lyric services take (Musixmatch,
// and through it Spotify and Instagram; most players read it too): a
// timestamp before each sung line, and with word timings the "enhanced"
// form, a timestamp before each word. Built from a song's lyric timings
// (lyricSync, js/features/lyric-sync.js).
// Pure: strings and numbers in, text out.

// [mm:ss.xx], to the hundredth of a second.
function lrcTime(seconds) {
  var cs = Math.max(0, Math.round(Number(seconds) * 100) || 0);
  var m = Math.floor(cs / 6000);
  var s = Math.floor(cs % 6000 / 100);
  var x = cs % 100;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (x < 10 ? '0' : '') + x;
}

function lrcTag(text) {
  return String(text || '').replace(/[\[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// meta: { title, artist, duration }. times: resolved [start, end] per sung
// line (resolveLyricTimes). wordStarts: lyricSync.words, or null. words:
// whether to write the word-by-word form. An empty timestamped line clears
// the screen where the singing stops for more than three seconds, and
// after the last line.
function buildLRC(meta, lyrics, times, wordStarts, words) {
  var info = meta || {};
  var lines = sungLyricLines(lyrics);
  var place = lyricWordOffsets(lyrics);
  var out = [];
  if (lrcTag(info.title)) out.push('[ti:' + lrcTag(info.title) + ']');
  if (lrcTag(info.artist)) out.push('[ar:' + lrcTag(info.artist) + ']');
  if (Number(info.duration) > 0) out.push('[length:' + lrcTime(info.duration).slice(0, 5) + ']');
  out.push('[by:SonicVault]');
  lines.forEach(function(line, i) {
    var span = times && times[i];
    if (!span) return;
    var text = line.trim();
    var end = span[1];
    if (words) {
      var starts = wordStarts ? wordStarts.slice(place.offsets[i], place.offsets[i] + lyricWordsOf(line).length) : null;
      var parts = karaokeWords(line, span, starts);
      if (parts.length) {
        text = parts.map(function(word) { return '<' + lrcTime(word.start) + '>' + word.text + word.space; }).join('').trim()
          + ' <' + lrcTime(parts[parts.length - 1].end) + '>';
      }
    }
    out.push('[' + lrcTime(span[0]) + ']' + text);
    var next = times[i + 1];
    if (!next || next[0] - end > 3) out.push('[' + lrcTime(end) + ']');
  });
  return out.join('\n') + '\n';
}

function lrcFileName(title, words) {
  var base = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Song';
  return base + (words ? ' (word by word)' : '') + '.lrc';
}
