"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const SHEET = [
  "[Verse 1]",
  "Looking at the board, counting up the outs",
  "Clearing up the mind, silencing the doubts",
  "",
  "(Chorus)",
  "It's not about the luck, it's about the math",
  "Trusting in the fractions, walking down the path.",
  "(oh-oh)",
].join("\n");

// Heard words as the worker sends them, one second per word from `from`.
function said(text, from) {
  return g.lyricWordsOf(text).map((w, i) => [w, from + i, from + i + 0.8]);
}

// Firestore rejects a document holding an array directly inside an array.
function hasNestedArray(value, insideArray) {
  if (Array.isArray(value)) return insideArray || value.some((v) => hasNestedArray(v, true));
  if (value && typeof value === "object") return Object.values(value).some((v) => hasNestedArray(v, false));
  return false;
}

test("stored timings are flat arrays Firestore accepts, and unpack to the same lines", () => {
  const lines = [[20, 26.5], null, [50.24, 58]];
  const packed = g.packLyricSync(SHEET, lines, "audio", "2026-10-04T00:00:00Z");
  assert.equal(hasNestedArray(packed), false);
  assert.deepEqual(packed.starts, [20, null, 50.24]);
  assert.deepEqual(packed.ends, [26.5, null, 58]);
  assert.equal(packed.key, g.lyricSyncKey(SHEET));
  assert.deepEqual(g.unpackLyricLines(packed), lines);
});

test("timings saved by the first build are converted to the flat shape", () => {
  const legacy = { key: "v1:9", lines: [[20, 26.5], null, [50.24, 58]], source: "audio+fixed", at: "x" };
  assert.equal(hasNestedArray(legacy), true);
  const safe = g.cloudSafeLyricSync(legacy);
  assert.equal(hasNestedArray(safe), false);
  assert.deepEqual(safe, { key: "v1:9", starts: [20, null, 50.24], ends: [26.5, null, 58], source: "audio+fixed", at: "x" });
  assert.deepEqual(g.unpackLyricLines(legacy), g.unpackLyricLines(safe));
  // Already flat, or not a sync: untouched.
  assert.equal(g.cloudSafeLyricSync(safe), safe);
  assert.equal(g.cloudSafeLyricSync(undefined), undefined);
  // An unmatched result stores no lines at all.
  const none = g.packLyricSync(SHEET, [], "unmatched", "x");
  assert.deepEqual([none.starts, none.ends], [[], []]);
});

test("the sheet splits into labels, gaps and numbered sung lines", () => {
  const rows = g.parseLyricSheet(SHEET);
  assert.deepEqual(rows.map((r) => r.kind), ["header", "line", "line", "gap", "header", "line", "line", "line"]);
  assert.deepEqual(rows.filter((r) => r.kind === "line").map((r) => r.index), [0, 1, 2, 3, 4]);
  // An ad-lib in parentheses is sung, not a section label.
  assert.equal(g.isLyricSectionHeader("(oh-oh)"), false);
  assert.equal(g.isLyricSectionHeader("(Pre-Chorus 2)"), true);
  assert.equal(g.isLyricSectionHeader("[Outro - sparse, organ and voice only]"), true);
});

test("the sync key changes when the sung words change, not when labels are retouched", () => {
  const key = g.lyricSyncKey(SHEET);
  assert.equal(g.lyricSyncKey(SHEET.replace("[Verse 1]", "[Verse]")), key);
  assert.notEqual(g.lyricSyncKey(SHEET.replace("board", "table")), key);
});

test("words compare without case, accents, or apostrophes", () => {
  assert.deepEqual(g.lyricWordsOf("It’s NOT, about—the Lúck!"), ["its", "not", "about", "the", "luck"]);
});

test("each line takes the time its words were heard, after an instrumental intro", () => {
  // 20s intro the recogniser fills with a stray word, then every line sung.
  const heard = [["music", 3, 4]]
    .concat(said("Looking at the board, counting up the outs", 20))
    .concat(said("Clearing up the mind, silencing the doubts", 30))
    .concat(said("It's not about the luck, it's about the math", 50))
    .concat(said("Trusting in the fractions, walking down the path", 62))
    .concat(said("oh oh", 72));
  const { lines, matched } = g.alignLyricsToWords(SHEET, heard);
  assert.deepEqual(lines.map((l) => l[0]), [20, 30, 50, 62, 72]);
  assert.equal(matched, 1);
});

test("misheard words and a line the recogniser missed still land in order", () => {
  const heard = []
    .concat(said("looking at the bored counting up the out", 20))   // bent words
    .concat(said("its not about the luck its about the maths", 50))  // line 2 missing entirely
    .concat(said("trusting in the fraction walking down the path", 62));
  const { lines, matched } = g.alignLyricsToWords(SHEET, heard);
  assert.equal(lines[0][0], 20);
  assert.equal(lines[1], null);
  assert.equal(lines[2][0], 50);
  assert.equal(lines[3][0], 62);
  assert.ok(matched > 0.6 && matched < 1, String(matched));
});

