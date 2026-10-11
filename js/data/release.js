// Ready for Spotify (js/features/release.js): which songs could go out
// through a distributor such as DistroKid, and what each needs first. It
// goes by what the vault knows -- where a song came from, when it was made,
// its title, takes, length and lyrics -- not by anyone's Suno account.
//
// The rules, as of October 2026: Suno gives commercial rights only to songs
// made while subscribed to Pro or Premier, and subscribing later doesn't
// cover songs made on the free plan. Spotify allows AI music, but not
// impersonation, duplicates or very short filler, and counts a play only
// from 30 seconds.
// Pure: tracks in, plain values out.

var RELEASE_MIN_SECONDS = 30;
// A song known only by the day it reached the vault, this soon after the
// plan began, may have been made before it.
var RELEASE_CLOSE_DAYS = 14;
var RELEASE_EXPLICIT = /\b(fuck(s|ed|er|ers|ing|in)?|motherfuck(er|ers|ing|in)?|shit(s|ty|ting)?|bullshit|bitch(es|y)?|cunts?|assholes?|puta|putang ?ina|tang ?ina|gago|ulol|tarantado|pakyu|kantot(an|in)?|pokpok)\b/gi;
var RELEASE_LEVELS = ['block', 'check', 'fix', 'note', 'ok'];

// When the song was made, as a local day: the day Suno stamped in its file
// (track.madeAt), else the day it reached the vault. fromFile says which.
function releaseMadeDay(track) {
  var at = track && track.madeAt ? new Date(track.madeAt) : null;
  if (at && !isNaN(at.getTime())) return { day:localDayKey(at), fromFile:true };
  return { day:madeOnDay(track), fromFile:false };
}

function daysBetween(fromDay, toDay) {
  var a = new Date(fromDay + 'T00:00:00Z');
  var b = new Date(toDay + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// Whether the song may be released at all, by where it came from. A file
// Suno stamped is a Suno song whatever its source says.
function releaseRights(track, planSince) {
  var source = String(track && track.source || '').trim();
  var stamped = !!(track && (track.madeAt || track.sunoId));
  if (source === 'Suno' || stamped) {
    var items = [];
    if (source !== 'Suno') {
      items.push({ level:'note', text:'Its file says it was made with Suno, though its source says ' + (source || 'nothing') + '.' });
    }
    items.push(releaseSunoRights(track, planSince));
    return items;
  }
  if (source === 'Original') return [{ level:'ok', text:'Your own recording.' }];
  if (source === 'Udio') {
    return [{ level:'check', text:'Udio stopped downloads after its deal with Universal in October 2025. Check what its terms allowed when you downloaded this one.' }];
  }
  if (source === 'Lyria') {
    return [{ level:'check', text:'Made with Google’s Lyria. Check Google’s terms for releasing Lyria songs first.' }];
  }
  return [{ level:'check', text:'Where it came from isn’t set. Set its source in Edit first.' }];
}

function releaseSunoRights(track, planSince) {
  var made = releaseMadeDay(track);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(planSince || ''))) {
    return { level:'check', text:'Set the day your Suno plan began, above, to check this one.' };
  }
  if (!made.day) {
    return { level:'check', text:'When it was made isn’t known. Check in Suno that you made it while subscribed.' };
  }
  var label = made.fromFile ? 'Made on ' : 'Reached the vault on ';
  if (made.day < planSince) {
    if (!made.fromFile) {
      return { level:'block', text:'Reached the vault on ' + askDate(made.day) + ', before your Suno plan began on ' + askDate(planSince) + ', so it was made on the free plan. Suno keeps free-plan songs for personal use. To release it, make it again while subscribed.' };
    }
    return { level:'block', text:'Made on ' + askDate(made.day) + ', before your Suno plan began on ' + askDate(planSince) + '. Suno keeps free-plan songs for personal use. To release it, make it again while subscribed.' };
  }
  if (made.day === planSince) {
    return { level:'check', text:label + 'the day your plan began. Check in Suno that you’d subscribed by then.' };
  }
  var after = daysBetween(planSince, made.day);
  if (!made.fromFile && after <= RELEASE_CLOSE_DAYS) {
    return { level:'check', text:'Reached the vault on ' + askDate(made.day) + ', ' + after + (after === 1 ? ' day' : ' days') + ' after your plan began, and when it was made isn’t known. Check in Suno that you made it after subscribing.' };
  }
  // The row already shows the day, so the finding needn't repeat it.
  return { level:'ok', text:made.fromFile ? 'Made while on your Suno plan.' : 'Reached the vault after your plan began.' };
}

