"use strict";
// Suno's two takes of a song are grouped as versions of one song.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const SHEET = "[Verse 1]\nWoke up September, one more turn around the sun\nForty-seven candles and I'm not done\n[Chorus]\nStill in, still holding";
const take = (id, title, extra = {}) => ({ id: "t-" + id, title, lyrics: SHEET, ...extra });

test("takes with the same lyric sheet share a key, whatever the formatting", () => {
  const a = take(1000, "Still In (1)");
  const b = take(1001, "Still In (2)", { lyrics: SHEET.replace("[Chorus]", "(Chorus)").replace(/\n/g, "\r\n").toUpperCase() });
  assert.ok(g.versionKey(a).startsWith("l:"));
  assert.equal(g.versionKey(a), g.versionKey(b));
  assert.notEqual(g.versionKey(a), g.versionKey(take(1002, "Other", { lyrics: SHEET + "\nA different last line here" })));
});

test("without lyrics, the title less its number and the prompt decide; too little to go on is no key", () => {
  const p = "warm acoustic folk, fingerpicked guitar";
  assert.equal(g.baseSongTitle("Still In (2)"), "Still In");
  assert.equal(g.baseSongTitle("Still In v2"), "Still In");
  assert.equal(g.baseSongTitle("Still In - Take 3"), "Still In");
  assert.equal(g.baseSongTitle("Still In [2]"), "Still In");
  assert.equal(g.baseSongTitle("Track 22"), "Track 22");
  assert.equal(g.versionKey({ title: "Harbour (1)", prompt: p }), g.versionKey({ title: "Harbour (2)", prompt: p }));
  assert.equal(g.versionKey({ title: "Harbour" }), "");
  assert.equal(g.versionKey({ title: "Harbour", lyrics: "[Verse]\nToo short" }), "");
});

test("the main version is the one picked, else the most played, else the first made", () => {
  const a = take(1000, "A", { plays: 2 });
  const b = take(1001, "B", { plays: 9 });
  assert.equal(g.primaryVersion([a, b]).id, "t-1001");
  assert.equal(g.primaryVersion([a, { ...b, plays: 2 }]).id, "t-1000");
  assert.equal(g.primaryVersion([a, b, take(1002, "C", { versionPick: true })]).id, "t-1002");
});

test("a list shows each song once, in the place of its first version", () => {
  const a = take(1000, "Still In (1)", { plays: 1 });
  const b = take(1001, "Still In (2)", { plays: 5 });
  const solo = { id: "t-2000", title: "Solo" };
  const all = [solo, a, b];
  const out = g.collapseVersions([a, solo, b], all);
  assert.deepEqual(out.list.map((t) => t.id), ["t-1001", "t-2000"], "the most played take stands for the song");
  assert.deepEqual(out.versions["t-1001"].map((t) => t.id), ["t-1000", "t-1001"], "versions listed first made first");
  // A search that matched only one take shows that take, still as a group.
  const searched = g.collapseVersions([a], all);
  assert.deepEqual(searched.list.map((t) => t.id), ["t-1000"]);
  assert.equal(searched.versions["t-1000"].length, 2);
  // Songs with no twin are untouched.
  assert.deepEqual(g.collapseVersions([solo], all).list, [solo]);
});

test("switching takes lands at the same line, as far through it", () => {
  // Take A sings lines at 10, 20, 30; take B, with a longer intro and slower, at 15, 27, 39.
  const a = [[10, 18], [20, 28], [30, 38]];
  const b = [[15, 25], [27, 37], [39, 49]];
  assert.equal(g.mapTakeTime(a, b, 25, 60), 33);    // halfway through line 2 in both
  assert.equal(g.mapTakeTime(a, b, 5, 60), 7.5);    // halfway through the intro
  assert.equal(g.mapTakeTime(a, b, 34, 60), 43);    // 4s into the last line
  assert.equal(g.mapTakeTime(a, b, 80, 60), 60);    // never past the end
  // Untimed, or different sheets: the same second.
  assert.equal(g.mapTakeTime(null, b, 25, 60), 25);
  assert.equal(g.mapTakeTime(a, b.slice(0, 2), 25, 60), 25);
});

test("takes play equally loud: the louder turned down to the quietest", () => {
  const gains = g.matchTakeLoudness([-8, -14, null]);
  assert.ok(Math.abs(gains[0] - 0.501) < 0.001);
  assert.equal(gains[1], 1);
  assert.equal(gains[2], 1);
  assert.deepEqual(g.matchTakeLoudness([null, undefined]), [1, 1]);
});
