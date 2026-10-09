"use strict";
// Song lab: which songs Claude learns the songwriter's voice from, and the
// drafts it writes back.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const NOW = new Date(2026, 9, 10, 12);
const SHEET = (word) => "[Verse 1]\n" + Array.from({ length: 6 }, (_, i) => word + " line number " + i + " of the song").join("\n");

test("the most loved songs are learnt from: recent plays count four times, one take each", () => {
  const list = [
    { id: "t-1", title: "Old Favourite", lyrics: SHEET("old"), plays: 20 },
    { id: "t-2", title: "On Repeat", lyrics: SHEET("repeat"), plays: 6, playDays: { "2026-10-01": 3, "2026-10-09": 3 } },
    { id: "t-3", title: "Instrumental", lyrics: "", plays: 99 },
    { id: "t-4", title: "On Repeat (2)", lyrics: SHEET("repeat"), plays: 1 },
    { id: "t-5", title: "Quiet", lyrics: SHEET("quiet"), plays: 0 }
  ];
  const picked = g.pickSongLabExamples(list, NOW, "", 6).map((t) => t.title);
  // 6 + 3*6 = 24 beats 20; the second take of On Repeat is not a second song;
  // songs without lyrics have no voice to learn.
  assert.deepEqual(picked, ["On Repeat", "Old Favourite", "Quiet"]);
  assert.equal(g.pickSongLabExamples(list, NOW, "", 1).length, 1);
});

test("a song chosen by name leads, without its other take", () => {
  const list = [
    { id: "t-1", title: "A", lyrics: SHEET("a"), plays: 9 },
    { id: "t-2", title: "B", lyrics: SHEET("b"), plays: 1 },
    { id: "t-3", title: "B (2)", lyrics: SHEET("b"), plays: 0 },
    { id: "t-4", title: "Instrumental", lyrics: "", plays: 0 }
  ];
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "t-3").map((t) => t.id), ["t-3", "t-1"]);
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "t-4").map((t) => t.id), ["t-4", "t-1", "t-2"], "an instrumental can set the sound");
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "gone").map((t) => t.id), ["t-1", "t-2"]);
});

test("a song's sound is its prompt, else what its description says", () => {
  assert.equal(g.songLabSound({ prompt: "  warm folk, 90 BPM " }), "warm folk, 90 BPM");
  assert.equal(g.songLabSound({ genre: "Folk", aiGenre: "Acoustic Folk", mood: "Warm", aiInstruments: ["Guitar", "Fiddle"], aiVocalStyle: "Soft female vocal", aiEnergy: "Low" }),
    "Acoustic Folk, Warm, Guitar, Fiddle, Soft female vocal, Low energy");
  assert.equal(g.songLabSound({ genre: "Other" }), "", "the placeholder genre says nothing");
});

test("an example is sized for the worker", () => {
  const ex = g.songLabExample({ title: " T ", prompt: "p".repeat(900), lyrics: "l".repeat(3000) });
  assert.equal(ex.title, "T");
  assert.equal(ex.sound.length, 800);
  assert.equal(ex.lyrics.length, 2500);
});

test("drafts are kept newest first, twelve at most, and junk is dropped", () => {
  const make = (n) => g.songLabDraft({ title: "Song " + n, style: "s", lyrics: "l", about: "a" }, { idea: "i", language: "Bikol", from: ["A", "", "B"] }, new Date(2026, 9, 10, 12, n));
  const first = make(1);
  assert.equal(first.id, "draft-" + new Date(2026, 9, 10, 12, 1).getTime());
  assert.deepEqual(first.from, ["A", "B"]);
  assert.equal(first.language, "Bikol");
  let list = g.addSongLabDraft([null, "junk", { id: "x" }], first);
  assert.deepEqual(list.map((d) => d.title), ["Song 1"]);
  for (let n = 2; n <= 14; n++) list = g.addSongLabDraft(list, make(n));
  assert.equal(list.length, 12);
  assert.equal(list[0].title, "Song 14");
  assert.equal(list[11].title, "Song 3");
});

test("a draft is found in the vault by its words, once Suno has sung it", () => {
  const draft = { lyrics: SHEET("harbour") };
  const made = { id: "t-9", title: "Harbour", lyrics: SHEET("harbour").replace("[Verse 1]", "[Verse]").toUpperCase() + "!" };
  assert.equal(g.songLabMadeAs(draft, [{ id: "t-1", lyrics: SHEET("other") }, made]), made);
  assert.equal(g.songLabMadeAs(draft, [{ id: "t-1", lyrics: SHEET("other") }]), null);
  assert.equal(g.songLabMadeAs({ lyrics: "short" }, [{ lyrics: "short" }]), null, "too few words to be sure");
});

test("fields longer than Suno takes are named", () => {
  assert.deepEqual(g.sunoOverflow({ title: "t", style: "s".repeat(1001), lyrics: "l" }), [{ field: "style", length: 1001, limit: 1000 }]);
  assert.deepEqual(g.sunoOverflow({ title: "t", style: "s", lyrics: "l".repeat(5000) }), []);
});
