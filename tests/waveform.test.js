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

test("extractWaveformPeaks takes each block's peak, averaged across channels", () => {
  // Peaks are scaled by 1.85 and clamped to [.08, .98] so quiet tracks still draw.
  near(g.extractWaveformPeaks(fakeBuffer([[0, 0.4, -1, 0]]), 2), [0.74, 0.98]);
  near(g.extractWaveformPeaks(fakeBuffer([[0.4, 0.4], [0.4, 0.4]]), 1), [0.74]);
  near(g.extractWaveformPeaks(fakeBuffer([[0, 0, 0, 0]]), 2), [0.08, 0.08]);
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
