"use strict";
// Song lab: which songs Claude learns the songwriter's voice from, and the
// drafts it writes back.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const NOW = new Date(2026, 9, 10, 12);
const SHEET = (word) => "[Verse 1]\n" + Array.from({ length: 6 }, (_, i) => word + " line number " + i + " of the song").join("\n");

test("the newest songs lead -- how they write now -- then the most loved, one take each", () => {
  const list = [
    { id: "t-1", title: "March Favourite", created: "2026-03-29", lyrics: SHEET("march"), plays: 180 },
    { id: "t-2", title: "March Other", created: "2026-03-29", lyrics: SHEET("other"), plays: 60, playDays: { "2026-10-09": 5 } },
    { id: "t-3", title: "April", created: "2026-04-02", lyrics: SHEET("april"), plays: 9 },
    { id: "t-4", title: "Instrumental", created: "2026-10-09", lyrics: "", plays: 99 },
    { id: "t-5", title: "October", created: "2026-10-04", lyrics: SHEET("october"), plays: 20 },
    { id: "t-6", title: "October (2)", created: "2026-10-04", lyrics: SHEET("october"), plays: 1 },
    { id: "t-7", title: "This Week", created: "2026-10-08", lyrics: SHEET("week"), plays: 2 },
    { id: "t-8", title: "Today", created: "2026-10-10", lyrics: SHEET("today"), plays: 0 }
  ];
  const picked = g.pickSongLabExamples(list, NOW, "", 6).map((t) => t.title);
  // The three newest songs with lyrics, then by love: 60 + 3*5 = 75 for March
  // Other against 180 for March Favourite; one take of October; no lyrics, no voice.
  assert.deepEqual(picked, ["Today", "This Week", "October", "March Favourite", "March Other", "April"]);
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "", 2).map((t) => t.title), ["Today", "This Week"]);
});

test("a song chosen by name leads, without its other take", () => {
  const list = [
    { id: "t-1", title: "A", created: "2026-10-01", lyrics: SHEET("a"), plays: 9 },
    { id: "t-2", title: "B", created: "2026-10-02", lyrics: SHEET("b"), plays: 1 },
    { id: "t-3", title: "B (2)", created: "2026-10-02", lyrics: SHEET("b"), plays: 0 },
    { id: "t-4", title: "Instrumental", created: "2026-10-03", lyrics: "", plays: 0 }
  ];
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "t-3").map((t) => t.id), ["t-3", "t-1"]);
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "t-4").map((t) => t.id), ["t-4", "t-2", "t-1"], "an instrumental can set the sound");
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "gone").map((t) => t.id), ["t-2", "t-1"]);
});

test("a song that began as a Song lab draft is Claude's writing, so it isn't learnt from", () => {
  const list = [
    { id: "t-1", title: "Mine", created: "2026-10-04", lyrics: SHEET("mine"), plays: 3 },
    { id: "t-2", title: "From a draft", created: "2026-10-10", lyrics: SHEET("drafted").toUpperCase() + "!", plays: 5 }
  ];
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "", 6, [{ lyrics: SHEET("drafted") }]).map((t) => t.title), ["Mine"]);
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "", 6).map((t) => t.title), ["From a draft", "Mine"], "no drafts given");
  assert.deepEqual(g.pickSongLabExamples(list, NOW, "t-2", 6, [{ lyrics: SHEET("drafted") }]).map((t) => t.title), ["From a draft", "Mine"], "chosen by name, it still leads");
});

test("recent drafts go to the worker as a line each, to write about something else", () => {
  const drafts = [{ title: "Kape", about: "A quiet morning." }, { title: "", about: "no title" }, { title: "Pundasyon" }, null];
  assert.deepEqual(g.songLabAvoidList(drafts), ["Kape: A quiet morning.", "Pundasyon"]);
  assert.deepEqual(g.songLabAvoidList([{ title: "Mama", about: "A video call.", images: ["ceiling fan", "loose screw"] }]),
    ["Mama: A video call. (images: ceiling fan, loose screw)"], "the images a draft was built on go too");
  assert.deepEqual(g.songLabAvoidList([{ title: "Photo", about: "A passport photo.", subject: "a son and his mother; leaving home", images: ["passport photo"] }]),
    ["Photo: A passport photo. (subject: a son and his mother; leaving home; images: passport photo)"], "and its subject");
  assert.deepEqual(g.songLabAvoidList(drafts, 1), ["Kape: A quiet morning."]);
  assert.deepEqual(g.songLabAvoidList(undefined), []);
});

test("a song's sound is its prompt, else what its description says", () => {
  assert.equal(g.songLabSound({ prompt: "  warm folk, 90 BPM " }), "warm folk, 90 BPM");
  assert.equal(g.songLabSound({ genre: "Folk", aiGenre: "Acoustic Folk", mood: "Warm", aiInstruments: ["Guitar", "Fiddle"], aiVocalStyle: "Soft female vocal", aiEnergy: "Low" }),
    "Acoustic Folk, Warm, Guitar, Fiddle, Soft female vocal, Low energy");
  assert.equal(g.songLabSound({ genre: "Other" }), "", "the placeholder genre says nothing");
});

test("an example is sized for the worker", () => {
  const ex = g.songLabExample({ title: " T ", created: "2026-10-04", prompt: "p".repeat(900), lyrics: "l".repeat(3000) });
  assert.equal(ex.title, "T");
  assert.equal(ex.made, "2026-10-04");
  assert.equal(ex.sound.length, 800);
  assert.equal(ex.lyrics.length, 2500);
});

test("drafts are kept newest first, twelve at most, and junk is dropped", () => {
  const make = (n) => g.songLabDraft({ title: "Song " + n, style: "s", lyrics: "l", about: "a", subject: " a man and his neighbour ", images: [" a fan ", "", "x".repeat(50)] }, { idea: "i", language: "Bikol", from: ["A", "", "B"] }, new Date(2026, 9, 10, 12, n));
  const first = make(1);
  assert.equal(first.id, "draft-" + new Date(2026, 9, 10, 12, 1).getTime());
  assert.deepEqual(first.from, ["A", "B"]);
  assert.deepEqual(first.images, ["a fan", "x".repeat(40)]);
  assert.equal(first.subject, "a man and his neighbour");
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
  // Suno sang a line twice: still the draft's song (Kape Sa Madaling Araw, 2026-10-10).
  const repeated = { id: "t-8", lyrics: SHEET("harbour") + "\nharbour line number 5 of the song" };
  assert.equal(g.songLabMadeAs(draft, [repeated]), repeated);
  // Half the lines rewritten: the songwriter's own now.
  const rewritten = { id: "t-7", lyrics: "[Verse 1]\n" + [0, 1, 2].map((i) => "harbour line number " + i + " of the song").concat(["new words a", "new words b", "new words c"]).join("\n") };
  assert.equal(g.songLabMadeAs(draft, [rewritten]), null);
});

test("fields longer than Suno takes are named", () => {
  assert.deepEqual(g.sunoOverflow({ title: "t", style: "s".repeat(1001), lyrics: "l" }), [{ field: "style", length: 1001, limit: 1000 }]);
  assert.deepEqual(g.sunoOverflow({ title: "t", style: "s", lyrics: "l".repeat(5000) }), []);
});
