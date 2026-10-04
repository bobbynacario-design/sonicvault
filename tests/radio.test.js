"use strict";
// Radio: how alike two songs are, and which to queue next.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const LYRICS = "[Verse]\nCounted out the quiet years like chips across the felt\nMy brother bet the farm on a pair of sevens once";
const song = (id, extra) => ({ id, title: id, audioURL: "a.mp3", aiSource: "claude", ...extra });

test("songs alike in genre, mood, tags, meaning and loudness score higher", () => {
  const seed = song("seed", { genre: "Country", mood: "Warm", aiTags: ["Poker", "Family"], lufs: -10 });
  const close = song("close", { genre: "Country", mood: "Warm", aiTags: ["Poker", "Birthday"], lufs: -11 });
  const far = song("far", { genre: "Synthwave", mood: "Energetic", aiTags: ["Night", "Drive"], lufs: -1 });
  assert.ok(g.radioScore(seed, close) > g.radioScore(seed, far));
  assert.equal(g.radioScore(seed, far), 0);
  // What a song is about counts most when both have a meaning vector.
  const v = [1, 0, 0];
  assert.ok(g.radioScore(seed, far, v, [0.9, 0.1, 0]) > g.radioScore(seed, far, v, [0, 1, 0]));
});

test("a batch skips the seed, its other takes, and repeats while others remain", () => {
  const seed = song("seed (1)", { lyrics: LYRICS, genre: "Country" });
  const pool = [
    seed,
    song("seed (2)", { lyrics: LYRICS, genre: "Country" }),
    song("a", { genre: "Country" }), song("b", { genre: "Country" }), song("c", { genre: "Pop" }), song("d", { genre: "Pop" })
  ];
  const first = g.pickRadioBatch(seed, pool, [], 3, null, () => 0);
  assert.deepEqual(first, ["a", "b", "c"], "closest first when the draw always takes the top");
  const next = g.pickRadioBatch(seed, pool, first, 1, null, () => 0);
  assert.deepEqual(next, ["d"]);
});

test("each song comes once, as its main take", () => {
  const seed = song("seed", { genre: "Pop" });
  const other = "[Verse]\nSalt on the window rain on the sea and the harbour lights are calling me home";
  const pool = [seed, song("h (1)", { lyrics: other, genre: "Pop" }), song("h (2)", { lyrics: other, genre: "Pop", versionPick: true })];
  assert.deepEqual(g.pickRadioBatch(seed, pool, [], 5, null, () => 0), ["h (2)"]);
});

test("a small library lets songs come round again, but not the last ones played", () => {
  const seed = song("seed", { genre: "Pop" });
  const pool = [seed, ...["a", "b", "c", "d"].map((id) => song(id, { genre: "Pop" }))];
  const batch = g.pickRadioBatch(seed, pool, ["a", "b", "c", "d"], 3, null, () => 0);
  assert.equal(batch.length, 2);
  assert.ok(!batch.includes("c") && !batch.includes("d"), "the last two played stay out");
});

test("the draw favours closer songs but isn't fixed", () => {
  const seed = song("seed", { genre: "Country", mood: "Warm" });
  const pool = [seed, song("near", { genre: "Country", mood: "Warm" }), song("mid", { genre: "Country" }), song("far", { genre: "Pop" })];
  const firsts = { near: 0, mid: 0, far: 0 };
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 300; i++) firsts[g.pickRadioBatch(seed, pool, [], 1, null, rand)[0]]++;
  assert.ok(firsts.near > firsts.mid && firsts.mid > firsts.far && firsts.far > 0, JSON.stringify(firsts));
});

test("songs coming round again leave their old place, so each is queued once", () => {
  // Playing c (index 2); d and e are next. b comes round again.
  assert.deepEqual(g.appendRadioBatch(["a", "b", "c", "d", "e"], 2, ["b", "f"]), ["a", "c", "d", "e", "b", "f"]);
  // Nothing playing or still to come is added again.
  assert.deepEqual(g.appendRadioBatch(["a", "b", "c", "d"], 1, ["c", "d", "e", "e"]), ["a", "b", "c", "d", "e"]);
  // Only so many played songs stay behind.
  assert.deepEqual(g.appendRadioBatch(["a", "b", "c", "d", "e"], 4, ["f"], 2), ["c", "d", "e", "f"]);
});
