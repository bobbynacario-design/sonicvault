// Radio from any song: an endless queue of the songs most like it. How
// alike two songs are, and which to queue next. js/features/radio.js keeps
// the queue topped up while it plays.
// Pure: tracks (and optional meaning vectors) in, scores and ids out.

var RADIO_BATCH = 8;

function radioTags(track) {
  return getTrackAITags(track).map(function(tag) { return String(tag).toLowerCase(); });
}

// 0 to about 1.3: what they are about (the search-by-meaning vectors, when
// both songs have one) counts most, then genre, mood, shared tags, and how
// loud they are as a rough stand-in for energy.
function radioScore(a, b, vectorA, vectorB) {
  var score = 0;
  if (vectorA && vectorB) score += .55 * Math.max(0, meaningSimilarity(vectorA, vectorB));
  var genreA = lower(a && (a.genre || a.aiGenre));
  var genreB = lower(b && (b.genre || b.aiGenre));
  if (genreA && genreA === genreB) score += .22;
  var moodA = lower(a && (a.mood || a.aiMood));
  var moodB = lower(b && (b.mood || b.aiMood));
  if (moodA && moodA === moodB) score += .16;
  var tagsA = radioTags(a);
  var tagsB = radioTags(b);
  if (tagsA.length && tagsB.length) {
    var shared = tagsA.filter(function(tag) { return tagsB.indexOf(tag) !== -1; }).length;
    score += .3 * shared / (tagsA.length + tagsB.length - shared);
  }
  if (isMeasuredLoudness(a && a.lufs) && isMeasuredLoudness(b && b.lufs) && a.lufs > -60 && b.lufs > -60) {
    score += .08 * Math.max(0, 1 - Math.abs(a.lufs - b.lufs) / 8);
  }
  return score;
}

// The next songs for a radio seeded by `seed`: each song once (its main
// take), never the seed's own takes, not one of the `recent` ids while
// enough others remain, and not strictly in order -- drawn from the closest
// matches with the closer ones likelier, so two radios from one song differ.
// pool: songs with audio (one entry per take is fine). vectorOf(id): a
// meaning vector or null. random: Math.random, or a stand-in for tests.
function pickRadioBatch(seed, pool, recent, count, vectorOf, random) {
  var rand = random || Math.random;
  var want = count || RADIO_BATCH;
  var vector = vectorOf || function() { return null; };
  var seedKey = versionKey(seed);
  var songs = collapseVersions((pool || []).filter(function(track) {
    if (!track || track.id === seed.id) return false;
    return !(seedKey && versionKey(track) === seedKey);
  }), pool).list;
  var recentSet = {};
  (recent || []).forEach(function(id) { recentSet[id] = true; });
  var fresh = songs.filter(function(track) { return !recentSet[track.id]; });
  // A small library runs out: then only the last few played stay out.
  if (fresh.length < want) {
    var lastFew = {};
    (recent || []).slice(-Math.min(4, Math.floor(songs.length / 2))).forEach(function(id) { lastFew[id] = true; });
    fresh = songs.filter(function(track) { return !lastFew[track.id]; });
  }
  var seedVector = vector(seed.id);
  var ranked = fresh.map(function(track) {
    return { track:track, score:radioScore(seed, track, seedVector, vector(track.id)) };
  }).sort(function(a, b) { return b.score - a.score; });
  var shortlist = ranked.slice(0, Math.max(want + 4, 6));
  var out = [];
  while (out.length < want && shortlist.length) {
    var weights = shortlist.map(function(item) { return Math.exp(item.score * 6); });
    var total = weights.reduce(function(sum, w) { return sum + w; }, 0);
    var roll = rand() * total;
    var at = 0;
    while (at < shortlist.length - 1 && roll >= weights[at]) { roll -= weights[at]; at++; }
    out.push(shortlist[at].track.id);
    shortlist.splice(at, 1);
  }
  return out;
}

// The queue with a new batch on the end. The player finds its place in the
// queue by song, so a song may be in it only once: a song coming round
// again leaves its earlier, already played place. Nothing from the song
// playing (at) onwards is touched or repeated, and at most keepBehind
// played songs stay.
function appendRadioBatch(ids, at, more, keepBehind) {
  var ahead = ids.slice(at);
  var add = (more || []).filter(function(id, i, list) { return ahead.indexOf(id) === -1 && list.indexOf(id) === i; });
  var behind = ids.slice(0, at).filter(function(id) { return add.indexOf(id) === -1; });
  if (typeof keepBehind === 'number') behind = behind.slice(Math.max(0, behind.length - keepBehind));
  return behind.concat(ahead, add);
}
