"use strict";
// Synced lyrics files (LRC): timestamps per line, and per word.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const LYRICS = "[Verse]\nHello world\nGoodbye moon\n\n[Chorus]\nStill in, still in";

test("timestamps are minutes, seconds and hundredths", () => {
  assert.equal(g.lrcTime(0), "00:00.00");
  assert.equal(g.lrcTime(61.234), "01:01.23");
  assert.equal(g.lrcTime(9.999), "00:10.00");
  assert.equal(g.lrcTime(-3), "00:00.00");
});

test("a line-by-line file: header, one timestamp per sung line, a blank at breaks and the end", () => {
  const lrc = g.buildLRC({ title: "Song [1]", duration: 185 }, LYRICS, [[1, 2.5], [3, 4.5], [10, 14]], null, false);
  assert.equal(lrc, [
    "[ti:Song 1]",
    "[length:03:05]",
    "[by:SonicVault]",
    "[00:01.00]Hello world",
    "[00:03.00]Goodbye moon",
    "[00:04.50]",
    "[00:10.00]Still in, still in",
    "[00:14.00]",
    ""
  ].join("\n"));
});

test("the word-by-word file puts a timestamp before each word and one at the end", () => {
  const lrc = g.buildLRC({}, LYRICS, [[1, 2.5], [3, 4.5], [10, 14]], [1, 1.6, 3, 3.8, 10, 10.5, 12, 12.5], true);
  const lines = lrc.trim().split("\n");
  assert.equal(lines[0], "[by:SonicVault]");
  assert.equal(lines[1], "[00:01.00]<00:01.00>Hello <00:01.60>world <00:02.50>");
  assert.equal(lines[4], "[00:10.00]<00:10.00>Still <00:10.50>in, <00:12.00>still <00:12.50>in <00:14.00>");
});

test("untimed lines are left out, and names are safe for any file system", () => {
  const lrc = g.buildLRC({ title: "x" }, LYRICS, [[1, 2], null, [10, 12]], null, false);
  assert.ok(!lrc.includes("Goodbye"));
  assert.equal(g.lrcFileName('AC/DC: "Live"?', false), "ACDC Live.lrc");
  assert.equal(g.lrcFileName("Still In", true), "Still In (word by word).lrc");
  assert.equal(g.lrcFileName("", false), "Song.lrc");
});
