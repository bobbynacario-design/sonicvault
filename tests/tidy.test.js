"use strict";
// Tidying the vault: messy titles, duplicates, better takes and missing lyrics.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const NOW = new Date(2026, 9, 10, 12);
const SHEET = (word) => "[Verse 1]\n" + Array.from({ length: 6 }, (_, i) => word + " line number " + i + " of the song").join("\n");

test("titles lose what their file name left in them", () => {
  assert.equal(g.tidyTitle("harbour_lights_v2.mp3"), "Harbour Lights V2");
  assert.equal(g.tidyTitle("1712345678901-Still In"), "Still In");
  assert.equal(g.tidyTitle("Uuwi Na - Suno AI"), "Uuwi Na");
  assert.equal(g.tidyTitle("Neon   Jeepney  "), "Neon Jeepney");
  assert.equal(g.tidyTitle("BUO AT TOTOO"), "Buo At Totoo", "all capitals");
  assert.equal(g.tidyTitle("Paalam (Live Take)"), "", "a fine title is left alone");
  assert.equal(g.tidyTitle("Still In (2)"), "", "a take number stays: versions read it");
  assert.equal(g.tidyTitle("OPM"), "", "one word in capitals is a choice");
  assert.equal(g.tidyTitle("lowercase on purpose"), "", "lower case typed by hand stays");
});

test("an untitled song is named from its first sung line, when it has one", () => {
  assert.equal(g.tidyTitle("Untitled", "[Verse]\nThe boats come home, when the evening falls"), "The boats come home");
  assert.equal(g.tidyTitle("New Recording 3", "[Verse]\nSa dulo ng kalsada"), "Sa dulo ng kalsada");
  assert.equal(g.tidyTitle("Untitled", ""), "", "nothing to name it from");
});

test("songs that should have lyrics: singing, audio, no sheet", () => {
  assert.equal(g.needsLyrics({ audioURL: "u", lyrics: "" }), true);
  assert.equal(g.needsLyrics({ audioURL: "u", lyrics: "", aiVocalStyle: "Instrumental" }), false);
  assert.equal(g.needsLyrics({ audioURL: "u", lyrics: "words" }), false);
  assert.equal(g.needsLyrics({ lyrics: "" }), false, "no audio to listen to");
});

test("the same file twice is found by address, or by bytes and length; takes are not", () => {
  const list = [
    { id: "t-100", title: "A", audioURL: "a1", fileSize: 4000, duration: 180, plays: 2 },
    { id: "t-200", title: "A again", audioURL: "a2", fileSize: 4000, duration: 180.4, plays: 5 },
    { id: "t-300", title: "B", audioURL: "b", fileSize: 5000, duration: 200, plays: 1 },
    { id: "t-400", title: "B copy", audioURL: "b", plays: 0 },
    { id: "t-500", title: "C (1)", audioURL: "c1", fileSize: 6000, duration: 150 },
    { id: "t-600", title: "C (2)", audioURL: "c2", fileSize: 6100, duration: 162 },
    { id: "t-700", title: "D", audioURL: "d1", fileSize: 0, duration: 99 },
    { id: "t-800", title: "D?", audioURL: "d2", fileSize: 0, duration: 99 }
  ];
  const pairs = g.findDuplicates(list).map((p) => [p.keep.id, p.drop.id]);
  assert.deepEqual(pairs, [["t-200", "t-100"], ["t-300", "t-400"]], "the most played is kept; unknown sizes are never matched");
});

test("a merge adds plays and days together and keeps every karaoke take", () => {
  const keep = { plays: 3, playDays: { "2026-10-01": 1 }, takes: [{ id: "k1" }], lyrics: "", prompt: "" };
  const drop = { plays: 2, playDays: { "2026-10-01": 2, "2026-10-02": 1 }, skipDays: { "2026-10-02": 1 }, takes: [{ id: "k2" }], lyrics: SHEET("x"), prompt: "folk" };
  const merged = g.mergedTrackFields(keep, drop);
  assert.equal(merged.plays, 5);
  assert.deepEqual(merged.playDays, { "2026-10-01": 3, "2026-10-02": 1 });
  assert.deepEqual(merged.skipDays, { "2026-10-02": 1 });
  assert.deepEqual(merged.takes.map((t) => t.id), ["k1", "k2"]);
  assert.equal(merged.lyrics, SHEET("x"), "lyrics the kept copy lacked");
  assert.equal(merged.prompt, "folk");
  const bare = g.mergedTrackFields({ plays: 1, lyrics: "mine" }, { plays: 0 });
  assert.equal(bare.playDays, null);
  assert.equal(bare.takes, null);
  assert.equal(bare.lyrics, "mine");
});

test("a better take is suggested only when the evidence points away from the one standing for the song", () => {
  const take = (id, plays, extra) => Object.assign({ id, title: "S", plays, lyrics: SHEET("s"), playDays: { "2026-10-01": plays } }, extra);
  const noCheck = () => null;
  // Take 1 stands for the song (most played ever); take 2 wins lately.
  let s = g.suggestMainTake([take("t-1", 1, { plays: 30 }), take("t-2", 9)], NOW, noCheck);
  assert.equal(s.take.id, "t-2");
  assert.match(s.reason, /9 plays to 1 lately/);
  // The winner already stands for it: nothing to do.
  assert.equal(g.suggestMainTake([take("t-1", 2), take("t-2", 9)], NOW, noCheck), null);
  // Picked by hand, but the other take is the one played: still suggested.
  assert.equal(g.suggestMainTake([take("t-1", 1, { plays: 30, versionPick: true }), take("t-2", 9)], NOW, noCheck).take.id, "t-2");
  // No clear winner: the sung check decides, by two lines or more, with both checked.
  const checks = { "t-1": { asWritten: 9, total: 14 }, "t-2": { asWritten: 14, total: 14 } };
  assert.equal(g.suggestMainTake([take("t-1", 2, { plays: 6, versionPick: true }), take("t-2", 1)], NOW, (t) => checks[t.id]), null, "the sung check never overrides a main picked by hand");
  s = g.suggestMainTake([take("t-1", 2, { plays: 6 }), take("t-2", 1)], NOW, (t) => checks[t.id]);
  assert.equal(s.take.id, "t-2");
  assert.match(s.reason, /sang 14 of 14 lines as written, against 9/);
  assert.equal(g.suggestMainTake([take("t-1", 2, { plays: 6 }), take("t-2", 1)], NOW, (t) => (t.id === "t-2" ? checks["t-2"] : null)), null, "only one checked");
});

test("Whisper's words become lines at pauses, and sections at long ones", () => {
  const words = [
    ["The", 1.0, 1.2], ["boats", 1.2, 1.5], ["come", 1.5, 1.7], ["home", 1.7, 2.0],
    ["I", 3.0, 3.1], ["count", 3.1, 3.4], ["the", 3.4, 3.5], ["lights", 3.5, 3.9],
    ["And", 8.0, 8.2], ["every", 8.2, 8.5], ["light", 8.5, 8.8], ["", 8.8, 8.9]
  ];
  assert.equal(g.sheetFromWords(words), "The boats come home\nI count the lights\n\nAnd every light");
  const long = Array.from({ length: 14 }, (_, i) => ["w" + i, i * 0.3, i * 0.3 + 0.25]);
  assert.equal(g.sheetFromWords(long).split("\n").length, 2, "twelve words at most to a line");
  assert.equal(g.sheetFromWords([]), "");
});
