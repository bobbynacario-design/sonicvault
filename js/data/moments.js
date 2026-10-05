// Home's moments: the songs made on this day a while back, and a mix for
// the time of day (js/features/home.js).
// Pure: tracks and a date in, plain values out.

// The day a song was made: its created date as written, else the time in
// its id, on the listener's own calendar.
function madeOnDay(track) {
  var created = String(track && track.created || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(created)) return created;
  var at = trackIdTimestamp(track);
  return at ? localDayKey(new Date(at)) : '';
}

// Songs made on this date in an earlier year, or failing that on this day
// of an earlier month -- the furthest back first. { label, day, tracks },
// or null when no song was made on such a day.
function onThisDay(list, now) {
  var today = localDayKey(now);
  if (!today) return null;
  var byDay = {};
  (list || []).forEach(function(track) {
    var day = madeOnDay(track);
    if (day && day < today) (byDay[day] = byDay[day] || []).push(track);
  });
  var year = Number(today.slice(0, 4));
  var month = Number(today.slice(5, 7));
  var date = today.slice(8);
  var n;
  for (n = 10; n >= 1; n--) {
    var yearKey = (year - n) + today.slice(4);
    if (byDay[yearKey]) return { label:n === 1 ? 'A year ago today' : n + ' years ago today', day:yearKey, tracks:byDay[yearKey] };
  }
  for (n = 11; n >= 1; n--) {
    var m = month - n;
    var y = year;
    while (m < 1) { m += 12; y--; }
    var monthKey = y + '-' + (m < 10 ? '0' : '') + m + '-' + date;
    if (byDay[monthKey]) return { label:n === 1 ? 'A month ago today' : n + ' months ago today', day:monthKey, tracks:byDay[monthKey] };
  }
  return null;
}

var DAY_PARTS = [
  { id:'morning', from:5, to:11, name:'Morning mix', desc:'Bright and moving, to start the day.', moods:['Energetic', 'Uplifting', 'Playful', 'Warm'], energy:['High', 'Medium'] },
  { id:'afternoon', from:11, to:17, name:'Afternoon mix', desc:'Easy momentum for the middle of the day.', moods:['Warm', 'Playful', 'Uplifting', 'Chill'], energy:['Medium'] },
  { id:'evening', from:17, to:22, name:'Evening mix', desc:'Warm, and winding down.', moods:['Warm', 'Chill', 'Dreamy', 'Melancholic'], energy:['Medium', 'Low'] },
  { id:'night', from:22, to:29, name:'Late night mix', desc:'The quiet ones, for late hours.', moods:['Chill', 'Dreamy', 'Melancholic', 'Dark'], energy:['Low'] }
];

function dayPartAt(hour) {
  var h = Number(hour) < 5 ? Number(hour) + 24 : Number(hour);
  return DAY_PARTS.filter(function(part) { return h >= part.from && h < part.to; })[0] || DAY_PARTS[0];
}

// Songs for the time of day: a mood that fits counts most, then the AI's
// energy, in an order that changes from day to day. One take of each song.
// { id, name, desc, ids }, or null with fewer than three that fit.
function timeOfDayMix(list, now, limit) {
  var part = dayPartAt(now.getHours());
  var day = localDayKey(now);
  var wanted = part.moods.map(function(mood) { return mood.toLowerCase(); });
  var songs = collapseVersions((list || []).filter(function(track) { return track && (track.audioURL || track.audioData); }), list).list;
  var scored = songs.map(function(track) {
    var moods = [track.mood, track.aiMood].filter(Boolean).map(function(mood) { return String(mood).toLowerCase(); });
    var fits = moods.some(function(mood) { return wanted.some(function(w) { return mood.indexOf(w) !== -1; }); });
    var score = (fits ? 2 : 0) + (part.energy.indexOf(track.aiEnergy) !== -1 ? 1 : 0);
    return { id:track.id, score:score, order:hashString(day + '|' + track.id) };
  }).filter(function(item) { return item.score > 0; })
    .sort(function(a, b) { return b.score - a.score || a.order - b.order; });
  if (scored.length < 3) return null;
  return { id:part.id, name:part.name, desc:part.desc, ids:scored.slice(0, limit || 12).map(function(item) { return item.id; }) };
}
