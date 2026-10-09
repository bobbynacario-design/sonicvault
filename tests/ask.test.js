"use strict";
// Ask your vault: the catalog written out for Claude, and its answer read back.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const NOW = new Date(2026, 9, 10, 12);
const SHEET = (word) => "[Verse 1]\n" + Array.from({ length: 6 }, (_, i) => word + " line number " + i + " of the song").join("\n");

const VAULT = [
  { id: "t-1000", title: "Harbour Lights", created: "2026-10-02", source: "Suno", genre: "Folk", mood: "Warm", aiGenre: "Acoustic Folk",
    aiEnergy: "Low", aiVocalStyle: "Soft female vocal", duration: 192, plays: 7, playDays: { "2026-10-05": 2, "2026-09-01": 5 },
    aiTags: ["harbour", "home"], aiSummary: "A homecoming ballad.", lyrics: SHEET("harbour"),
    translations: { English: { from: "Bikol", lines: [] } } },
  { id: "t-1001", title: "Harbour Lights (2)", created: "2026-10-02", source: "Suno", genre: "Folk", mood: "Warm", plays: 1, playDays: { "2026-10-09": 1 }, lyrics: SHEET("harbour") },
  { id: "t-2000", title: "Neon", created: "2026-09-15", source: "Lyria", genre: "Synthwave", mood: "Energetic", plays: 0, lyrics: "" }
];

test("each song is one line under its first take's id, plays added across takes", () => {
  const text = g.buildAskCatalog(VAULT, [], NOW);
  const lines = text.split("\n");
  const harbour = lines.find((line) => line.startsWith("[t-1000]"));
  assert.ok(harbour, text);
  assert.ok(!lines.some((line) => line.startsWith("[t-1001]")), "the second take has no line of its own");
  assert.match(harbour, /made 2 Oct 2026/);
  assert.match(harbour, /Folk \/ Warm · style: Acoustic Folk · low energy · voice: Soft female vocal · 3:12 long/);
  assert.match(harbour, /played 8 \(3 in the last 30 days\), last on 9 Oct 2026/);
  assert.match(harbour, /2 takes · in Bikol · tags: harbour, home/);
  assert.match(harbour, /about: A homecoming ballad\. · opens: "harbour line number 0 of the song"/);
  const neon = lines.find((line) => line.startsWith("[t-2000]"));
  assert.match(neon, /instrumental/);
  assert.match(neon, /played 0$|played 0 ·/);
  assert.ok(lines.indexOf(harbour) < lines.indexOf(neon), "newest first");
});

test("the totals are counted for Claude", () => {
  const text = g.buildAskCatalog(VAULT, [], NOW);
  assert.match(text, /^Totals:\nSongs: 2 \(3 tracks, counting every take\)/);
  assert.match(text, /Made per month, newest first: Oct 2026 1, Sep 2026 1/);
  assert.match(text, /Genres: Folk 1, Synthwave 1/);
  assert.match(text, /Made with: Lyria 1, Suno 1/);
  assert.match(text, /Instrumentals: 1/);
  assert.match(text, /Plays: 8 in all, 3 in the last 7 days, 3 in the last 30 days/);
  assert.match(text, /Songs never played: 1/);
  assert.match(text, /Most played in the last 30 days: Harbour Lights 3/);
});

test("playlists name their songs by the ids the catalog uses", () => {
  const text = g.buildAskCatalog(VAULT, [{ name: "Road", trackIds: ["t-1001", "t-1000", "t-2000", "gone"] }, { trackIds: ["t-1000"] }], NOW);
  assert.match(text, /Playlists:\n- Road \(2 songs\): t-1000, t-2000\n/);
  assert.match(g.buildAskCatalog(VAULT, [], NOW), /Playlists: none yet/);
});

test("days and months read the way people say them", () => {
  assert.equal(g.askDate("2026-10-02"), "2 Oct 2026");
  assert.equal(g.askDate("2026-01"), "Jan 2026");
  assert.equal(g.askDate("someday"), "someday");
  assert.equal(g.askDate("2026-13-01"), "2026-13-01");
});

test("plays are counted by day: the last 7 and 30 days include today", () => {
  const track = { playDays: { "2026-10-10": 1, "2026-10-04": 2, "2026-10-03": 4, "2026-09-11": 8, "2026-09-10": 16 } };
  assert.equal(g.playsSince(track, NOW, 7), 3);
  assert.equal(g.playsSince(track, NOW, 30), 15);
  assert.equal(g.lastPlayedDay(track), "2026-10-10");
  assert.equal(g.lastPlayedDay({}), "");
});

test("an answer keeps only songs the vault has, each once; an action needs songs", () => {
  const has = (id) => id === "t-1" || id === "t-2";
  assert.deepEqual(g.readAskAnswer({ answer: " Two songs. ", songs: ["t-2", "made-up", "t-1", "t-2"], action: "play", playlistName: "x" }, has),
    { answer: "Two songs.", songs: ["t-2", "t-1"], action: "play", playlistName: "" });
  assert.deepEqual(g.readAskAnswer({ answer: "Here.", songs: ["t-1"], action: "playlist", playlistName: " Rainy " }, has).playlistName, "Rainy");
  assert.equal(g.readAskAnswer({ answer: "None.", songs: ["nope"], action: "play" }, has).action, "none");
  assert.equal(g.readAskAnswer({ answer: "Hm.", songs: ["t-1"], action: "delete" }, has).action, "none");
  assert.deepEqual(g.readAskAnswer(null, has), { answer: "", songs: [], action: "none", playlistName: "" });
});

test("a quoted line finds the songs that sing it", () => {
  assert.deepEqual(g.quotedPhrases('which song goes "Harbour line number 3"? or “line number 5”'), ["Harbour line number 3", "line number 5"]);
  assert.deepEqual(g.quotedPhrases("I don't know which one 'it' is"), []);
  assert.deepEqual(g.songsWithPhrase(VAULT, "HARBOUR, line number 3!").map((t) => t.id), ["t-1000", "t-1001"]);
  assert.deepEqual(g.songsWithPhrase(VAULT, "a"), []);
});

test("lyrics go with a question until the room runs out", () => {
  const text = g.askPassages(VAULT, 400);
  assert.match(text, /^\[t-1000\] Harbour Lights\n\[Verse 1\]\nharbour line number 0/);
  assert.ok(!text.includes("[t-1001]"), "no room for a second sheet");
  assert.ok(!text.includes("[t-2000]"), "an instrumental has none");
});
