"use strict";
// Home's moments: songs made on this day a while back, and a mix for the
// time of day.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const song = (id, created, extra) => ({ id, title: id, created, audioURL: "a.mp3", ...extra });

test("a year back wins over months back; the furthest month first", () => {
  const now = new Date(2027, 9, 5, 12);
  const list = [song("y1", "2026-10-05"), song("m3", "2027-07-05"), song("m1", "2027-09-05"), song("other", "2027-09-04")];
  const hit = g.onThisDay(list, now);
  assert.equal(hit.label, "A year ago today");
  assert.deepEqual(hit.tracks.map((t) => t.id), ["y1"]);
  const months = g.onThisDay(list.slice(1), now);
  assert.equal(months.label, "3 months ago today");
  assert.equal(g.onThisDay([song("today", "2027-10-05"), song("x", "2027-10-04")], now), null);
});

test("the date comes from the id when there is no created date", () => {
  const made = new Date(2026, 8, 5, 20).getTime();
  assert.equal(g.madeOnDay({ id: "t-" + made }), "2026-09-05");
  assert.equal(g.onThisDay([{ id: "t-" + made, audioURL: "a" }], new Date(2026, 9, 5, 9)).label, "A month ago today");
});

test("the mix fits the hour and changes order by day, one take each", () => {
  const LY = "[Verse]\nCounted out the quiet years like chips across the felt\nMy brother bet the farm on a pair of sevens once";
  const list = [
    song("chill1", "2026-01-01", { mood: "Chill", aiEnergy: "Low" }),
    song("dreamy", "2026-01-01", { mood: "Dreamy" }),
    song("dark", "2026-01-01", { mood: "Dark", aiEnergy: "Low" }),
    song("loud", "2026-01-01", { mood: "Energetic", aiEnergy: "High" }),
    song("take1", "2026-01-01", { mood: "Melancholic", lyrics: LY }),
    song("take2", "2026-01-01", { mood: "Melancholic", lyrics: LY })
  ];
  const night = g.timeOfDayMix(list, new Date(2026, 9, 5, 23, 30));
  assert.equal(night.name, "Late night mix");
  assert.ok(!night.ids.includes("loud"));
  assert.equal(night.ids.filter((id) => id.startsWith("take")).length, 1, "one take of a song");
  assert.equal(g.dayPartAt(2).id, "night");
  assert.equal(g.dayPartAt(7).id, "morning");
  assert.equal(g.timeOfDayMix(list, new Date(2026, 9, 5, 8)), null, "too few fit the morning");
});
