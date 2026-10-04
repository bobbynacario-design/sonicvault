"use strict";
// Search by meaning: song text, compact vectors, similarity and ranking.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("a song's meaning text leads with what it is about, then its lyrics", () => {
  const text = g.songMeaningText({
    title: "Still In", aiSource: "claude", aiSummary: "A birthday toast in poker terms.", aiTheme: "Aging, Resilience",
    aiTags: ["Poker", "Birthday"], mood: "Warm", genre: "Country", prompt: "slow country waltz",
    lyrics: "[Verse]\nWoke up September\n[Chorus]\nStill in"
  });
  assert.equal(text, "Still In. A birthday toast in poker terms.. Themes: Aging, Resilience. Tags: Poker, Birthday. Warm, Country. slow country waltz. Woke up September / Still in");
  assert.ok(g.songMeaningText({ title: "X", lyrics: "word ".repeat(2000) }).length <= 3600);
  assert.equal(g.songMeaningText({}), "");
});

test("vectors keep their direction through the compact form", () => {
  const v = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.37) * 0.05);
  const packed = g.packMeaningVector(v);
  assert.equal(typeof packed.data, "string");
  assert.ok(packed.data.length < 1400, "about 1.4KB");
  const back = g.unpackMeaningVector(packed);
  assert.ok(g.meaningSimilarity(v, back) > 0.999);
  const other = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 1.7) * 0.05);
  assert.ok(Math.abs(g.meaningSimilarity(v, other)) < 0.2);
  assert.equal(g.meaningSimilarity(v, v.slice(0, 10)), 0);
});

test("the matches are those within reach of the best, best first", () => {
  const scored = [{ id: "a", score: 0.41 }, { id: "b", score: 0.55 }, { id: "c", score: 0.39 }, { id: "d", score: 0.2 }];
  // A clear best match stands alone: .41 is too far behind .55 to be about the same thing.
  assert.deepEqual(g.rankMeaningMatches(scored).map((x) => x.id), ["b"]);
  assert.deepEqual(g.rankMeaningMatches([{ id: "a", score: 0.47 }, { id: "b", score: 0.55 }]).map((x) => x.id), ["b", "a"]);
  // When nothing stands out, everything close to the top is shown, in order.
  const flat = [{ id: "a", score: 0.49 }, { id: "b", score: 0.5 }, { id: "c", score: 0.44 }];
  assert.deepEqual(g.rankMeaningMatches(flat).map((x) => x.id), ["b", "a", "c"]);
  assert.deepEqual(g.rankMeaningMatches([]), []);
  assert.equal(g.rankMeaningMatches(Array.from({ length: 40 }, (_, i) => ({ id: "t" + i, score: 0.5 })), 24).length, 24);
});

test("a playlist from a sentence takes the songs near the best match, within limits", () => {
  const scored = [0.62, 0.58, 0.5, 0.45, 0.41, 0.3, 0.2].map((score, i) => ({ id: "s" + i, score }));
  assert.deepEqual(g.pickPlaylistByMeaning(scored, 3, 20), ["s0", "s1", "s2", "s3"]);
  // Too few close ones: the best few anyway.
  assert.deepEqual(g.pickPlaylistByMeaning(scored, 6, 20), ["s0", "s1", "s2", "s3", "s4", "s5"]);
  assert.equal(g.pickPlaylistByMeaning(Array.from({ length: 30 }, (_, i) => ({ id: "t" + i, score: 0.5 })), 6, 20).length, 20);
  assert.deepEqual(g.pickPlaylistByMeaning([], 6, 20), []);
});

test("the playlist is named from the sentence", () => {
  assert.equal(g.playlistNameFromSentence("  songs for a rainy sunday drive. "), "Songs for a rainy sunday drive");
  assert.equal(g.playlistNameFromSentence(""), "New playlist");
  const long = g.playlistNameFromSentence("songs about " + "the long road home ".repeat(6));
  assert.ok(long.length <= 58 && long.endsWith("…"), long);
});
