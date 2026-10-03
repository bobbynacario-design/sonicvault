"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, "bar " + i + ": " + v + " vs " + expected[i]));
};

function fakeBuffer(channels) {
  return { numberOfChannels: channels.length, length: channels[0].length, getChannelData: (c) => channels[c] };
}

// A block of n samples alternating +a/-a: RMS a, peak a.
const tone = (a, n) => Array.from({ length: n }, (_, i) => (i % 2 ? -a : a));

test("a loud master no longer draws as a flat wall", () => {
  // Every block peaks at full scale, as a mastered Suno export does, but the
  // chorus carries more energy than the verse. The old peak measure scaled
  // both to the ceiling; levels keep them apart.
  const verse = tone(0.3, 100).map((v, i) => (i === 0 ? 1 : v));
  const chorus = tone(0.6, 100).map((v, i) => (i === 0 ? 1 : v));
  const [v, c] = g.extractWaveformLevels(fakeBuffer([[...verse, ...chorus]]), 2);
  assert.ok(c > v + 0.4, "chorus " + c + " vs verse " + v);
  assert.equal(c, 0.98);
});

test("levels are relative to the track, so a quiet track still fills the range", () => {
  const quiet = g.extractWaveformLevels(fakeBuffer([[...tone(0.02, 50), ...tone(0.04, 50)]]), 2);
  const loud = g.extractWaveformLevels(fakeBuffer([[...tone(0.4, 50), ...tone(0.8, 50)]]), 2);
  near(quiet, loud);
  assert.equal(Math.max(...quiet), 0.98);
});

test("levels average energy across channels and stay inside the drawable range", () => {
  const mono = g.extractWaveformLevels(fakeBuffer([[...tone(0.2, 40), ...tone(0.5, 40)]]), 2);
  const stereo = g.extractWaveformLevels(fakeBuffer([[...tone(0.2, 40), ...tone(0.5, 40)], [...tone(0.2, 40), ...tone(0.5, 40)]]), 2);
  near(stereo, mono);
  const steady = g.extractWaveformLevels(fakeBuffer([tone(0.5, 90)]), 3);
  near(steady, [0.98, 0.98, 0.98]);
  near(g.extractWaveformLevels(fakeBuffer([[0, 0, 0, 0]]), 2), [0.08, 0.08]);
  const mixed = g.extractWaveformLevels(fakeBuffer([[...tone(0.01, 30), ...tone(0.3, 30), ...tone(0.9, 30)]]), 3);
  assert.ok(mixed.every((x) => x >= 0.08 && x <= 0.98));
  assert.ok(mixed[0] < mixed[1] && mixed[1] < mixed[2]);
});

test("normalizeWaveform resamples to the bar count and never hands back the cache", () => {
  near(g.normalizeWaveform([0.1, 0.2, 0.3, 0.4], 2), [0.1, 0.3]);
  const peaks = [0.5, 0.6];
  const same = g.normalizeWaveform(peaks, 2);
  assert.deepEqual(same, peaks);
  assert.notEqual(same, peaks);
  assert.equal(g.normalizeWaveform([], 5).length, 5);
  assert.equal(g.normalizeWaveform(null).length, 48);
});

test("the fallback waveform is stable per track and stays inside the drawable range", () => {
  const track = { title: "Paper Lanterns", genre: "Chiptune", mood: "Energetic" };
  const bars = g.buildFallbackWaveform(track, 72);
  assert.equal(bars.length, 72);
  assert.deepEqual(g.buildFallbackWaveform({ ...track }, 72), bars);
  assert.ok(bars.every((v) => v >= 0.14 && v <= 0.96));
});
