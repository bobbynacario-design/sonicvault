// Song lab (js/features/song-lab.js): which of the vault's songs Claude
// learns the songwriter's voice from, how each is put to it, and the drafts
// it writes back -- sized for Suno's boxes, and matched to the song once it
// has been made and imported.
// Pure: tracks in, plain values out.

var SONG_LAB_EXAMPLES = 6;
var SONG_LAB_DRAFTS = 12;
var SONG_LAB_LANGUAGES = ['Like my songs', 'English', 'Tagalog', 'Bikol', 'Taglish'];
// What Suno's boxes take: Style of Music 1000 characters, lyrics 5000,
// a title 80.
var SUNO_LIMITS = { title:80, style:1000, lyrics:5000 };

// How loved a song is, for choosing examples: every play counts, and a
// play in the last 60 days counts four times, so a song on repeat now beats
// one played a lot long ago. The take picked as main gets a nudge.
function songLabScore(takes, now) {
  var since = localDayKey(new Date(now.getTime() - 60 * 86400000));
  var score = 0;
  (takes || []).forEach(function(track) {
    score += Number(track.plays || 0);
    var days = track.playDays && typeof track.playDays === 'object' ? track.playDays : {};
    Object.keys(days).forEach(function(day) {
      if (day > since) score += 3 * (Number(days[day]) || 0);
    });
    if (track.versionPick === true) score += 2;
  });
  return score;
}

// A song's sound in words: the style it was made from, else what its AI
// description says (watcher imports arrive without a prompt).
function songLabSound(track) {
  var prompt = String(track && track.prompt || '').trim();
  if (prompt) return prompt;
  return uniqueStrings([
    track && (track.aiGenre || track.genre),
    track && (track.aiMood || track.mood),
    getTrackAIInstruments(track).join(', '),
    track && track.aiVocalStyle,
    track && track.aiEra,
    track && track.aiEnergy ? track.aiEnergy + ' energy' : ''
  ].filter(function(value) { return value && value !== 'Other'; })).join(', ');
}

// The songs to learn from, one take of each with lyrics: the newest few
// first -- they show how the songwriter writes now, where the most played
// can be months old and in an earlier style -- then the most loved of the
// rest. Songs that began as Song lab drafts (drafts, matched by their words)
// are Claude's writing, not the songwriter's, so they are left out. A song
// chosen by name (seedId) leads, lyrics or not.
var SONG_LAB_NEWEST = 3;
function pickSongLabExamples(list, now, seedId, count, drafts) {
  var all = list || [];
  var collapsed = collapseVersions(all, all);
  var withLyrics = collapsed.list.filter(function(track) {
    return hasLyrics(track) && !(drafts || []).some(function(draft) { return songCameFromDraft(track.lyrics, draft && draft.lyrics); });
  });
  var newest = withLyrics.slice().sort(compareNewestFirst).slice(0, SONG_LAB_NEWEST);
  var loved = withLyrics.filter(function(track) { return newest.indexOf(track) === -1; }).map(function(track) {
    return { track:track, score:songLabScore(collapsed.versions[track.id] || [track], now) };
  }).sort(function(a, b) {
    return b.score - a.score || compareNewestFirst(a.track, b.track);
  });
  var picked = newest.concat(loved.map(function(item) { return item.track; }));
  var seed = seedId ? all.filter(function(track) { return track.id === seedId; })[0] : null;
  if (seed) {
    var key = versionKey(seed);
    picked = [seed].concat(picked.filter(function(track) {
      return track.id !== seed.id && !(key && versionKey(track) === key);
    }));
  }
  return picked.slice(0, count || SONG_LAB_EXAMPLES);
}

// One example as the worker takes it, with the day it was made.
function songLabExample(track) {
  return {
    title:String(track && track.title || '').trim(),
    made:madeOnDay(track),
    sound:songLabSound(track).slice(0, 800),
    lyrics:getTrackLyrics(track).slice(0, 2500)
  };
}

