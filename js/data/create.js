// Songs made on the Create page (js/features/create.js) by Google's Lyria,
// through the AI worker's /generate route: reading Gemini's answer, and
// turning its audio into an MP3 whose tag carries the title, lyric sheet and
// cover the way a Suno download's does -- so the cover sweep, the share
// previews and lyric sync treat it like any other track.
// Pure: JSON and bytes in, plain values out.

// The audio and any text in a Gemini generateContent answer, and the reason
// it gave when there is no audio. Parts come in any order. The API sends
// camelCase and its REST docs show snake_case, so both are read.
function readLyriaResponse(body) {
  var candidate = body && Array.isArray(body.candidates) ? body.candidates[0] : null;
  var parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  var audio = null;
  var texts = [];
  parts.forEach(function(part) {
    if (!part || part.thought) return;
    var inline = part.inlineData || part.inline_data;
    var mime = inline ? String(inline.mimeType || inline.mime_type || '') : '';
    if (inline && inline.data && !audio && (!mime || /^audio\//.test(mime))) {
      audio = { mime: mime || 'audio/mpeg', data: String(inline.data) };
    } else if (typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim());
    }
  });
  var reason = '';
  if (!audio) {
    var feedback = body && (body.promptFeedback || body.prompt_feedback);
    reason = String((feedback && (feedback.blockReason || feedback.block_reason)) || (candidate && (candidate.finishReason || candidate.finish_reason)) || '');
    if (reason === 'STOP') reason = '';
  }
  return { audio: audio, texts: texts, reason: reason };
}

// What to tell someone when Lyria sends no audio.
function describeLyriaRefusal(reason) {
  var r = String(reason || '').toUpperCase();
  if (/SAFETY|PROHIBITED|BLOCK|RECITATION|SPII/.test(r)) {
    return 'Lyria turned this one down. It won’t imitate real artists or sing existing songs’ lyrics, so try describing the sound in your own words.';
  }
  return 'Lyria didn’t send any audio' + (r ? ' (' + r.toLowerCase().replace(/_/g, ' ') + ')' : '') + '. Try again.';
}

