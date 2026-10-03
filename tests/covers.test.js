"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const ids = () => g.COVER_STYLES.map((s) => s.id);

test("a track's chosen cover style wins; otherwise it is derived and stable", () => {
  assert.equal(g.getCoverStyle({ title: "X", coverStyle: "vinyl" }), "vinyl");
  const track = { title: "Neon Highway", genre: "Synthwave", mood: "Energetic", coverStyle: "nonsense" };
  const style = g.getCoverStyle(track);
  assert.ok(ids().includes(style));
  assert.equal(g.getCoverStyle({ ...track }), style);
});

test("normalizeCoverStyle accepts any casing and falls back to the derived style", () => {
  assert.equal(g.normalizeCoverStyle(" VINYL "), "vinyl");
  const track = { title: "Glass Cathedral" };
  assert.equal(g.normalizeCoverStyle("not-a-style", track), g.getCoverStyle(track));
});

test("inferCoverStyle reads the cover from the words of the track", () => {
  assert.equal(g.inferCoverStyle({ prompt: "dusty soul, warm analog keys" }, {}), "vinyl");
  assert.equal(g.inferCoverStyle({ prompt: "club drop, 808 kick" }, {}), "pulse");
  assert.equal(g.inferCoverStyle({ title: "x" }, { aiTags: ["cassette", "bedroom"] }), "tape");
});

test("getNextCoverStyle cycles through every style and wraps", () => {
  const all = ids();
  assert.equal(g.getNextCoverStyle(all[all.length - 1]), all[0]);
  assert.equal(g.getNextCoverStyle(all[0]), all[1]);
  assert.equal(g.getNextCoverStyle("unknown"), all[0]);
});

test("playlist colours outside the whitelist fall back to the default", () => {
  // The colour lands in an inline style attribute, so it must never be free text.
  assert.equal(g.safePlaylistColor("#78d0a4"), "#78d0a4");
  assert.equal(g.safePlaylistColor("red"), g.PLAYLIST_COLOR_DEFAULT);
  assert.equal(g.safePlaylistColor("#123456"), g.PLAYLIST_COLOR_DEFAULT);
  assert.equal(g.safePlaylistColor(undefined), g.PLAYLIST_COLOR_DEFAULT);
  assert.match(g.playlistAccentVars({ color: "x;background:url(evil)" }), /^--pl-accent:#F08B62;/);
});

test("monograms and palettes are derived deterministically", () => {
  assert.equal(g.getTrackMonogram("neon highways"), "NH");
  assert.equal(g.getTrackMonogram("solo"), "SO");
  assert.equal(g.getTrackMonogram(""), "SV");
  const track = { title: "Paper Lanterns", genre: "Chiptune", mood: "Energetic", source: "Original" };
  assert.deepEqual(g.getTrackPalette(track), g.getTrackPalette({ ...track }));
  const { angle } = g.getTrackPalette(track);
  assert.ok(angle >= 18 && angle < 168);
});
