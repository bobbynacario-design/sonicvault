// Waveform arithmetic: measuring loudness levels out of an AudioBuffer,
// resampling them to a bar count, and the stable stand-in drawn before real
// levels exist. Pure: no DOM, no app state, nothing outside js/data.

function buildFallbackWaveform(track, count) {
  var len = count || 48;
  var seed = hashString((track && track.title || '') + '|' + (track && track.genre || '') + '|' + (track && track.mood || ''));
  var values = [];
  for (var i = 0; i < len; i++) {
    var angle = (seed % 360) + (i * 17);
    var wave = (Math.sin(angle * Math.PI / 180) + 1) / 2;
    var wave2 = (Math.cos((angle * 1.7) * Math.PI / 180) + 1) / 2;
    values.push(Math.max(.14, Math.min(.96, (wave * .58) + (wave2 * .22) + .12)));
  }
  return values;
}

function normalizeWaveform(values, count) {
  var target = count || (values ? values.length : 48) || 48;
  if (!Array.isArray(values) || !values.length) return buildFallbackWaveform(null, target);
  if (values.length === target) return values.slice();
  var out = [];
  for (var i = 0; i < target; i++) {
    var idx = Math.floor((i / target) * values.length);
    out.push(values[Math.min(values.length - 1, idx)]);
  }
  return out;
}

