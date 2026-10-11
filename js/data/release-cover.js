// Release covers (js/features/release-cover.js): the words that go with the
// picture -- what it shows, the sound it takes its colours from -- and how
// the title is set on a 3000 x 3000 cover. Distributors allow only the
// release's own title and artist name on a cover: no handles, links or
// logos.
// Pure: tracks and measurements in, plain values out.

var COVER_LOOKS = [
  { id:'painting', label:'Painting' },
  { id:'photo', label:'Photograph' },
  { id:'illustration', label:'Illustration' },
  { id:'abstract', label:'Abstract' }
];
var COVER_TEXT_MODES = [
  { id:'both', label:'Title and artist' },
  { id:'title', label:'Title only' },
  { id:'none', label:'No words' }
];

// What the picture shows, to start from: a scene of the title, and what
// the song is about when Claude has said. A summary describes the song, not
// a picture, so it is offered beside the field rather than put in it.
function releaseCoverScene(track) {
  var title = baseSongTitle(String(track && track.title || '').trim());
  var theme = getTrackAITheme(track);
  if (!title) return theme ? 'A scene about ' + theme.toLowerCase() : '';
  return 'A scene of ' + title.toLowerCase() + (theme ? ', about ' + theme.toLowerCase() : '');
}

// The sound the picture takes its mood and colours from: the song's own
// Suno style, else its genre, mood, theme and tags.
function releaseCoverStyle(track) {
  var prompt = String(track && track.prompt || '').replace(/\s+/g, ' ').trim();
  if (prompt) return trimText(prompt, 400);
  var tags = Array.isArray(track && track.aiTags) ? track.aiTags.slice(0, 5) : [];
  return [track && track.genre !== 'Other' ? track.genre : '', track && track.mood, getTrackAITheme(track)]
    .concat(tags).filter(Boolean).join(', ');
}

// Words into lines no wider than maxWidth, greedily. width(text) measures a
// line. A single word wider than the line keeps a line of its own.
function wrapCoverWords(words, width, maxWidth) {
  var lines = [];
  var line = '';
  words.forEach(function(word) {
    var next = line ? line + ' ' + word : word;
    if (line && width(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines;
}

// The title as large as it goes: at most maxLines lines (2) no wider than
// maxWidth, from maxSize down by 4% a step to minSize. measure(text, size)
// gives a line's width at a size. { size, lines }; at minSize the lines are
// whatever fits, however many.
function fitCoverTitle(title, measure, opts) {
  var words = String(title || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { size:0, lines:[] };
  var maxLines = opts.maxLines || 2;
  for (var size = opts.maxSize; size > opts.minSize; size = Math.floor(size * 0.96)) {
    var at = size;
    var lines = wrapCoverWords(words, function(text) { return measure(text, at); }, opts.maxWidth);
    if (lines.length <= maxLines && lines.every(function(line) { return measure(line, at) <= opts.maxWidth; })) {
      return { size:size, lines:lines };
    }
  }
  return { size:opts.minSize, lines:wrapCoverWords(words, function(text) { return measure(text, opts.minSize); }, opts.maxWidth) };
}

// "Pauwi - cover.jpg", without the characters Windows refuses in a name.
function coverFileName(title) {
  var name = String(title || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return (name ? name + ' - ' : '') + 'cover.jpg';
}
