"use strict";
// Story clips: which part of a song a clip uses, how its words wrap, and
// what it is recorded in.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const SHEET = [
  "[Verse 1]",
  "Woke up September with the radio on",
  "Counted out the quiet years",
  "[Pre-Chorus]",
  "And I know, I know",
  "[Chorus]",
  "Still in, still in",
  "Never folding on a Sunday",
  "[Verse 2]",
  "My brother bet the farm",
  "[Chorus]",
  "Still in, still in"
].join("\n");

// Each sung line four seconds long, the first at 10s.
function evenTimes(count) {
  return Array.from({ length: count }, (_, i) => [10 + i * 4, 14 + i * 4]);
}

test("a clip starts just before the first chorus, not the pre-chorus", () => {
  const rows = g.parseLyricSheet(SHEET);
  const pick = g.pickStoryStart(rows, evenTimes(7), 180, 15);
  // "Still in, still in" is the fourth sung line: 10 + 3 * 4 = 22s.
  assert.deepEqual(pick, { start: 21.2, reason: "chorus" });
});

test("without a chorus label, the line sung most; then where the singing starts", () => {
  const hook = g.parseLyricSheet("Walking home\nOh my love\nRain again\nOh, my love!\nThe end");
  assert.deepEqual(g.pickStoryStart(hook, evenTimes(5), 180, 15), { start: 13.2, reason: "hook" });
  const plain = g.parseLyricSheet("One line\nAnother line\nA third");
  assert.deepEqual(g.pickStoryStart(plain, evenTimes(3), 180, 15), { start: 9.2, reason: "first-line" });
});

test("untimed songs start a third of the way in, and no clip runs past the end", () => {
  const rows = g.parseLyricSheet(SHEET);
  assert.deepEqual(g.pickStoryStart(rows, null, 180, 15), { start: 60, reason: "middle" });
  assert.deepEqual(g.pickStoryStart([], null, 0, 15), { start: 0, reason: "middle" });
  // A chorus at 2:55 of a three-minute song: the clip ends with the song.
  const late = g.pickStoryStart(rows, evenTimes(7).map(([a, b]) => [a + 160, b + 160]), 190, 15);
  assert.deepEqual(late, { start: 175, reason: "chorus" });
  assert.equal(g.pickStoryStart(rows, null, 20, 30).start, 0);
});

test("words wrap to the width, with an ellipsis past the last line", () => {
  const measure = (s) => s.length * 10;
  assert.deepEqual(g.wrapStoryText("still in still in never folding", measure, 150, 3), ["still in still", "in never", "folding"]);
  assert.deepEqual(g.wrapStoryText("still in still in never folding", measure, 150, 2), ["still in still", "in never…"]);
  assert.deepEqual(g.wrapStoryText("  ", measure, 160, 2), []);
  assert.deepEqual(g.wrapStoryText("supercalifragilistic word", measure, 100, 3), ["supercalifragilistic", "word"]);
});

test("clips record in MP4 where the browser can, else WebM", () => {
  assert.equal(g.pickStoryFormat((t) => t.startsWith("video/mp4")).ext, "mp4");
  assert.equal(g.pickStoryFormat((t) => t === "video/webm;codecs=vp9,opus").type, "video/webm;codecs=vp9,opus");
  assert.equal(g.pickStoryFormat(() => false), null);
  assert.equal(g.pickStoryFormat(() => { throw new Error("no"); }), null);
});

test("file names keep the title and drop what file systems refuse", () => {
  assert.equal(g.storyFileName("Still In (1)", "mp4"), "Still In (1) - SonicVault clip.mp4");
  assert.equal(g.storyFileName('AC/DC: "Live"?', "webm"), "ACDC Live - SonicVault clip.webm");
  assert.equal(g.storyFileName("", ""), "Song - SonicVault clip.mp4");
});

test("bars follow the analyser, from silence to full", () => {
  assert.deepEqual(g.storyBarLevels(null, 4), [0, 0, 0, 0]);
  const quiet = g.storyBarLevels(new Uint8Array(512), 28);
  assert.equal(quiet.length, 28);
  assert.ok(quiet.every((v) => v === 0));
  const loud = g.storyBarLevels(new Uint8Array(512).fill(255), 28);
  assert.ok(loud.every((v) => v === 1));
  const bass = new Uint8Array(512);
  bass.fill(200, 0, 12);
  const levels = g.storyBarLevels(bass, 28);
  assert.ok(levels[0] > 0.5 && levels[27] === 0, "low notes light the first bars only");
});

test("frames fade in from black and out at the end", () => {
  assert.equal(g.storyFade(0, 15), 0);
  assert.equal(g.storyFade(7, 15), 1);
  assert.equal(g.storyFade(15, 15), 0);
  assert.ok(g.storyFade(14.7, 15) > 0 && g.storyFade(14.7, 15) < 1);
});

test("palette colours take an opacity for gradients", () => {
  assert.equal(g.hslWithAlpha("hsl(200 80% 62%)", 0.5), "hsla(200, 80%, 62%, 0.5)");
  assert.equal(g.hslWithAlpha("hsla(230, 14%, 70%, .1)", 0), "hsla(230, 14%, 70%, 0)");
  assert.equal(g.hslWithAlpha("#fff", 0.2), "rgba(255, 255, 255, 0.2)");
});