// A draft as the vault keeps it: what Claude wrote, and what it was asked.
function songLabDraft(raw, request, now) {
  var ask = request || {};
  return {
    id:'draft-' + now.getTime(),
    title:String(raw && raw.title || '').trim().slice(0, 120),
    style:String(raw && raw.style || '').trim().slice(0, 1000),
    lyrics:String(raw && raw.lyrics || '').trim().slice(0, 6000),
    about:String(raw && raw.about || '').trim().slice(0, 600),
    subject:String(raw && raw.subject || '').trim().slice(0, 120),
    images:(Array.isArray(raw && raw.images) ? raw.images : []).map(function(image) { return String(image || '').trim().slice(0, 40); }).filter(Boolean).slice(0, 8),
    idea:String(ask.idea || '').trim().slice(0, 1000),
    change:String(ask.change || '').trim().slice(0, 500),
    language:String(ask.language || ''),
    from:(ask.from || []).map(function(title) { return String(title || ''); }).filter(Boolean).slice(0, 8),
    at:now.toISOString()
  };
}

// Kept drafts, newest first, at most SONG_LAB_DRAFTS. Anything that isn't
// a draft with lyrics is dropped on the way.
function addSongLabDraft(list, draft) {
  var rest = (Array.isArray(list) ? list : []).filter(function(item) {
    return item && typeof item === 'object' && item.lyrics && item.id !== draft.id;
  });
  return [draft].concat(rest).slice(0, SONG_LAB_DRAFTS);
}

// A sheet's sung lines, each reduced to its words (versionLyricsText), so a
// re-tagged or re-punctuated line still matches.
function sungLineWords(lyrics) {
  return String(lyrics || '').split(/\r\n?|\n/).map(versionLyricsText).filter(Boolean);
}

// Whether a song's words came from a draft: six lines or more, and at least
// eight in ten of them lines of the draft. Exact sheets miss a song where
// Suno sang a line twice, or a section was dropped.
function songCameFromDraft(songLyrics, draftLyrics) {
  var lines = sungLineWords(songLyrics);
  if (lines.length < 6) return false;
  var draftLines = {};
  sungLineWords(draftLyrics).forEach(function(line) { draftLines[line] = true; });
  var shared = lines.filter(function(line) { return draftLines[line]; }).length;
  return shared >= 0.8 * lines.length;
}

// The song a draft became, once it is in the vault: a track whose words
// came from the draft (Suno writes the sheet it sang into the MP3, and the
// watcher reads it from there). Null for one not made yet, or made with
// the words largely changed.
function songLabMadeAs(draft, list) {
  return (list || []).filter(function(track) {
    return songCameFromDraft(track && track.lyrics, draft && draft.lyrics);
  })[0] || null;
}

// The newest drafts as a line each -- title, what it is about, its subject
// and the images it was built on -- for the worker to steer clear of, so a
// draft with no idea isn't the last one again: the same people, the same
// situation, furnished with the same things.
function songLabAvoidList(drafts, count) {
  return (Array.isArray(drafts) ? drafts : []).filter(function(draft) {
    return draft && draft.title;
  }).slice(0, count || 6).map(function(draft) {
    var notes = [];
    if (draft.subject) notes.push('subject: ' + draft.subject);
    if (Array.isArray(draft.images) && draft.images.length) notes.push('images: ' + draft.images.join(', '));
    return trimText(draft.title + (draft.about ? ': ' + draft.about : '') + (notes.length ? ' (' + notes.join('; ') + ')' : ''), 360);
  });
}

// The fields too long for Suno's boxes: [{ field, length, limit }].
function sunoOverflow(draft) {
  return ['title', 'style', 'lyrics'].map(function(field) {
    return { field:field, length:String(draft && draft[field] || '').length, limit:SUNO_LIMITS[field] };
  }).filter(function(item) { return item.length > item.limit; });
}
