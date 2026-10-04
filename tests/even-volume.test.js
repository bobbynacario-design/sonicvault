"use strict";
// Even volume: measuring a song's loudness the way streaming services do,
// and how far each song is turned down to match the rest.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

// A sine wave as an AudioBuffer stand-in; level(t) shapes it over time.
function tone({ rate = 48000, secs = 5, freq = 1000, amp = 1, channels = 2, level = () => 1 } = {}) {
  const n = Math.round(rate * secs);
  const data = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = amp * level(t) * Math.sin(2 * Math.PI * freq * t);
    for (const ch of data) ch[i] = v;
  }
  return { sampleRate: rate, length: n, numberOfChannels: channels, getChannelData: (c) => data[c] };
}

const near = (actual, expected, within, what) =>
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);

test("loudness matches the BS.1770 reference tones", () => {
  // A full-scale 1 kHz sine reads -3.01 LUFS in one channel, so 0 in two.
  near(g.measureLoudness(tone()), 0, 0.2, "stereo full scale");
  near(g.measureLoudness(tone({ channels: 1 })), -3, 0.2, "mono full scale");
  near(g.measureLoudness(tone({ amp: 0.1 })), -20, 0.2, "20 dB down");
  near(g.measureLoudness(tone({ amp: 0.1, rate: 44100 })), -20, 0.2, "at 44.1 kHz");
});

test("silence and quiet passages don't drag the loudness down", () => {
  near(g.measureLoudness(tone({ amp: 0.1, secs: 10, level: (t) => (t < 5 ? 1 : 0) })), -20, 0.2, "half silence");
  near(g.measureLoudness(tone({ amp: 0.1, secs: 10, level: (t) => (t < 5 ? 1 : 0.1) })), -20, 0.2, "half 20 dB quieter");
  assert.equal(g.measureLoudness(tone({ amp: 0 })), null);
  assert.equal(g.measureLoudness(tone({ secs: 0.3 })), null);
  assert.equal(g.measureLoudness(null), null);
});

test("loud songs come down to the quieter end of the library", () => {
  const library = [-9, -10, -11, -12, -14, -8, -7, -13, -10, -9];
  assert.equal(g.levelTarget(library), -14);
  // One very quiet song doesn't hush everything else.
  assert.equal(g.levelTarget([-20, -9, -9]), -14);
  assert.equal(g.levelTarget([-70, null, "x"]), null);
  assert.equal(g.typicalLoudness([-9, -12, -10, -70]), -10);
  near(g.levelGain(-8, -14), 0.501, 0.001, "6 dB down");
  assert.equal(g.levelGain(-16, -14), 1, "quieter songs are never turned up");
  assert.equal(g.levelGain(null, -14), 1);
  assert.equal(g.levelGain(-8, null), 1);
});