test("a repeated chorus maps onto its own repeat, not the first one", () => {
  const sheet = "[Chorus]\nStill in, still holding\n[Verse]\nManila in the evening\n[Chorus]\nStill in, still holding";
  const heard = said("still in still holding", 10).concat(said("manila in the evening", 40)).concat(said("still in still holding", 80));
  const { lines } = g.alignLyricsToWords(sheet, heard);
  assert.deepEqual(lines.map((l) => l[0]), [10, 40, 80]);
});

test("nothing heard means nothing timed", () => {
  const { lines, matched } = g.alignLyricsToWords(SHEET, []);
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l === null));
  assert.equal(matched, 0);
});

test("resolveLyricTimes fills untimed lines between their neighbours, in order", () => {
  const times = g.resolveLyricTimes([[20, 27], null, [50, 58], null, [72, 74]], 120);
  assert.equal(times.length, 5);
  assert.equal(times[0][0], 20);
  // An untimed line starts no earlier than its predecessor ends, before its successor.
  assert.ok(times[1][0] >= 27 && times[1][0] < 50, JSON.stringify(times[1]));
  assert.ok(times[3][0] >= 58 && times[3][0] < 72, JSON.stringify(times[3]));
  for (let i = 1; i < times.length; i++) assert.ok(times[i][0] >= times[i - 1][0]);
});

test("resolveLyricTimes drops a time that breaks the order, and estimates when nothing is timed", () => {
  const times = g.resolveLyricTimes([[20, 25], [10, 12], [40, 45]], 60);
  assert.ok(times[1][0] > 20 && times[1][0] < 40);
  const even = g.resolveLyricTimes([null, null, null, null], 100);
  assert.deepEqual(even.map((t) => t[0]), [0, 25, 50, 75]);
});

test("the current line follows the clock, and nothing is lit in the intro or a long break", () => {
  const times = [[20, 27], [30, 37], [80, 86]];
  assert.equal(g.currentLyricIndex(times, 5), -1);
  assert.equal(g.currentLyricIndex(times, 19.9), 0);   // lead: lit just before the voice
  assert.equal(g.currentLyricIndex(times, 33), 1);
  assert.equal(g.currentLyricIndex(times, 39), 1);     // a short pause keeps the line
  assert.equal(g.currentLyricIndex(times, 55), -1);    // instrumental break
  assert.equal(g.currentLyricIndex(times, 81), 2);
});

test("fixing a line moves it and clears neighbours it would now cross", () => {
  const fixed = g.fixLyricLine([[20, 27], [30, 37], [50, 58], [62, 70]], 1, 55);
  assert.deepEqual(fixed[0], [20, 27]);
  assert.deepEqual(fixed[1], [55, 62]);
  assert.equal(fixed[2], null);          // was before 55, now out of order
  assert.deepEqual(fixed[3], [62, 70]);
  // A hand-made sync starts from nothing.
  assert.deepEqual(g.fixLyricLine([null, null, null], 0, 12.345), [[12.35, 15.35], null, null]);
});

test("a line whose first words went unheard starts a little before its first match", () => {
  const sheet = "Sun beats down on the street\nThirty-four degrees and climbing";
  const heard = said("sun beats down on the street", 10).concat([["34", 17.2, 17.9]]).concat(said("degrees and climbing", 18));
  const { lines } = g.alignLyricsToWords(sheet, heard);
  // "thirty" and "four" unmatched: two words, .4s each, earlier than "degrees".
  assert.equal(lines[1][0], 17.2);
  // but not before the previous line's last word ended
  const tight = g.alignLyricsToWords(sheet, said("sun beats down on the street", 10).concat(said("degrees and climbing", 15.9)));
  assert.equal(tight.lines[1][0], 15.8);
});

test("resolved start times never run backwards, whatever the spans", () => {
  // A correction can leave a line whose end runs past the next timed line;
  // filling the lines between must still move forwards.
  const fixedOverlap = g.resolveLyricTimes([[20, 26], [100.23, 105.9], null, null, null, [103, 108], [115, 120]], 200);
  for (let i = 1; i < fixedOverlap.length; i++) assert.ok(fixedOverlap[i][0] >= fixedOverlap[i - 1][0], JSON.stringify(fixedOverlap));
  assert.ok(fixedOverlap[2][0] > 100.23 && fixedOverlap[4][0] < 103);
  // Seeded pseudo-random spans: monotonic every time.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 2000; k++) {
    const n = 3 + Math.floor(rand() * 12);
    const spans = [];
    let clock = 0;
    for (let i = 0; i < n; i++) {
      if (rand() < 0.35) { spans.push(null); continue; }
      clock += rand() * 12 - 2;
      const s = Math.max(0, clock);
      spans.push([s, s + rand() * 9]);
    }
    const r = g.resolveLyricTimes(spans, rand() < 0.5 ? 0 : clock + 30);
    assert.equal(r.length, n);
    for (let i = 1; i < r.length; i++) assert.ok(r[i][0] >= r[i - 1][0] - 1e-9, "case " + k + ": " + JSON.stringify(spans));
  }
});