// Words that may need the Explicit tag, each once, as written.
function releaseExplicitWords(text) {
  var seen = {};
  var out = [];
  (String(text || '').match(RELEASE_EXPLICIT) || []).forEach(function(word) {
    var key = word.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(word);
  });
  return out;
}

function releaseStatus(items) {
  var levels = items.map(function(item) { return item.level; });
  if (levels.indexOf('block') !== -1) return 'blocked';
  if (levels.indexOf('check') !== -1) return 'check';
  if (levels.indexOf('fix') !== -1) return 'fix';
  return 'ready';
}

// One song's check. ctx: { planSince: 'YYYY-MM-DD', takes: the song's
// takes when it has more than one, clashes: other songs' titles that match,
// timed: whether its lyrics are timed, fromDraft: whether its words came
// from a Song lab draft }. { status, title, items: [{ level, text }] },
// items most serious first; title is the one to release it under.
function releaseCheck(track, ctx) {
  ctx = ctx || {};
  var items = releaseRights(track, ctx.planSince);
  var duration = Number(track.duration) || 0;
  if (duration > 0 && duration < RELEASE_MIN_SECONDS) {
    items.push({ level:'fix', text:'Under 30 seconds. Spotify counts a play only from 30 seconds, and very short tracks get flagged as spam.' });
  }
  var lyrics = getTrackLyrics(track);
  var tidied = tidyTitle(track.title, lyrics, track.prompt);
  var title = baseSongTitle(tidied || track.title) || tidied || String(track.title || '').trim();
  if (tidied) {
    items.push({ level:'fix', text:'Its title still carries the file name. Tidy it to “' + tidied + '” first.', tidy:tidied });
  } else if (title && title !== String(track.title || '').trim()) {
    items.push({ level:'note', text:'Release it as “' + title + '”, without the take number.' });
  }
  if (ctx.clashes && ctx.clashes.length) {
    items.push({ level:'check', text:'Another song in the vault is also called “' + title + '”. If you release both, give one a new title: the same title twice looks like a duplicate.' });
  }
  if (ctx.takes && ctx.takes.length > 1) {
    items.push({ level:'note', text:'Release one take only. This is the main one of ' + ctx.takes.length + '; both would look like a duplicate.' });
  }
  var explicit = releaseExplicitWords([track.title, lyrics].join('\n'));
  if (explicit.length) {
    items.push({ level:'check', text:'It may need the Explicit tag: “' + explicit.slice(0, 3).join('”, “') + '”.' });
  } else if (track.aiExplicit === true) {
    items.push({ level:'check', text:'Claude marked it explicit when it described it. Release it with the Explicit tag if that’s right.' });
  }
  if (lyrics) {
    items.push(ctx.timed
      ? { level:'ok', text:'Synced lyrics ready for Musixmatch, where Spotify gets its lyrics.' }
      : { level:'note', text:'Its lyrics aren’t timed yet. Play it once with the AI worker connected to get a synced lyrics file for Musixmatch.' });
  } else if (needsLyrics(track)) {
    items.push({ level:'note', text:'No lyric sheet. Spotify’s lyrics come from Musixmatch, which needs one.' });
  }
  if (ctx.fromDraft) {
    items.push({ level:'note', text:'Its words came from a Song lab draft, written with Claude. You can release them; say so when the distributor asks about AI.' });
  }
  items.sort(function(a, b) { return RELEASE_LEVELS.indexOf(a.level) - RELEASE_LEVELS.indexOf(b.level); });
  return { status:releaseStatus(items), title:title, items:items };
}

// The songs to check: each once, as its main take (collapseVersions), and
// never a second copy of the same file (findDuplicates).
function releaseCandidates(list, keyOf) {
  var drop = {};
  findDuplicates(list).forEach(function(pair) { drop[pair.drop.id] = true; });
  var kept = (list || []).filter(function(track) { return track && track.id && !drop[track.id]; });
  return collapseVersions(kept, kept, keyOf).list;
}

// Songs whose release titles match another's: id -> [the other songs].
function releaseTitleClashes(candidates) {
  var byTitle = {};
  (candidates || []).forEach(function(track) {
    var key = baseSongTitle(tidyTitle(track.title, getTrackLyrics(track), track.prompt) || track.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (key) (byTitle[key] = byTitle[key] || []).push(track);
  });
  var out = {};
  Object.keys(byTitle).forEach(function(key) {
    var group = byTitle[key];
    if (group.length < 2) return;
    group.forEach(function(track) { out[track.id] = group.filter(function(other) { return other !== track; }); });
  });
  return out;
}
