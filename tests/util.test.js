"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("esc and attr neutralise markup for text and attribute contexts", () => {
  assert.equal(g.esc("<b>Tom & Jerry</b>"), "&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
  assert.equal(g.attr('say "hi" <x>'), "say &quot;hi&quot; &lt;x>");
  assert.equal(g.esc(null), "");
  assert.equal(g.attr(0), "0");
});

test("jsq and jsv survive an onclick attribute as JS literals", () => {
  // Inline handlers are built as onclick="playTrack(' + jsq(id) + ')". After
  // the browser decodes the attribute, the argument must be the original value.
  const decode = (s) => s.replace(/&quot;/g, '"');
  for (const value of ["plain", `it's "quoted"`, "</script>", "back\\slash"]) {
    assert.doesNotMatch(g.jsq(value), /"/);
    assert.equal(JSON.parse(decode(g.jsq(value))), value);
  }
  assert.deepEqual(JSON.parse(decode(g.jsv(["t-1", "t-2"]))), ["t-1", "t-2"]);
  assert.equal(JSON.parse(decode(g.jsv(null))), "");
});

test("fmtTime reads as m:ss and fmtLongDuration as hours and minutes", () => {
  assert.equal(g.fmtTime(0), "0:00");
  assert.equal(g.fmtTime(undefined), "0:00");
  assert.equal(g.fmtTime(65.9), "1:05");
  assert.equal(g.fmtTime(3600), "60:00");
  assert.equal(g.fmtLongDuration(59), "59s");
  assert.equal(g.fmtLongDuration(60), "1m");
  assert.equal(g.fmtLongDuration(3725), "1h 2m");
});

test("fmtCompactNumber and formatFileSize shorten large values", () => {
  assert.equal(g.fmtCompactNumber(999), "999");
  assert.equal(g.fmtCompactNumber(1000), "1K");
  assert.equal(g.fmtCompactNumber(1500), "1.5K");
  assert.equal(g.fmtCompactNumber(1500000), "1.5M");
  assert.equal(g.formatFileSize(0), "0 MB");
  assert.equal(g.formatFileSize(2048), "2 KB");
  assert.equal(g.formatFileSize(3 * 1024 * 1024), "3.0 MB");
});

test("trimText ellipsises only past the limit", () => {
  assert.equal(g.trimText("hello world", 6), "hello…");
  assert.equal(g.trimText("  hi  ", 10), "hi");
  assert.equal(g.trimText("", 5), "");
});

test("uniqueStrings dedupes case-insensitively and collapses whitespace", () => {
  assert.deepEqual(g.uniqueStrings([" Late  night ", "late night", "", null, "Neon"]), ["Late night", "Neon"]);
  assert.deepEqual(g.uniqueStrings(["a", "b", "c"], 2), ["a", "b"]);
});

test("hashString is stable and never negative", () => {
  assert.equal(g.hashString(""), 0);
  assert.equal(g.hashString("Neon Highway"), g.hashString("Neon Highway"));
  for (const s of ["a", "Neon Highway", "x".repeat(500)]) assert.ok(g.hashString(s) >= 0);
});
