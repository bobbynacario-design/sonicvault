"use strict";
// Release covers: what the picture shows, and how the title is set.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

// A stand-in for measureText: every character half the font size wide.
const measure = (text, size) => text.length * size * 0.5;

test("the picture starts as a scene of the title, and of its theme when known", () => {
  assert.equal(g.releaseCoverScene({ title: "Still In (2)" }), "A scene of still in");
  assert.equal(g.releaseCoverScene({ title: "Pauwi", aiTheme: "Homecoming" }), "A scene of pauwi, about homecoming");
  assert.equal(g.releaseCoverScene({ title: "", aiTheme: "Rain" }), "A scene about rain");
  assert.equal(g.releaseCoverScene({}), "");
});

test("its colours come from the Suno style, else the song's genre, mood, theme and tags", () => {
  assert.equal(g.releaseCoverStyle({ prompt: "  acoustic folk,\n mandolin  " }), "acoustic folk, mandolin");
  assert.equal(g.releaseCoverStyle({ genre: "Folk", mood: "Warm", aiTheme: "home", aiTags: ["dusk", "road"] }), "Folk, Warm, home, dusk, road");
  assert.equal(g.releaseCoverStyle({ genre: "Other", mood: "Chill" }), "Chill", "the placeholder genre is left out");
});

test("a short title is set large on one line", () => {
  const fit = g.fitCoverTitle("Pauwi", measure, { maxWidth: 2580, maxSize: 330, minSize: 150 });
  assert.deepEqual(fit, { size: 330, lines: ["Pauwi"] });
});

test("a title that fits two lines keeps its size; a longer one shrinks until it does", () => {
  assert.deepEqual(g.fitCoverTitle("Mama Holds the Phone Too Low", measure, { maxWidth: 2580, maxSize: 330, minSize: 150 }),
    { size: 330, lines: ["Mama Holds the", "Phone Too Low"] });
  const title = "Turns Out You Were the Weather I Lived In";
  const fit = g.fitCoverTitle(title, measure, { maxWidth: 2580, maxSize: 330, minSize: 150 });
  assert.equal(fit.lines.length, 2);
  assert.ok(fit.size < 330 && fit.size >= 150);
  fit.lines.forEach((line) => assert.ok(measure(line, fit.size) <= 2580, line));
  assert.equal(fit.lines.join(" "), title);
});

test("past the smallest size, the words wrap as they must", () => {
  const long = "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen";
  const fit = g.fitCoverTitle(long, measure, { maxWidth: 2580, maxSize: 330, minSize: 150 });
  assert.equal(fit.size, 150);
  assert.ok(fit.lines.length > 2);
  assert.deepEqual(g.fitCoverTitle("  ", measure, { maxWidth: 100, maxSize: 30, minSize: 10 }), { size: 0, lines: [] });
});

test("the file is named after the title, without characters Windows refuses", () => {
  assert.equal(g.coverFileName("Pauwi"), "Pauwi - cover.jpg");
  assert.equal(g.coverFileName('What? "Now": a/b'), "What Now ab - cover.jpg");
  assert.equal(g.coverFileName(""), "cover.jpg");
});

test("a picture of any shape is cut to the square from its middle", () => {
  assert.deepEqual(g.coverSquareCrop(1536, 1536), { sx: 0, sy: 0, side: 1536 });
  assert.deepEqual(g.coverSquareCrop(1920, 1080), { sx: 420, sy: 0, side: 1080 });
  assert.deepEqual(g.coverSquareCrop(1000, 1500), { sx: 0, sy: 250, side: 1000 });
  assert.deepEqual(g.coverSquareCrop(undefined, 10), { sx: 0, sy: 5, side: 0 });
});

test("a picture of your own says how it will look at full size", () => {
  assert.match(g.ownCoverNote(3000, 3000, 3000), /3,000 × 3,000\. That’s big enough to stay sharp/);
  assert.match(g.ownCoverNote(1536, 1536, 3000), /it will look a little soft/);
  assert.match(g.ownCoverNote(360, 360, 3000), /it will look blurry/, "a Suno file's own picture");
  assert.match(g.ownCoverNote(4000, 3000, 3000), /Its middle is used, cut to a square\. That’s big enough/);
});

test("the words go at the bottom or the top", () => {
  assert.deepEqual(g.COVER_PLACES.map((p) => p.id), ["bottom", "top"]);
});

test("a band's light is the mean of its pixels' light", () => {
  assert.equal(Math.round(g.coverLuminance([255, 255, 255, 255, 0, 0, 0, 255]) * 10) / 10, 127.5);
  assert.equal(Math.round(g.coverLuminance([250, 240, 220, 255])), 241, "a pale watercolour sky");
  assert.equal(g.coverLuminance([]), 0);
});

test("words take dark ink on a bright picture, white on a dark one", () => {
  assert.equal(g.coverInk(240).title, "#18202c");
  assert.match(g.coverInk(240).shade, /^rgba\(255,255,255,/, "a light veil, not a dark band");
  assert.equal(g.coverInk(60).title, "#ffffff");
  assert.match(g.coverInk(60).shade, /^rgba\(0,0,0,/);
  assert.equal(g.coverInk(g.COVER_BRIGHT).title, "#18202c");
});
