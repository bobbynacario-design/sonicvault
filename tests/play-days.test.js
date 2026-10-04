"use strict";
// Days played: each play counted against its day, for a year in songs.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("days are the listener's own calendar days", () => {
  assert.equal(g.localDayKey(new Date(2026, 9, 5, 23, 59)), "2026-10-05");
  assert.equal(g.localDayKey(new Date(2027, 0, 1, 0, 1)), "2027-01-01");
  assert.equal(g.localDayKey("not a date"), "");
});

test("a play adds one to its day and leaves the rest", () => {
  const first = g.addPlayDay(undefined, new Date(2026, 9, 5, 9));
  assert.deepEqual(first, { "2026-10-05": 1 });
  const again = g.addPlayDay(first, new Date(2026, 9, 5, 21));
  assert.deepEqual(again, { "2026-10-05": 2 });
  assert.deepEqual(first, { "2026-10-05": 1 }, "the old map is left alone");
  assert.deepEqual(g.addPlayDay(again, new Date(2026, 9, 6)), { "2026-10-05": 2, "2026-10-06": 1 });
  assert.deepEqual(g.addPlayDay(["junk"], new Date(2026, 9, 6)), { "2026-10-06": 1 });
});
