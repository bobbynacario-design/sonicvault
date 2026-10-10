"use strict";
// Takes: your voice over the instrumental, lined up, mixed and kept.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("the voice is moved earlier by the delay it was recorded with, and by hand", () => {
  assert.equal(g.takeVoiceStart(0.05, 0), -0.05);
  assert.equal(+g.takeVoiceStart(0.05, 80).toFixed(3), 0.03);
  assert.equal(g.takeVoiceStart(0, -120), -0.12);
  assert.equal(g.takeVoiceStart(undefined, undefined), 0);
});

test("the voice is added into both channels at its place, over the music's length", () => {
  const rate = 10;
  const left = new Float32Array(10).fill(0.1);
  const right = new Float32Array(10).fill(0.2);
  const voice = new Float32Array([1, 2, 3, 4]);
  // Two samples later, at half volume.
  let mix = g.mixTake(left, right, voice, rate, 0.2, 0.5);
  assert.deepEqual([...mix.left].map((v) => +v.toFixed(2)), [0.1, 0.1, 0.6, 1.1, 1.6, 2.1, 0.1, 0.1, 0.1, 0.1]);
  assert.equal(+mix.right[2].toFixed(2), 0.7);
  // One sample earlier than the music: its first sample falls before the take.
  mix = g.mixTake(left, right, voice, rate, -0.1, 1);
  assert.deepEqual([...mix.left].slice(0, 4).map((v) => +v.toFixed(2)), [2.1, 3.1, 4.1, 0.1]);
  // Running past the end is cut off, and the music itself is left alone.
  mix = g.mixTake(left, right, voice, rate, 0.8, 1);
  assert.equal(mix.left.length, 10);
  assert.deepEqual([...mix.left].slice(7).map((v) => +v.toFixed(2)), [0.1, 1.1, 2.1]);
  assert.equal(left[8], Float32Array.of(0.1)[0]);
});

test("takes are kept newest first, twenty at most, and come off by id", () => {
  let list = [];
  for (let i = 1; i <= 22; i++) list = g.addTake(list, { id: "take-" + i });
  assert.equal(list.length, 20);
  assert.equal(list[0].id, "take-22");
  assert.equal(list[19].id, "take-3");
  assert.deepEqual(g.removeTake(list, "take-22").map((t) => t.id).slice(0, 2), ["take-21", "take-20"]);
  assert.deepEqual(g.addTake(undefined, { id: "a" }), [{ id: "a" }]);
});

test("a take says where it starts and how long it runs", () => {
  assert.equal(g.takeSummary({ start: 0.4, duration: 198.8 }), "From the start · 3:19 long");
  assert.equal(g.takeSummary({ start: 45, duration: 72 }), "From 0:45 · 1:12 long");
  assert.equal(g.takeFileName("The World Won’t End", "2026-10-05T03:00:00Z"), "The World Won’t End (my take 2026-10-05).mp3");
  assert.equal(g.takeFileName("a/b:c", ""), "abc (my take ).mp3");
});

test("a Cloudinary take downloads instead of playing in the tab", () => {
  const url = "https://res.cloudinary.com/dtw4em0ob/video/upload/v1/sonicvault-bob/audio/take.mp3";
  assert.equal(g.takeDownloadURL(url), "https://res.cloudinary.com/dtw4em0ob/video/upload/fl_attachment/v1/sonicvault-bob/audio/take.mp3");
  assert.equal(g.takeDownloadURL(g.takeDownloadURL(url)), g.takeDownloadURL(url));
  assert.equal(g.takeDownloadURL("https://example.com/upload/x.mp3"), "https://example.com/upload/x.mp3");
});
