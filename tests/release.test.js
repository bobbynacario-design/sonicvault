"use strict";
// Ready for Spotify: what stands between each song and a release.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const PLAN = "2026-06-01";
// Noon UTC is the same local day from UTC-11 to UTC+11.
const made = (day) => day + "T12:00:00Z";
const SHEET = (word) => "[Verse 1]\n" + Array.from({ length: 6 }, (_, i) => word + " line number " + i + " of the song").join("\n");
const song = (extra) => Object.assign({ id: "t-1", title: "Pauwi", source: "Suno", duration: 200, lyrics: SHEET("pauwi"), created: "2026-09-01" }, extra);
const levels = (check) => check.items.map((item) => item.level);
const rights = (track, plan) => g.releaseCheck(track, { planSince: plan === undefined ? PLAN : plan, timed: true }).items[0];

test("a Suno song made before the plan began can't be released; after, it can", () => {
  const before = rights(song({ madeAt: made("2026-03-14") }));
  assert.equal(before.level, "block");
  assert.match(before.text, /^Made on 14 Mar 2026, before your Suno plan began on 1 Jun 2026/);
  const after = rights(song({ madeAt: made("2026-08-31") }));
  assert.deepEqual(after, { level: "ok", text: "Made while on your Suno plan." });
  assert.equal(rights(song({ madeAt: made(PLAN) })).level, "check", "the day it began could be either side");
});

test("without Suno's stamp, the day it reached the vault decides only what it can", () => {
  assert.equal(rights(song({ created: "2026-05-20" })).level, "block", "reached the vault before the plan, so made before it");
  const soon = rights(song({ created: "2026-06-05" }));
  assert.equal(soon.level, "check");
  assert.match(soon.text, /4 days after your plan began/);
  assert.equal(rights(song({ created: "2026-07-20" })).level, "ok");
  assert.equal(rights(song({ created: "", id: "t-" + Date.UTC(2026, 6, 20, 12) })).level, "ok", "the id's time when there is no date");
});

test("with no plan date, a Suno song waits for one", () => {
  const item = rights(song({ madeAt: made("2026-08-31") }), "");
  assert.equal(item.level, "check");
  assert.match(item.text, /Set the day your Suno plan began/);
});

test("rights by source; a file Suno stamped is a Suno song whatever its source says", () => {
  assert.equal(rights(song({ source: "Original" })).level, "ok");
  assert.equal(rights(song({ source: "Udio" })).level, "check");
  assert.equal(rights(song({ source: "Lyria" })).level, "check");
  assert.equal(rights(song({ source: "" })).level, "check");
  const stamped = g.releaseCheck(song({ source: "Original", madeAt: made("2026-03-14"), sunoId: "x" }), { planSince: PLAN });
  assert.equal(stamped.status, "blocked");
  assert.ok(stamped.items.some((item) => /file says it was made with Suno, though its source says Original/.test(item.text)));
});

test("too short, a file-name title, a take number and a shared title", () => {
  assert.ok(levels(g.releaseCheck(song({ madeAt: made("2026-08-31"), duration: 24 }), { planSince: PLAN })).includes("fix"));
  const messy = g.releaseCheck(song({ madeAt: made("2026-08-31"), title: "pauwi_final.mp3" }), { planSince: PLAN });
  assert.equal(messy.status, "fix");
  assert.equal(messy.title, "Pauwi Final");
  assert.equal(messy.items.find((item) => item.tidy).tidy, "Pauwi Final");
  const take = g.releaseCheck(song({ madeAt: made("2026-08-31"), title: "Still In (2)" }), { planSince: PLAN, timed: true });
  assert.equal(take.status, "ready", "a take number is a note, not a fix");
  assert.equal(take.title, "Still In");
  assert.ok(take.items.some((item) => item.level === "note" && /Release it as “Still In”/.test(item.text)));
  const clash = g.releaseCheck(song({ madeAt: made("2026-08-31") }), { planSince: PLAN, clashes: [{ id: "t-2" }] });
  assert.equal(clash.status, "check");
});

test("takes, explicit words, lyrics and Song lab words", () => {
  const base = { planSince: PLAN, timed: true };
  const two = g.releaseCheck(song({ madeAt: made("2026-08-31") }), Object.assign({ takes: [{}, {}] }, base));
  assert.ok(two.items.some((item) => /main one of 2/.test(item.text)));
  const rude = g.releaseCheck(song({ madeAt: made("2026-08-31"), lyrics: "[Verse]\nPutang ina, shit, SHIT again" }), base);
  assert.equal(rude.status, "check");
  assert.match(rude.items.find((item) => /Explicit/.test(item.text)).text, /“Putang ina”, “shit”\./);
  assert.equal(g.releaseCheck(song({ madeAt: made("2026-08-31"), aiExplicit: true }), base).status, "check");
  assert.deepEqual(g.releaseExplicitWords("Shitake? no. Gagong araw, ulol!"), ["ulol"], "whole words only");
  const untimed = g.releaseCheck(song({ madeAt: made("2026-08-31") }), { planSince: PLAN, timed: false });
  assert.equal(untimed.status, "ready");
  assert.ok(untimed.items.some((item) => item.level === "note" && /aren’t timed yet/.test(item.text)));
  const bare = g.releaseCheck(song({ madeAt: made("2026-08-31"), lyrics: "", audioURL: "u" }), base);
  assert.ok(bare.items.some((item) => /No lyric sheet/.test(item.text)));
  const instrumental = g.releaseCheck(song({ madeAt: made("2026-08-31"), lyrics: "", audioURL: "u", aiVocalStyle: "Instrumental" }), base);
  assert.ok(!instrumental.items.some((item) => /lyric/i.test(item.text)));
  const drafted = g.releaseCheck(song({ madeAt: made("2026-08-31") }), Object.assign({ fromDraft: true }, base));
  assert.ok(drafted.items.some((item) => /Song lab draft, written with Claude/.test(item.text)));
});

test("the worst finding sets the status, and comes first", () => {
  const check = g.releaseCheck(song({ madeAt: made("2026-03-14"), duration: 20, lyrics: "[Verse]\nfuck" }), { planSince: PLAN });
  assert.equal(check.status, "blocked");
  assert.deepEqual(levels(check), levels(check).slice().sort((a, b) => g.RELEASE_LEVELS.indexOf(a) - g.RELEASE_LEVELS.indexOf(b)));
  assert.equal(check.items[0].level, "block");
});

test("each song is checked once, as its main take, and never a second copy of a file", () => {
  const list = [
    { id: "t-100", title: "Still In (1)", lyrics: SHEET("still"), audioURL: "a", fileSize: 1, duration: 200, plays: 1 },
    { id: "t-200", title: "Still In (2)", lyrics: SHEET("still"), audioURL: "b", fileSize: 2, duration: 210, plays: 0, versionPick: true },
    { id: "t-300", title: "Pauwi", lyrics: SHEET("pauwi"), audioURL: "c", fileSize: 3, duration: 180, plays: 4 },
    { id: "t-400", title: "Pauwi copy", lyrics: "", audioURL: "c", fileSize: 3, duration: 180, plays: 0 }
  ];
  assert.deepEqual(g.releaseCandidates(list).map((t) => t.id), ["t-200", "t-300"]);
});

test("songs whose release titles match", () => {
  const clashes = g.releaseTitleClashes([
    { id: "a", title: "Still In (1)" },
    { id: "b", title: "still in" },
    { id: "c", title: "Pauwi" }
  ]);
  assert.deepEqual(Object.keys(clashes).sort(), ["a", "b"]);
  assert.deepEqual(clashes.a.map((t) => t.id), ["b"]);
});
