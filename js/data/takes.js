// Takes: your own voice, recorded over a song's instrumental in karaoke
// (js/features/sing.js), mixed with it and kept on the song as track.takes
// [{ id, url, start, duration, created }] -- start and duration in seconds
// of the song, created an ISO time. A flat array of maps, as Firestore needs.
// Pure: no DOM, no audio APIs.

var MAX_TAKES = 20;

// Where the voice goes against the music, in seconds from the start of the
// music the take covers. The voice reaches the recording `lag` seconds after
// the music it answers went out (the speaker or headphone delay plus the
// mic's), so it is moved that much earlier. nudgeMs, the review's timing
// slider, moves it by hand: positive is later.
function takeVoiceStart(lag, nudgeMs) {
  return -(Number(lag) || 0) + (Number(nudgeMs) || 0) / 1000;
}

// The take: the music (left, right) with the voice added at voiceStart
// seconds, times gain, into both channels. As long as the music.
function mixTake(left, right, voice, rate, voiceStart, gain) {
  var length = left.length;
  var outL = new Float32Array(length);
  var outR = new Float32Array(length);
  outL.set(left);
  outR.set(right);
  var shift = Math.round((Number(voiceStart) || 0) * rate);
  var g = gain == null ? 1 : Number(gain);
  var from = Math.max(0, shift);
  var to = Math.min(length, shift + voice.length);
  for (var i = from; i < to; i++) {
    var v = voice[i - shift] * g;
    outL[i] += v;
    outR[i] += v;
  }
  return { left:outL, right:outR };
}

// The song's takes with `take` first, newest first, at most MAX_TAKES.
function addTake(list, take) {
  var rest = (Array.isArray(list) ? list : []).filter(function(item) { return item && item.id !== take.id; });
  return [take].concat(rest).slice(0, MAX_TAKES);
}

function removeTake(list, id) {
  return (Array.isArray(list) ? list : []).filter(function(item) { return item && item.id !== id; });
}

// m:ss
function takeClock(seconds) {
  var s = Math.max(0, Math.round(Number(seconds) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// "From 0:45 · 1:12 long", or "Whole song · 3:18 long" for a take from the top.
function takeSummary(take) {
  var start = Number(take && take.start) || 0;
  return (start < 1 ? 'From the start' : 'From ' + takeClock(start)) + ' · ' + takeClock(take && take.duration) + ' long';
}

function takeFileName(title, created) {
  var base = String(title || 'Song').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Song';
  return base + ' (my take ' + String(created || '').slice(0, 10) + ').mp3';
}

// A Cloudinary link that downloads instead of playing in the tab; any other
// link as it is.
function takeDownloadURL(url) {
  var text = String(url || '');
  if (!/^https:\/\/res\.cloudinary\.com\//.test(text) || text.indexOf('/upload/fl_attachment/') >= 0) return text;
  return text.replace('/upload/', '/upload/fl_attachment/');
}
