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
