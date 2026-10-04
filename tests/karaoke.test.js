"use strict";
// Karaoke: when each written word was sung, and lines as words that light
// up in turn.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const plain = (words) => words.map((w) => [w.text, w.start, w.end]);

test("aligning a song also says when each written word was heard", () => {
  const heard = [["hello", 1, 1.4], ["world", 1.5, 2], ["goodbye", 3, 3.5], ["moon", 3.6, 4]];
  const aligned = g.alignLyricsToWords("[Verse]\nHello world\nGoodbye, moon", heard);
  assert.deepEqual(aligned.words, [1, 1.5, 3, 3.6]);
  const partly = g.alignLyricsToWords("Hello there world", [["hello", 1, 1.4], ["world", 2, 2.4]]);
  assert.deepEqual(partly.words, [1, null, 2]);
  assert.deepEqual(g.alignLyricsToWords("Hello", []).words, [null]);
});

test("word times are stored flat, rounded, and survive the cloud-safe copy", () => {
  const packed = g.packLyricSync("One two", [[1, 2]], "audio", "now", ["one two"], [1.234, null, "x"]);
  assert.deepEqual(packed.words, [1.23, null, null]);
  assert.equal(g.packLyricSync("One two", [[1, 2]], "audio", "now").words, undefined);
  const old = { key: "k", lines: [[1, 2]], source: "audio", at: "now", words: [1, 1.5] };
  assert.deepEqual(g.cloudSafeLyricSync(old).words, [1, 1.5]);
});

test("each line's words start at a known place in the flat list", () => {
  assert.deepEqual(g.lyricWordOffsets("[Verse]\nOne two\n\nThree\nFour-five six"), { offsets: [0, 2, 3], total: 6 });
});

test("words light up at the moments they were heard", () => {
  const words = g.karaokeWords("Still in, still in", [10, 14], [10, 10.5, 12, 12.5]);
  assert.deepEqual(plain(words), [["Still", 10, 10.5], ["in,", 10.5, 12], ["still", 12, 12.5], ["in", 12.5, 14]]);
  assert.deepEqual(words.map((w) => w.space), [" ", " ", " ", ""]);
});

test("unheard words are spread by length between the heard ones", () => {
  // No times at all: across the line, a longer word taking longer.
  assert.deepEqual(plain(g.karaokeWords("aa bbbb", [0, 8])), [["aa", 0, 3], ["bbbb", 3, 8]]);
  // A gap in the middle fills between its neighbours.
  assert.deepEqual(plain(g.karaokeWords("one two three", [0, 6], [0, null, 4])), [["one", 0, 2], ["two", 2, 4], ["three", 4, 6]]);
});

test("times that no longer fit the line are dropped, not trusted", () => {
  // The line was re-timed by hand to start at 20; the heard times are from before.
  assert.deepEqual(plain(g.karaokeWords("aa bbbb", [20, 28], [11, 12])), [["aa", 20, 23], ["bbbb", 23, 28]]);
  // A time past the end of the line is dropped; the word fills in around it.
  assert.deepEqual(plain(g.karaokeWords("one two three", [0, 6], [0, 7, 4])), [["one", 0, 2], ["two", 2, 4], ["three", 4, 6]]);
});

test("written words map onto sheet words however they are punctuated", () => {
  const words = g.karaokeWords("Forty-seven years — gone", [1, 5], [1, 1.4, 2, 3]);
  assert.deepEqual(plain(words), [["Forty-seven", 1, 2], ["years —", 2, 3], ["gone", 3, 5]]);
  assert.deepEqual(plain(g.karaokeWords("— hey", [2, 3], [2.2])), [["—", 2.2, 2.2], ["hey", 2.2, 3]]);
  assert.deepEqual(g.karaokeWords("", [0, 1]), []);
});

test("a time earlier than the word before it is dropped", () => {
  // 5 then 4: the first stands, and the third word fills after it.
  assert.deepEqual(plain(g.karaokeWords("one two three", [0, 6], [0, 5, 4])), [["one", 0, 5], ["two", 5, 5.4], ["three", 5.4, 6]]);
});