// A lyric sheet from a JSON song structure: a "lyrics" string anywhere in
// it, or a list of sections each with a name and its lines.
function lyricSheetFromStructure(value, depth) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  if (Array.isArray(value)) {
    var sections = value.map(function(item) {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      var name = String(item.section || item.name || item.type || item.label || item.title || '').trim();
      var body = item.lyrics || item.text || item.lines || item.content || '';
      if (Array.isArray(body)) body = body.filter(function(line) { return typeof line === 'string'; }).join('\n');
      body = String(typeof body === 'string' ? body : '').trim();
      if (!body) return '';
      return (name && !/^\[/.test(body) ? '[' + name.replace(/^\[|\]$/g, '') + ']\n' : '') + body;
    }).filter(Boolean);
    return sections.length ? sections.join('\n\n') : '';
  }
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    var v = value[keys[i]];
    if (/lyric/i.test(keys[i])) {
      if (typeof v === 'string' && v.trim()) return v.trim();
      var fromList = lyricSheetFromStructure(v, depth + 1);
      if (fromList) return fromList;
    }
  }
  for (var j = 0; j < keys.length; j++) {
    if (/section|structure|song|parts|verses/i.test(keys[j])) {
      var nested = lyricSheetFromStructure(value[keys[j]], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

// Lyria sends the words it sang alongside the audio, as plain lines under
// [Section] tags or as a JSON description of the song. Either becomes a
// lyric sheet. A caption or a note about the music is not lyrics: plain text
// counts only with a section tag or four or more lines.
function lyricsFromLyriaText(texts) {
  var list = Array.isArray(texts) ? texts : [texts];
  for (var i = 0; i < list.length; i++) {
    var text = String(list[i] || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!text) continue;
    var parsed = null;
    if (/^[\[{]/.test(text)) {
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    }
    if (parsed) {
      var sheet = lyricSheetFromStructure(parsed, 0);
      if (sheet) return sheet;
      continue;
    }
    text = text.replace(/^lyrics\s*:\s*\n?/i, '').trim();
    var lines = text.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(Boolean);
    var tagged = lines.some(function(line) { return /^\[[^\]]{1,40}\]$/.test(line); });
    if (tagged || lines.length >= 4) return text.replace(/\r\n?/g, '\n');
  }
  return '';
}

// A name for a song saved without one: the opening phrase of its first sung
// line (up to the first comma, at most six words), else the start of the
// sound it was asked for.
function deriveSongTitle(title, lyrics, style) {
  var given = String(title || '').trim();
  if (given) return given;
  var line = (getLyricContentLines(lyrics || '')[0] || '').replace(/^\(|\)$/g, '').trim();
  var phrase = line.split(/\s*[,;:—–]\s*/)[0];
  var words = (phrase.split(/\s+/).length >= 2 ? phrase : line).split(/\s+/).slice(0, 6).join(' ')
    .replace(/[.,;:!?…"]+$/g, '').trim();
  if (words) return words;
  var lead = String(style || '').split(/[,.;\n]/)[0].trim().split(/\s+/).slice(0, 4).join(' ');
  return lead ? lead.charAt(0).toUpperCase() + lead.slice(1) : 'Untitled song';
}

function base64ToBytes(base64) {
  var binary = atob(String(base64 || '').replace(/\s+/g, ''));
  var out = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Whether bytes are an MP3: an ID3 tag, or an MPEG audio frame sync.
function looksLikeMP3(bytes) {
  if (!bytes || bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function songFileName(title) {
  var base = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return (base || 'Untitled song') + '.mp3';
}

// ─── Writing the tag ────────────────────────────────────────────────────────

function id3TextBytes(text, major) {
  var s = String(text || '');
  if (major === 4) return Array.prototype.slice.call(new TextEncoder().encode(s));
  // v2.3 has no UTF-8: UTF-16 with a little-endian byte-order mark.
  var out = [0xff, 0xfe];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    out.push(c & 0xff, c >> 8);
  }
  return out;
}

function id3FrameBytes(id, body, major) {
  var n = body.length;
  var size = major === 4
    ? [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
    : [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  var out = new Uint8Array(10 + n);
  for (var i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  out.set(size, 4);
  out.set(body, 10);
  return out;
}

// A copy of an MP3 whose ID3v2 tag holds the given title (TIT2), lyric sheet
// (USLT) and front cover (APIC, { mime, data }). Frames already in the file
// are kept -- Lyria's own notes about where the audio came from, say -- and
// only the ones written here are replaced. A v2.4 tag stays v2.4; anything
// else becomes v2.3, the version Suno writes. The audio is not touched.
function writeSongTag(audio, info) {
  info = info || {};
  var total = id3TagLength(audio);
  var hasTag = total > 0 && audio.length >= total;
  var major = hasTag && audio[3] === 4 ? 4 : 3;
  var enc = major === 4 ? 3 : 1;
  var frames = [];
  var replaced = {};
  if (info.title) {
    replaced.TIT2 = 1;
    frames.push(id3FrameBytes('TIT2', [enc].concat(id3TextBytes(info.title, major)), major));
  }
  if (info.lyrics) {
    replaced.USLT = 1;
    var descriptor = enc === 1 ? [0xff, 0xfe, 0, 0] : [0];
    frames.push(id3FrameBytes('USLT', [enc, 0x65, 0x6e, 0x67].concat(descriptor, id3TextBytes(info.lyrics, major)), major));
  }
  if (info.cover && info.cover.data && info.cover.data.length) {
    replaced.APIC = 1;
    var mime = String(info.cover.mime || 'image/jpeg');
    var head = [0];
    for (var m = 0; m < mime.length; m++) head.push(mime.charCodeAt(m) & 0x7f);
    head.push(0, 3, 0);
    var apic = new Uint8Array(head.length + info.cover.data.length);
    apic.set(head, 0);
    apic.set(info.cover.data, head.length);
    frames.push(id3FrameBytes('APIC', apic, major));
  }
  // readID3Frames hands back bodies already freed of unsynchronisation and
  // data-length prefixes, so each is written again with clear flags. A v2.2
  // tag's three-letter frames cannot go into a v2.3 one and are dropped.
  var kept = hasTag && audio[3] !== 2 ? readID3Frames(audio).filter(function(frame) {
    return !replaced[frame.id];
  }).map(function(frame) {
    return id3FrameBytes(frame.id, frame.body, major);
  }) : [];
  var all = frames.concat(kept);
  var bodyLength = all.reduce(function(sum, f) { return sum + f.length; }, 0);
  var audioStart = hasTag ? total : 0;
  var out = new Uint8Array(10 + bodyLength + audio.length - audioStart);
  out.set([0x49, 0x44, 0x33, major, 0, 0,
    (bodyLength >> 21) & 0x7f, (bodyLength >> 14) & 0x7f, (bodyLength >> 7) & 0x7f, bodyLength & 0x7f], 0);
  var offset = 10;
  all.forEach(function(f) { out.set(f, offset); offset += f.length; });
  out.set(audio.subarray(audioStart), offset);
  return out;
}
