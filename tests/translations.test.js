"use strict";
// Saved translations, one per language, and the one a share page shows.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const entry = (key, at, lines) => ({ key, from: "Bikol", same: false, lines: lines || ["a"], about: "x", notes: [], at });

test("every language kept, and the old single translation counted as one", () => {
  const track = {
    translations: { Filipino: entry("k1", "2026-10-05T02:00:00Z") },
    translation: Object.assign(entry("k1", "2026-10-04T00:00:00Z"), { lang: "English" })
  };
  const all = g.savedTranslations(track);
  assert.deepEqual(Object.keys(all).sort(), ["English", "Filipino"]);
  assert.equal(all.English.lang, "English");
  assert.deepEqual(g.savedTranslations({}), {});
});

test("saving one keeps the others, folds in the old one, and lets go of stale lyrics", () => {
  const track = {
    translations: { Spanish: entry("old-lyrics", "2026-10-01T00:00:00Z") },
    translation: Object.assign(entry("k1", "2026-10-04T00:00:00Z"), { lang: "English" })
  };
  const map = g.withTranslation(track, "Filipino", entry("k1", "2026-10-05T00:00:00Z", ["isa"]), "k1");
  assert.deepEqual(Object.keys(map).sort(), ["English", "Filipino"]);
  assert.deepEqual(map.Filipino.lines, ["isa"]);
  assert.equal(map.English.lang, undefined, "the language is the map key, not a field");
  // Saving a language again replaces it.
  const again = g.withTranslation({ translations: map }, "Filipino", entry("k1", "2026-10-06T00:00:00Z", ["dalawa"]), "k1");
  assert.deepEqual(again.Filipino.lines, ["dalawa"]);
});

test("a share page shows English when there is one, else the newest", () => {
  const both = { translations: { Filipino: entry("k1", "2026-10-06T00:00:00Z"), English: entry("k1", "2026-10-01T00:00:00Z") } };
  assert.equal(g.publicTranslationOf(both, "k1").lang, "English");
  const two = { translations: { Filipino: entry("k1", "2026-10-06T00:00:00Z"), Spanish: entry("k1", "2026-10-02T00:00:00Z") } };
  assert.equal(g.publicTranslationOf(two, "k1").lang, "Filipino");
  assert.equal(g.publicTranslationOf(two, "other"), null);
});
