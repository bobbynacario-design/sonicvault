// Listening smarts (js/features/listening.js): what the days each song is
// played and skipped on say -- what is on repeat, what keeps being skipped,
// which take of a song is winning, and the week in songs. A skip is kept
// like a play: track.skipDays, 'YYYY-MM-DD' -> skips (addPlayDay).
// Pure: tracks in, plain values out.

var SKIP_SECONDS = 30;          // leaving a song before this counts as a skip
var SKIP_MIN_DURATION = 45;     // a clip shorter than this is never skipped
var SKIP_WINDOW_DAYS = 60;
var ON_REPEAT_DAYS = 7;
var DAY_MS = 86400000;

// What a day map holds for the `days` days up to and including today.
function countSince(map, now, days) {
  var after = localDayKey(new Date(now.getTime() - days * DAY_MS));
  var counts = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  return Object.keys(counts).reduce(function(sum, day) {
    return day > after ? sum + (Number(counts[day]) || 0) : sum;
  }, 0);
}

// What a day map holds between `from` and `to` days ago (to excluded):
// countBetween(map, now, 14, 7) is the week before last.
function countBetween(map, now, from, to) {
  return countSince(map, now, from) - countSince(map, now, to);
}

// Whether leaving a song now counts as skipping it: less than 30 seconds
// in, not at its end, and not a clip under 45 seconds.
function isSkip(position, duration, ended) {
  return !ended && Number(duration) >= SKIP_MIN_DURATION && Number(position || 0) < SKIP_SECONDS;
}

// A song that keeps being skipped: three or more skips in the last 60 days,
// and at least six in ten of its plays then (a skipped start is a play too).
function oftenSkipped(track, now) {
  var skips = countSince(track && track.skipDays, now, SKIP_WINDOW_DAYS);
  var plays = countSince(track && track.playDays, now, SKIP_WINDOW_DAYS);
  return skips >= 3 && skips >= 0.6 * Math.max(plays, skips);
}

// Each song once, as the take listened to most in the window, with its
// listens -- plays that weren't skips -- added across takes:
// [{ track, listens, takes }], most first.
function songsByListens(list, now, days) {
  var all = list || [];
  var collapsed = collapseVersions(all, all);
  return collapsed.list.map(function(song) {
    var takes = collapsed.versions[song.id] || [song];
    var best = song;
    var bestListens = -1;
    var listens = 0;
    takes.forEach(function(take) {
      var n = Math.max(0, countSince(take.playDays, now, days) - countSince(take.skipDays, now, days));
      listens += n;
      if (n > bestListens) { best = take; bestListens = n; }
    });
    return { track:best, listens:listens, takes:takes };
  }).sort(function(a, b) {
    return b.listens - a.listens || compareNewestFirst(a.track, b.track);
  });
}

// On repeat: songs listened to at least twice in the last week, most
// first. A song skipped every time isn't on repeat.
function onRepeat(list, now, limit) {
  return songsByListens(list, now, ON_REPEAT_DAYS).filter(function(item) {
    return item.listens >= 2;
  }).slice(0, limit || 8);
}

// The take of a song that is winning lately: its plays less twice its
// skips over the last 60 days, at least three ahead of the next take and
// twice its score. Null when it's close, or there is one take.
function winningTake(group, now) {
  if (!group || group.length < 2) return null;
  var scored = group.map(function(take) {
    var plays = countSince(take.playDays, now, SKIP_WINDOW_DAYS);
    return { take:take, plays:plays, score:plays - 2 * countSince(take.skipDays, now, SKIP_WINDOW_DAYS) };
  }).sort(function(a, b) { return b.score - a.score; });
  var first = scored[0];
  var second = scored[1];
  if (first.score < 3 || first.score - second.score < 3 || first.score < 2 * Math.max(second.score, 0)) return null;
  return { take:first.take, plays:first.plays, runnerUp:second.take, runnerUpPlays:second.plays };
}

// The week in songs: the last seven days, and the seven before for
// comparison. Listening time counts a skipped start as fifteen seconds.
function weekRecap(list, now) {
  var all = list || [];
  var plays = 0;
  var before = 0;
  var skips = 0;
  var seconds = 0;
  var days = {};
  var since = localDayKey(new Date(now.getTime() - ON_REPEAT_DAYS * DAY_MS));
  all.forEach(function(track) {
    var map = track.playDays && typeof track.playDays === 'object' ? track.playDays : {};
    Object.keys(map).forEach(function(day) {
      if (day > since && Number(map[day])) days[day] = true;
    });
    var n = countSince(map, now, ON_REPEAT_DAYS);
    var s = Math.min(n, countSince(track.skipDays, now, ON_REPEAT_DAYS));
    plays += n;
    skips += s;
    before += countBetween(map, now, 2 * ON_REPEAT_DAYS, ON_REPEAT_DAYS);
    seconds += (n - s) * (Number(track.duration) || 0) + s * 15;
  });
  var made = collapseVersions(all.filter(function(track) {
    var day = madeOnDay(track);
    return day && day > since;
  }), all).list;
  return {
    plays:plays,
    playsBefore:before,
    skips:skips,
    seconds:seconds,
    daysListened:Object.keys(days).length,
    top:songsByListens(all, now, ON_REPEAT_DAYS).filter(function(item) { return item.listens > 0; }).slice(0, 5),
    made:made
  };
}
