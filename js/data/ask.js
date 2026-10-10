// Ask your vault (js/features/ask.js): the vault written out for Claude --
// one line per song, its takes folded together, under the totals it would
// otherwise have to count -- and its answer read back.
// Pure: tracks in, text and plain values out.

var ASK_SONG_LIMIT = 30;
var ASK_PASSAGE_CHARS = 1200;
var ASK_ACTIONS = ['none', 'play', 'queue', 'playlist'];
var ASK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Days and months as people say them -- '2026-10-02' is "2 Oct 2026",
// '2026-10' is "Oct 2026" -- since Claude answers in the form it reads.
function askDate(key) {
  var m = String(key || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m || !ASK_MONTHS[Number(m[2]) - 1]) return String(key || '');
  return (m[3] ? Number(m[3]) + ' ' : '') + ASK_MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

// Plays in the `days` days up to and including today, from track.playDays.
function playsSince(track, now, days) {
  return countSince(track && track.playDays, now, days);
}

function lastPlayedDay(track) {
  var map = track && track.playDays && typeof track.playDays === 'object' ? track.playDays : {};
  return Object.keys(map).sort().pop() || '';
}

// The language a song is in, where a translation has found it out.
function songLanguage(takes) {
  for (var i = 0; i < takes.length; i++) {
    var saved = savedTranslations(takes[i]);
    var langs = Object.keys(saved);
    for (var j = 0; j < langs.length; j++) {
      if (saved[langs[j]].from) return saved[langs[j]].from;
    }
  }
  return '';
}

// One song on one line: id, title, when it was made, what it is, how much
// it is played, and what it is about. Plays add up across its takes.
function askSongLine(song, takes, now) {
  var plays = 0;
  var recent = 0;
  var skips = 0;
  var last = '';
  takes.forEach(function(take) {
    plays += Number(take.plays || 0);
    recent += playsSince(take, now, 30);
    skips += countSince(take.skipDays, now, 30);
    var day = lastPlayedDay(take);
    if (day > last) last = day;
  });
  var tags = getTrackAITags(song).slice(0, 6);
  var opening = getLyricContentLines(getTrackLyrics(song))[0] || '';
  var language = songLanguage(takes);
  return [
    '[' + song.id + '] ' + (song.title || 'Untitled'),
    'made ' + (madeOnDay(song) ? askDate(madeOnDay(song)) : 'on an unknown day'),
    song.source || '',
    [song.genre, song.mood].filter(Boolean).join(' / '),
    song.aiGenre && song.aiGenre !== song.genre ? 'style: ' + song.aiGenre : '',
    song.aiEnergy ? lower(song.aiEnergy) + ' energy' : '',
    hasLyrics(song) ? (song.aiVocalStyle ? 'voice: ' + song.aiVocalStyle : '') : 'instrumental',
    song.duration ? fmtTime(song.duration) + ' long' : '',
    'played ' + plays + (recent ? ' (' + recent + ' in the last 30 days)' : '') + (last ? ', last on ' + askDate(last) : ''),
    skips ? 'skipped ' + skips + ' in the last 30 days' + (takes.some(function(take) { return oftenSkipped(take, now); }) ? ', kept out of mixes' : '') : '',
    takes.length > 1 ? takes.length + ' takes' : '',
    language ? 'in ' + language : '',
    tags.length ? 'tags: ' + tags.join(', ') : '',
    getTrackAITheme(song) ? 'theme: ' + trimText(getTrackAITheme(song), 120) : '',
    getTrackSummary(song) ? 'about: ' + trimText(getTrackSummary(song), 260) : '',
    opening ? 'opens: "' + trimText(opening, 90) + '"' : ''
  ].filter(Boolean).join(' · ');
}

// [[value, count]], most first, ties by name.
function countBy(list, keyOf) {
  var counts = {};
  list.forEach(function(item) {
    var key = keyOf(item);
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).map(function(key) { return [key, counts[key]]; }).sort(function(a, b) {
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  });
}

function countLine(label, pairs, limit) {
  if (!pairs.length) return '';
  return label + ': ' + pairs.slice(0, limit || 20).map(function(pair) { return pair[0] + ' ' + pair[1]; }).join(', ');
}

// The numbers people ask about, counted here: language models miscount
// long lists.
function askTotals(songs, takesOf, trackCount, now) {
  var plays = 0;
  var week = 0;
  var month = 0;
  var never = 0;
  var recent = [];
  songs.forEach(function(song) {
    var p = 0;
    var r = 0;
    takesOf(song).forEach(function(take) {
      p += Number(take.plays || 0);
      week += playsSince(take, now, 7);
      r += playsSince(take, now, 30);
    });
    plays += p;
    month += r;
    if (!p) never++;
    if (r) recent.push([song.title || 'Untitled', r]);
  });
  recent.sort(function(a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
  var months = countBy(songs, function(song) { return madeOnDay(song).slice(0, 7); })
    .sort(function(a, b) { return a[0] < b[0] ? 1 : -1; })
    .map(function(pair) { return [askDate(pair[0]), pair[1]]; });
  return [
    'Songs: ' + songs.length + (trackCount !== songs.length ? ' (' + trackCount + ' tracks, counting every take)' : ''),
    countLine('Made per month, newest first', months, 18),
    countLine('Genres', countBy(songs, function(song) { return song.genre; })),
    countLine('Moods', countBy(songs, function(song) { return song.mood; })),
    countLine('Made with', countBy(songs, function(song) { return song.source; })),
    'Instrumentals: ' + songs.filter(function(song) { return !hasLyrics(song); }).length,
    'Plays: ' + plays + ' in all, ' + week + ' in the last 7 days, ' + month + ' in the last 30 days',
    'Songs never played: ' + never,
    countLine('Most played in the last 30 days', recent, 8)
  ].filter(Boolean).join('\n');
}

// The whole vault for Claude: the totals, the playlists, then one line per
// song, newest first. Ids are the take that stands for each song.
function buildAskCatalog(list, playlistList, now) {
  var all = list || [];
  var collapsed = collapseVersions(all.slice().sort(compareNewestFirst), all);
  var songs = collapsed.list;
  var takesOf = function(song) { return collapsed.versions[song.id] || [song]; };
  var shownAs = {};
  songs.forEach(function(song) {
    takesOf(song).forEach(function(take) { shownAs[take.id] = song.id; });
  });
  var lists = (playlistList || []).filter(function(pl) { return pl && pl.name; }).map(function(pl) {
    var ids = [];
    (pl.trackIds || []).forEach(function(id) {
      if (shownAs[id] && ids.indexOf(shownAs[id]) === -1) ids.push(shownAs[id]);
    });
    return '- ' + pl.name + ' (' + ids.length + ' songs): ' + ids.join(', ');
  });
  return [
    'Totals:',
    askTotals(songs, takesOf, all.length, now),
    '',
    lists.length ? 'Playlists:\n' + lists.join('\n') : 'Playlists: none yet',
    '',
    'Songs, newest first:',
    songs.map(function(song) { return askSongLine(song, takesOf(song), now); }).join('\n')
  ].join('\n');
}

// Claude's answer, holding only songs the vault has, each once. An action
// with no songs to act on is no action.
function readAskAnswer(raw, hasSong) {
  var songs = [];
  (Array.isArray(raw && raw.songs) ? raw.songs : []).forEach(function(id) {
    id = String(id || '');
    if (id && songs.indexOf(id) === -1 && hasSong(id)) songs.push(id);
  });
  songs = songs.slice(0, ASK_SONG_LIMIT);
  var action = ASK_ACTIONS.indexOf(raw && raw.action) !== -1 && songs.length ? raw.action : 'none';
  return {
    answer:String(raw && raw.answer || '').trim(),
    songs:songs,
    action:action,
    playlistName:action === 'playlist' ? String(raw.playlistName || '').trim().slice(0, 80) : ''
  };
}

// Phrases in double quotes, for "which song goes “hold the line”?".
function quotedPhrases(text) {
  var out = [];
  var re = /["“]([^"“”]{3,80})["”]/g;
  var match;
  while ((match = re.exec(String(text || '')))) {
    if (match[1].trim()) out.push(match[1].trim());
  }
  return out;
}

// The songs whose lyrics hold a phrase, case and punctuation aside.
function songsWithPhrase(list, phrase) {
  var needle = versionLyricsText(phrase);
  if (needle.length < 3) return [];
  return (list || []).filter(function(track) {
    return versionLyricsText(track && track.lyrics).indexOf(needle) !== -1;
  });
}

// Lyrics for Claude to read with a question: each song's id, title and
// sheet, as many as fit in maxChars.
function askPassages(list, maxChars) {
  var out = [];
  var used = 0;
  var room = maxChars || 16000;
  (list || []).forEach(function(track) {
    var sheet = getTrackLyrics(track);
    if (!sheet) return;
    var block = '[' + track.id + '] ' + (track.title || 'Untitled') + '\n' + trimText(sheet, ASK_PASSAGE_CHARS);
    if (used + block.length > room) return;
    out.push(block);
    used += block.length + 2;
  });
  return out.join('\n\n');
}
