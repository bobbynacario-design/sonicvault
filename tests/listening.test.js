"use strict";
// Listening smarts: skips, songs on repeat, winning takes and the week in songs.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const NOW = new Date(2026, 9, 10, 12);
const SHEET = (word) => "[Verse 1]\n" + Array.from({ length: 6 }, (_, i) => word + " line number " + i + " of the song").join("\n");

test("day maps are counted over the last days, today included", () => {
  const map = { "2026-10-10": 1, "2026-10-04": 2, "2026-10-03": 4, "2026-09-27": 8, "2026-09-26": 16 };
  assert.equal(g.countSince(map, NOW, 7), 3);
  assert.equal(g.countSince(map, NOW, 14), 15);
  assert.equal(g.countBetween(map, NOW, 14, 7), 12, "the week before last");
  assert.equal(g.countSince(undefined, NOW, 7), 0);
  assert.equal(g.countSince(["junk"], NOW, 7), 0);
});

test("leaving a song in its first 30 seconds is a skip; its end, or a short clip, is not", () => {
  assert.equal(g.isSkip(12, 180, false), true);
  assert.equal(g.isSkip(0, 180, false), true);
  assert.equal(g.isSkip(30, 180, false), false);
  assert.equal(g.isSkip(12, 180, true), false, "it ended");
  assert.equal(g.isSkip(12, 40, false), false, "a 40-second clip");
  assert.equal(g.isSkip(12, NaN, false), false, "length unknown");
});

test("a song is kept out of mixes after three skips that are most of its plays lately", () => {
  const days = (n) => ({ "2026-10-08": n });
  assert.equal(g.oftenSkipped({ skipDays: days(3), playDays: days(4) }, NOW), true);
  assert.equal(g.oftenSkipped({ skipDays: days(2), playDays: days(2) }, NOW), false, "only two skips");
  assert.equal(g.oftenSkipped({ skipDays: days(3), playDays: days(10) }, NOW), false, "mostly listened to");
  assert.equal(g.oftenSkipped({ skipDays: { "2026-07-01": 9 }, playDays: { "2026-07-01": 9 } }, NOW), false, "long ago");
  assert.equal(g.oftenSkipped({ skipDays: days(3) }, NOW), true, "plays from before days were kept");
  assert.equal(g.oftenSkipped({}, NOW), false);
});

test("on repeat: songs listened to twice or more this week, takes added together, the most played take shown", () => {
  const list = [
    { id: "t-1", title: "A", lyrics: SHEET("a"), playDays: { "2026-10-09": 1 } },
    { id: "t-2", title: "A (2)", lyrics: SHEET("a"), playDays: { "2026-10-08": 2 } },
    { id: "t-3", title: "B", lyrics: SHEET("b"), playDays: { "2026-10-10": 5 } },
    { id: "t-4", title: "C", lyrics: SHEET("c"), playDays: { "2026-10-10": 1, "2026-09-01": 40 } },
    { id: "t-5", title: "Skipped", lyrics: SHEET("d"), playDays: { "2026-10-10": 4 }, skipDays: { "2026-10-10": 4 } }
  ];
  const repeat = g.onRepeat(list, NOW, 8);
  assert.deepEqual(repeat.map((item) => [item.track.id, item.listens]), [["t-3", 5], ["t-2", 3]], "a song skipped every time isn't on repeat");
  assert.equal(g.onRepeat(list, NOW, 1).length, 1);
});

test("a take wins only by a clear margin of listens over the last 60 days", () => {
  const take = (id, plays, skips) => ({ id, playDays: { "2026-10-01": plays }, skipDays: skips ? { "2026-10-01": skips } : undefined });
  const clear = g.winningTake([take("a", 2), take("b", 9)], NOW);
  assert.equal(clear.take.id, "b");
  assert.equal(clear.plays, 9);
  assert.equal(clear.runnerUp.id, "a");
  assert.equal(clear.runnerUpPlays, 2);
  assert.equal(g.winningTake([take("a", 6), take("b", 8)], NOW), null, "too close");
  assert.equal(g.winningTake([take("a", 1), take("b", 3)], NOW), null, "too few plays to tell");
  assert.equal(g.winningTake([take("a", 9, 5), take("b", 4)], NOW).take.id, "b", "a take mostly skipped loses to one listened through");
  assert.equal(g.winningTake([take("a", 9)], NOW), null, "one take");
});

test("the week: plays, skips, listening time, days, the top songs and what was made", () => {
  const list = [
    { id: "t-1", title: "Old", created: "2026-08-01", duration: 200, playDays: { "2026-10-09": 3, "2026-10-01": 2 }, skipDays: { "2026-10-09": 1 } },
    { id: "t-2", title: "New", created: "2026-10-08", duration: 100, playDays: { "2026-10-10": 1 } },
    { id: "t-3", title: "Quiet", created: "2026-07-01", duration: 300 }
  ];
  const week = g.weekRecap(list, NOW);
  assert.equal(week.plays, 4);
  assert.equal(week.playsBefore, 2);
  assert.equal(week.skips, 1);
  assert.equal(week.seconds, 2 * 200 + 15 + 100);
  assert.equal(week.daysListened, 2);
  assert.deepEqual(week.top.map((item) => [item.track.title, item.listens]), [["Old", 2], ["New", 1]], "a skip isn't a listen");
  assert.deepEqual(week.made.map((t) => t.title), ["New"]);
});
