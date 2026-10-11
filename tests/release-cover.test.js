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
