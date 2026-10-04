// Search by meaning: each song as one vector of what it is about (BGE-M3,
// through the AI worker's /embed), compared with a query's vector. Vectors
// arrive normalised, so similarity is a dot product. They are kept on the
// device as 1024 signed bytes plus a scale -- about 1.4KB a song in base64.
// Pure: text and numbers in, numbers out.

var MEANING_MODEL = 'bge-m3';
var MEANING_TEXT_LIMIT = 3600;

// What a song is, in words, for its vector: title, description, themes,
// tags, mood and genre, the prompt, then the lyrics while there is room.
function songMeaningText(track) {
  var parts = [
    String(track && track.title || '').trim(),
    getTrackSummary(track),
    getTrackAITheme(track) ? 'Themes: ' + getTrackAITheme(track) : '',
    getTrackAITags(track).length ? 'Tags: ' + getTrackAITags(track).join(', ') : '',
    [track && track.aiMood, track && track.mood, track && track.aiGenre, track && track.genre].filter(Boolean).join(', '),
    String(track && track.prompt || '').trim(),
    getLyricContentLines(getTrackLyrics(track)).join(' / ')
  ].filter(Boolean);
  return parts.join('. ').slice(0, MEANING_TEXT_LIMIT);
}

// { scale, data: base64 of Int8Array } for a float vector.
function packMeaningVector(vector) {
  var max = 0;
  for (var i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]));
  var scale = max || 1;
  var bytes = new Int8Array(vector.length);
  for (i = 0; i < vector.length; i++) bytes[i] = Math.round(vector[i] / scale * 127);
  var binary = '';
  var u8 = new Uint8Array(bytes.buffer);
  for (i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return { scale: scale, data: btoa(binary) };
}

function unpackMeaningVector(packed) {
  if (!packed || !packed.data) return null;
  var binary = atob(packed.data);
  var bytes = new Int8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = (binary.charCodeAt(i) << 24) >> 24;
  var scale = Number(packed.scale) / 127;
  var out = new Float32Array(bytes.length);
  for (i = 0; i < bytes.length; i++) out[i] = bytes[i] * scale;
  return out;
}

function meaningSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dot = 0;
  var na = 0;
  var nb = 0;
  for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// The songs a query is about, best first: those within reach of the best
// match (similarities between unrelated texts sit around .35-.45 with this
// model, so the ranking matters more than any fixed cut-off), at most `limit`.
// scored: [{ id, score }] for every indexed song.
function rankMeaningMatches(scored, limit) {
  var sorted = scored.slice().sort(function(a, b) { return b.score - a.score; });
  if (!sorted.length) return [];
  var top = sorted[0].score;
  var floor = Math.max(.3, top - .12);
  return sorted.filter(function(item) { return item.score >= floor; }).slice(0, limit || 24);
}

// A playlist for a description: the songs closest to it, best first. A
// wider reach than search (a playlist wants more than the one song asked
// about): those within .2 of the best match, at least `min` when there are
// that many, at most `max`. scored: [{ id, score }].
function pickPlaylistByMeaning(scored, min, max) {
  var sorted = scored.slice().sort(function(a, b) { return b.score - a.score; });
  if (!sorted.length) return [];
  var least = min || 6;
  var floor = Math.max(.25, sorted[0].score - .2);
  var picked = sorted.filter(function(item) { return item.score >= floor; });
  if (picked.length < least) picked = sorted.slice(0, least);
  return picked.slice(0, max || 20).map(function(item) { return item.id; });
}

// "songs for a rainy sunday drive." -> "Songs for a rainy sunday drive".
function playlistNameFromSentence(text) {
  var name = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (!name) return 'New playlist';
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name.length > 60 ? name.slice(0, 57).replace(/\s+\S*$/, '') + '…' : name;
}
