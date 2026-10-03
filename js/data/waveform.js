// Waveform arithmetic: decoding peaks out of an AudioBuffer, resampling them
// to a bar count, and the stable stand-in drawn before real peaks exist.
// Pure: no DOM, no app state, nothing outside js/data.

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

function extractWaveformPeaks(buffer, count) {
  var samples = count || 72;
  var channelData = [];
  for (var c = 0; c < buffer.numberOfChannels; c++) {
    channelData.push(buffer.getChannelData(c));
  }
  var blockSize = Math.floor(buffer.length / samples) || 1;
  var peaks = [];

  for (var i = 0; i < samples; i++) {
    var start = i * blockSize;
    var end = Math.min(start + blockSize, buffer.length);
    var peak = 0;
    for (var j = start; j < end; j++) {
      var sum = 0;
      for (var k = 0; k < channelData.length; k++) sum += Math.abs(channelData[k][j] || 0);
      peak = Math.max(peak, sum / channelData.length);
    }
    peaks.push(Math.max(.08, Math.min(.98, peak * 1.85)));
  }
  return peaks;
}
