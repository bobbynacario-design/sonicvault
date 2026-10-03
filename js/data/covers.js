// Cover and colour identity: the generated cover styles, the per-track
// palette, genre/mood colours, and the whitelist of playlist accents.
// Pure: no DOM, no app state, nothing outside js/data.

function sourceWeight(source) {
  var map = { Suno: 12, Udio: 20, Original: 35, Other: 8 };
  return map[source] || 0;
}

function moodWeight(mood) {
  var map = {
    Energetic: 20, Chill: 120, Intense: 355, Dreamy: 276, Warm: 34,
    Playful: 160, Melancholic: 220, Uplifting: 52, Dark: 320
  };
  return map[mood] || 0;
}

function getGenreColor(genre) {
  var map = {
    'Synthwave':'#F08B62','Lo-fi':'#AE90FF','Electronic':'#79A6FF',
    'Ambient':'#72D3B2','Hip Hop':'#F3CA78','Rock':'#FF7C74',
    'Pop':'#FF96BE','Folk':'#DAB27C','Jazz':'#7EC8E5',
    'Classical':'#CDB8A1','R&B':'#D89DFF','Chiptune':'#87E9A7',
    'Metal':'#D36969','Country':'#CCA468','Other':'#8E93A8'
  };
  return map[genre] || '#F08B62';
}

function getMoodColor(mood) {
  var map = {
    Energetic:'#ff8f7a', Chill:'#79a6ff', Intense:'#ff7c74', Dreamy:'#b79cff',
    Warm:'#f4b46f', Playful:'#82ddb6', Melancholic:'#7b96c8', Uplifting:'#f7cb7a', Dark:'#786fa6'
  };
  return map[mood] || '#f08b62';
}

var COVER_STYLES = [
  { id:'aurora', name:'Aurora' },
  { id:'vinyl', name:'Vinyl' },
  { id:'poster', name:'Poster' },
  { id:'scope', name:'Scope' },
  { id:'prism', name:'Prism' },
  { id:'mono', name:'Mono' },
  { id:'pulse', name:'Pulse' },
  { id:'tape', name:'Tape' }
];

function getCoverStyleIds() {
  return COVER_STYLES.map(function(style) { return style.id; });
}

function getCoverStyleName(id) {
  var match = COVER_STYLES.find(function(style) { return style.id === id; });
  return match ? match.name : 'Aurora';
}

function getCoverStyle(track) {
  var current = String(track && track.coverStyle || '').trim();
  if (getCoverStyleIds().indexOf(current) !== -1) return current;
  var base = [
    track && track.title,
    track && track.genre,
    track && track.mood,
    track && track.aiTheme,
    track && track.aiEnergy,
    track && track.source
  ].join('|');
  var ids = getCoverStyleIds();
  return ids[hashString(base) % ids.length] || 'aurora';
}

function getNextCoverStyle(current) {
  var ids = getCoverStyleIds();
  var idx = ids.indexOf(current);
  return ids[(idx + 1 + ids.length) % ids.length] || 'aurora';
}

function normalizeCoverStyle(value, fallbackTrack) {
  var style = String(value || '').trim().toLowerCase();
  if (getCoverStyleIds().indexOf(style) !== -1) return style;
  return getCoverStyle(fallbackTrack || {});
}

function inferCoverStyle(input, metadata) {
  var text = lower([
    input && input.title,
    input && input.prompt,
    input && input.lyrics,
    metadata && metadata.aiGenre,
    metadata && metadata.aiMood,
    metadata && metadata.aiTheme,
    metadata && metadata.aiEnergy,
    metadata && metadata.aiVocalStyle,
    metadata && metadata.aiEra,
    (metadata && metadata.aiTags || []).join(' ')
  ].join(' '));
  if (/\b(vinyl|analog|dusty|classic|retro|old soul|jazz|soul|r&b|blues)\b/.test(text)) return 'vinyl';
  if (/\b(poster|anthem|radio|pop|headline|hook|stadium|arena)\b/.test(text)) return 'poster';
  if (/\b(scope|cinematic|ambient|dream|moon|ocean|shore|sky|horizon|wide|film)\b/.test(text)) return 'scope';
  if (/\b(prism|neon|synthwave|electronic|cyber|future|arcade|vhs|chrome|laser)\b/.test(text)) return 'prism';
  if (/\b(mono|minimal|blackout|dark|shadow|noir|haunted|empty|alone)\b/.test(text)) return 'mono';
  if (/\b(pulse|club|edm|dance|drop|808|trap|high energy|fast|rush)\b/.test(text)) return 'pulse';
  if (/\b(tape|lo-fi|lofi|cassette|bedroom|demo|acoustic|folk|country|home)\b/.test(text)) return 'tape';
  return getCoverStyle({
    title: input && input.title,
    genre: metadata && metadata.aiGenre || input && input.genre,
    mood: metadata && metadata.aiMood || input && input.mood,
    aiTheme: metadata && metadata.aiTheme,
    aiEnergy: metadata && metadata.aiEnergy,
    source: input && input.source || 'Suno'
  });
}

function getTrackPalette(track) {
  var base = hashString((track && track.title || '') + '|' + (track && track.genre || '') + '|' + (track && track.mood || '') + '|' + (track && track.source || ''));
  var hue = (base % 360 + moodWeight(track && track.mood) + sourceWeight(track && track.source)) % 360;
  var hue2 = (hue + 44 + (base % 60)) % 360;
  var hue3 = (hue + 130 + (base % 80)) % 360;
  return {
    a: 'hsl(' + hue + ' 42% 50%)',
    b: 'hsl(' + hue2 + ' 38% 53%)',
    c: 'hsl(' + hue3 + ' 30% 24%)',
    accent: 'hsl(' + ((hue + 8) % 360) + ' 54% 63%)',
    soft: 'hsla(' + hue + ', 50%, 54%, .1)',
    deep: 'hsla(' + hue + ', 34%, 18%, .18)',
    angle: (base % 150) + 18
  };
}

function getTrackMonogram(title) {
  var words = String(title || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'SV';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Whitelist of allowed playlist accent colors. Anything not in this set
// is coerced to the default. Keeps the inline style attribute safe and
// the visual palette consistent across the app.
var PLAYLIST_COLOR_OPTIONS = [
  { value:'#F08B62', label:'Coral' },
  { value:'#78D0A4', label:'Green' },
  { value:'#79A6FF', label:'Blue' },
  { value:'#A794FF', label:'Violet' },
  { value:'#F3CA78', label:'Amber' },
  { value:'#FF7C74', label:'Red' }
];
var PLAYLIST_COLOR_DEFAULT = '#F08B62';
var PLAYLIST_COLOR_SET = (function() {
  var set = {};
  PLAYLIST_COLOR_OPTIONS.forEach(function(opt) { set[opt.value.toUpperCase()] = true; });
  return set;
})();
function safePlaylistColor(c) {
  if (typeof c !== 'string') return PLAYLIST_COLOR_DEFAULT;
  return PLAYLIST_COLOR_SET[c.toUpperCase()] ? c : PLAYLIST_COLOR_DEFAULT;
}

// Emit a CSS variable bundle from a playlist's accent color so child
// elements can use var(--pl-accent) instead of repeating raw hex values.
function playlistAccentVars(pl) {
  var c = safePlaylistColor(pl && pl.color);
  return '--pl-accent:' + c + ';--pl-accent-rim:' + c + '66;--pl-accent-soft:' + c + '1f';
}
