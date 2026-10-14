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
// Where the words go. At the top, for a picture whose subject stands low
// down -- the figure on a rooftop under a wide sky that the title would
// otherwise cover (You Were the Weather, 2026-10-12).
var COVER_PLACES = [
  { id:'bottom', label:'At the bottom' },
  { id:'top', label:'At the top' }
];

// How bright a patch of picture is, 0 (black) to 255 (white): the mean
// light of its pixels, from RGBA bytes as canvas getImageData gives them.
function coverLuminance(rgba) {
  var data = rgba || [];
  var total = 0;
  var count = 0;
  for (var i = 0; i + 2 < data.length; i += 4) {
    total += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    count++;
  }
  return count ? total / count : 0;
}

// The ink for the words over that patch: white over a dark shade on a dark
// picture, as before; dark over a soft light veil on a bright one, so pale
// skies (watercolour) keep their light instead of gaining a dark band.
var COVER_BRIGHT = 165;
function coverInk(luminance) {
  if (luminance >= COVER_BRIGHT) {
    return { title:'#18202c', artist:'rgba(24,32,44,0.84)', shade:'rgba(255,255,255,0.4)', glow:'rgba(255,255,255,0.45)' };
  }
  return { title:'#ffffff', artist:'rgba(255,255,255,0.86)', shade:'rgba(0,0,0,0.62)', glow:'rgba(0,0,0,0.35)' };
}

// What the picture shows, to start from: a scene of the title, and what
// the song is about when Claude has said. A summary describes the song, not
// a picture, so it is offered beside the field rather than put in it.
function releaseCoverScene(track) {
  var title = baseSongTitle(String(track && track.title || '').trim());
  var theme = getTrackAITheme(track);
  if (!title) return theme ? 'A scene about ' + theme.toLowerCase() : '';
  return 'A scene of ' + title.toLowerCase() + (theme ? ', about ' + theme.toLowerCase() : '');
}

// A picture of any shape as the square a cover needs: the largest square
// from its middle. { sx, sy, side } in the picture's own pixels.
function coverSquareCrop(width, height) {
  var w = Math.max(0, Number(width) || 0);
  var h = Math.max(0, Number(height) || 0);
  var side = Math.min(w, h);
  return { sx:Math.round((w - side) / 2), sy:Math.round((h - side) / 2), side:side };
}

// What to know about a picture of the songwriter's own (one made in Suno, a
// photo): how big it is against the cover's size, and whether its sides
// are cut to make it square. Suno's own file pictures are 360 x 360.
function ownCoverNote(width, height, px) {
  var w = Math.round(Number(width) || 0);
  var h = Math.round(Number(height) || 0);
  var side = Math.min(w, h);
  var notes = ['Your picture is ' + w.toLocaleString() + ' × ' + h.toLocaleString() + '.'];
  if (w !== h) notes.push('Its middle is used, cut to a square.');
  if (side >= px) notes.push('That’s big enough to stay sharp at ' + px.toLocaleString() + ' × ' + px.toLocaleString() + '.');
  else if (side >= px / 2) notes.push('Scaled up to ' + px.toLocaleString() + ' × ' + px.toLocaleString() + ', it will look a little soft.');
  else notes.push('Scaled up to ' + px.toLocaleString() + ' × ' + px.toLocaleString() + ', it will look blurry. A picture ' + px.toLocaleString() + ' pixels wide, or close, stays sharp.');
  return notes.join(' ');
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