// One level per bar, shaped so a song's structure shows. The old measure
// took each block's loudest sample and scaled it up, and a mastered track
// (every Suno export) peaks near full scale in every block -- so every bar
// hit the ceiling and the waveform drew as a flat wall. Levels are each
// block's RMS energy instead, relative to the track's own loudest block,
// stretched over the track's own range and eased so quiet passages read as
// quiet without vanishing.
function extractWaveformLevels(buffer, count) {
  var bars = count || 72;
  var channels = [];
  for (var c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  var blockSize = Math.floor(buffer.length / bars) || 1;
  var energy = [];
  for (var i = 0; i < bars; i++) {
    var start = i * blockSize;
    var end = Math.min(start + blockSize, buffer.length);
    var sum = 0;
    for (var k = 0; k < channels.length; k++) {
      var data = channels[k];
      for (var j = start; j < end; j++) sum += data[j] * data[j];
    }
    var n = (end - start) * (channels.length || 1);
    energy.push(n > 0 ? Math.sqrt(sum / n) : 0);
  }
  var max = Math.max.apply(null, energy);
  if (!(max > 0)) return energy.map(function() { return .08; });
  var relative = energy.map(function(e) { return e / max; });
  var floor = Math.min.apply(null, relative) * .7;
  return relative.map(function(r) {
    var shaped = floor < 1 ? Math.pow((r - floor) / (1 - floor), 1.4) : 1;
    return Math.round(Math.max(.08, Math.min(.98, .1 + .88 * shaped)) * 1000) / 1000;
  });
}

// ── Even volume ─────────────────────────────────────────────────────────
// Suno songs come out at different loudness. The player evens them out the
// way streaming services do: each song's integrated loudness (LUFS, ITU-R
// BS.1770-4) is measured once, and louder songs play turned down to match.

// The K-weighting filter (a high shelf for how the ear hears treble, then a
// high-pass below 38 Hz) for a sample rate, as the two biquads libebur128
// uses.
function kWeightingFilter(rate) {
  var K = Math.tan(Math.PI * 1681.974450955533 / rate);
  var Q = .7071752369554196;
  var Vh = Math.pow(10, 3.999843853973347 / 20);
  var Vb = Math.pow(Vh, .4996667741545416);
  var a0 = 1 + K / Q + K * K;
  var K2 = Math.tan(Math.PI * 38.13547087602444 / rate);
  var Q2 = .5003270373238773;
  var d0 = 1 + K2 / Q2 + K2 * K2;
  return {
    b0:(Vh + Vb * K / Q + K * K) / a0,
    b1:2 * (K * K - Vh) / a0,
    b2:(Vh - Vb * K / Q + K * K) / a0,
    a1:2 * (K * K - 1) / a0,
    a2:(1 - K / Q + K * K) / a0,
    c1:2 * (K2 * K2 - 1) / d0,
    c2:(1 - K2 / Q2 + K2 * K2) / d0
  };
}

// Integrated loudness of an AudioBuffer (or anything with sampleRate,
// length, numberOfChannels and getChannelData) in LUFS, to 0.1: K-weighted
// power in 400ms blocks every 100ms, gated at -70 LUFS and then at 10 LU
// below the loudness of what passed. null for silence, or under 0.4s.
function measureLoudness(buffer) {
  var rate = buffer && buffer.sampleRate;
  var length = buffer ? buffer.length : 0;
  if (!rate || length < rate * .4) return null;
  var step = Math.round(rate * .1);
  var segments = Math.floor(length / step);
  var power = new Float64Array(segments);
  var f = kWeightingFilter(rate);
  for (var c = 0; c < buffer.numberOfChannels; c++) {
    var x = buffer.getChannelData(c);
    var s1 = 0, s2 = 0, t1 = 0, t2 = 0;
    for (var seg = 0; seg < segments; seg++) {
      var sum = 0;
      var end = (seg + 1) * step;
      for (var i = seg * step; i < end; i++) {
        var v = x[i];
        var y = f.b0 * v + s1;
        s1 = f.b1 * v - f.a1 * y + s2;
        s2 = f.b2 * v - f.a2 * y;
        var w = y + t1;
        t1 = -2 * y - f.c1 * w + t2;
        t2 = y - f.c2 * w;
        sum += w * w;
      }
      power[seg] += sum;
    }
  }
  function lufs(z) { return -.691 + 10 * Math.log10(z); }
  function mean(list) { return list.reduce(function(a, b) { return a + b; }, 0) / list.length; }
  var blocks = [];
  for (var b = 0; b + 4 <= segments; b++) blocks.push((power[b] + power[b + 1] + power[b + 2] + power[b + 3]) / (4 * step));
  var heard = blocks.filter(function(z) { return z > 0 && lufs(z) > -70; });
  if (!heard.length) return null;
  var gate = lufs(mean(heard)) - 10;
  var kept = heard.filter(function(z) { return lufs(z) > gate; });
  return Math.round(lufs(mean(kept)) * 10) / 10;
}

function isMeasuredLoudness(value) {
  return typeof value === 'number' && isFinite(value);
}

// The measured songs worth evening against: silence (stored as -70) aside.
function audibleLoudness(values) {
  return (values || []).filter(function(v) { return isMeasuredLoudness(v) && v > -60; }).sort(function(a, b) { return a - b; });
}

// The level songs are brought down to: the quieter end of the library (its
// 10th percentile), so the loud ones meet the quiet ones -- but never under
// -14 LUFS, the level Spotify and YouTube play at, so one very quiet song
// can't hush the rest. null with nothing measured.
function levelTarget(values) {
  var list = audibleLoudness(values);
  if (!list.length) return null;
  return Math.max(-14, list[Math.floor((list.length - 1) * .1)]);
}

// The library's middle loudness: the stand-in for a song not measured yet,
// so it doesn't play louder than everything around it.
function typicalLoudness(values) {
  var list = audibleLoudness(values);
  return list.length ? list[Math.floor(list.length / 2)] : null;
}

// A volume factor from 0 to 1 that brings a song at `lufs` down to `target`.
// A page can lower a song's volume but never raise it, so songs quieter
// than the target play as they are.
function levelGain(lufs, target) {
  if (!isMeasuredLoudness(lufs) || !isMeasuredLoudness(target)) return 1;
  return Math.min(1, Math.pow(10, (target - lufs) / 20));
}

// How loud a song is at t seconds, from its measured levels (one per
// stretch of the song), stretched over its own quiet-to-loud range: 0 at
// its quietest, 1 at its loudest. null without levels to go on. For the
// living cover and karaoke's Music background.
function levelAt(levels, t, duration) {
  if (!Array.isArray(levels) || levels.length < 2 || !(Number(duration) > 0)) return null;
  var at = Math.max(0, Math.min(1, Number(t) / Number(duration))) * (levels.length - 1);
  var i = Math.floor(at);
  var next = levels[Math.min(levels.length - 1, i + 1)];
  var raw = levels[i] + (next - levels[i]) * (at - i);
  var low = Math.min.apply(null, levels);
  var high = Math.max.apply(null, levels);
  return high > low ? (raw - low) / (high - low) : .5;
}