test("a share excerpt that lost its line breaks gets its sections back", () => {
  const flat = "[Intro] (Soft, rhythmic acoustic guitar picking, very calm) Breathe in. Run the numbers. [Verse 1] Looking at the board, counting up the outs Clearing up the mind, silencing the doubts [Chorus] Positive EV is the only guide";
  assert.equal(g.isFlattenedLyrics(flat), true);
  assert.equal(g.unflattenLyrics(flat),
    "[Intro]\n(Soft, rhythmic acoustic guitar picking, very calm) Breathe in. Run the numbers.\n\n[Verse 1]\nLooking at the board, counting up the outs Clearing up the mind, silencing the doubts\n\n[Chorus]\nPositive EV is the only guide");
  // Real sheets come in lines, and short lines are just short.
  assert.equal(g.isFlattenedLyrics("[Verse]\nOne line\nTwo line"), false);
  assert.equal(g.isFlattenedLyrics("Breathe in."), false);
  assert.equal(g.unflattenLyrics("[Verse]\nOne line"), "[Verse]\nOne line");
});

test("what was heard on each line comes back with the timings", () => {
  const sheet = "[Verse]\nCounted out the quiet years like chips across the felt\nSome I played too careful";
  const heard = [
    ["counted", 1, 1.4], ["out", 1.4, 1.6], ["the", 1.6, 1.7], ["quiet", 1.7, 2], ["years", 2, 2.3],
    ["like", 2.3, 2.5], ["ships", 2.5, 2.8], ["across", 2.8, 3.1], ["the", 3.1, 3.2], ["felt", 3.2, 3.6],
    ["la", 4, 4.2], ["la", 4.2, 4.4],
    ["some", 5, 5.2], ["i", 5.2, 5.3], ["played", 5.3, 5.6], ["to", 5.6, 5.7], ["careful", 5.7, 6.2]
  ];
  const aligned = g.alignLyricsToWords(sheet, heard);
  assert.deepEqual(aligned.heard, ["counted out the quiet years like ships across the felt", "some i played to careful"]);
  // The "la la" between the lines belongs to neither.
  const packed = g.packLyricSync(sheet, aligned.lines, "audio", "t", aligned.heard);
  assert.deepEqual(packed.heard, aligned.heard);
  assert.deepEqual(g.cloudSafeLyricSync(packed), packed);
});

test("a line sung differently is flagged word by word; small words and unheard lines are not", () => {
  const changed = g.compareSungLine("Counted out the quiet years like chips across the felt", "counted out the quiet years like ships across the felt");
  assert.equal(changed.differs, true);
  const chips = changed.tokens.find((t) => t.text === "chips");
  assert.deepEqual(chips, { text: "chips", status: "changed", heard: "ships" });
  assert.ok(changed.tokens.filter((t) => t.status !== "ok").length === 1);

  // "too" sung as "to" is close enough; a dropped "I" is too small to count.
  const fine = g.compareSungLine("Some I played too careful", "some played to careful");
  assert.equal(fine.differs, false);

  const missing = g.compareSungLine("Forty-seven candles and I'm not done", "forty seven and i m not done");
  assert.equal(missing.differs, true);
  assert.equal(missing.tokens.find((t) => t.text === "candles").status, "missing");

  const extra = g.compareSungLine("Deal me one more night", "deal me one more lonely night");
  assert.equal(extra.differs, false, "an added word is shown, not counted against the sheet");
  assert.equal(extra.heard.find((h) => h.text === "lonely").status, "extra");

  const unheard = g.compareSungLine("Still in, still holding", "");
  assert.equal(unheard.unheard, true);
  assert.equal(unheard.differs, false);
});

test("a sheet's check counts lines sung as written, sung differently, and not heard", () => {
  const sheet = "[Verse]\nCounted out the quiet years like chips across the felt\nSome I played too careful\n[Chorus]\nStill in, still holding";
  const check = g.checkSungLyrics(sheet, ["counted out the quiet years like ships across the felt", "some i played to careful", ""]);
  assert.deepEqual([check.total, check.asWritten, check.differ, check.unheard], [3, 1, 1, 1]);
  assert.equal(check.lines[0].text, "Counted out the quiet years like chips across the felt");
});
