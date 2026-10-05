"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("newest-first sorts by date, and same-day imports by their id epoch", () => {
  // `created` is date-only. Per-track documents arrive in id order, so without
  // the id tiebreak a day's imports would flip to oldest-first.
  const list = [
    { id: "t-1000", created: "2026-01-03" },
    { id: "t-3000", created: "2026-01-03" },
    { id: "t-2000", created: "2026-02-01" },
    { id: "t-9000" },
  ];
  assert.deepEqual(list.slice().sort(g.compareNewestFirst).map((t) => t.id), ["t-2000", "t-3000", "t-1000", "t-9000"]);
});

test("track and playlist ids carry their creation epoch", () => {
  assert.equal(g.trackIdTimestamp({ id: "t-1740000000000" }), 1740000000000);
  assert.equal(g.trackIdTimestamp({ id: "demo-cover-1" }), 0);
  assert.equal(g.playlistTimestamp({ id: "pl-123" }), 123);
  assert.equal(g.playlistTimestamp(null), 0);
});

test("trackFingerprint ignores key order, audioData and undefined fields", () => {
  // The sync diffs the live array against server-confirmed fingerprints. If key
  // order mattered, every track fetched from Firestore would look dirty.
  const a = { id: "t-1", title: "A", plays: 2 };
  const b = { plays: 2, title: "A", id: "t-1", audioData: "data:...", mood: undefined };
  assert.equal(g.trackFingerprint(a), g.trackFingerprint(b));
  assert.notEqual(g.trackFingerprint(a), g.trackFingerprint({ ...a, plays: 3 }));
});

test("stripAudioData copies the track without its legacy base64", () => {
  const track = { id: "t-1", audioData: "data:..." };
  const copy = g.stripAudioData(track);
  assert.deepEqual(copy, { id: "t-1" });
  assert.equal(track.audioData, "data:...");
});

test("getCollectionDuration adds up durations, treating missing as zero", () => {
  assert.equal(g.getCollectionDuration([{ duration: 120 }, { duration: "30" }, {}]), 150);
  assert.equal(g.getCollectionDuration([]), 0);
});

test("a file already in the vault is found by its name and size", () => {
  const vault = [
    { id: "a", title: "Still In", fileName: "Still In.mp3", fileSize: 4484726 },
    { id: "b", title: "Imported", fileName: "Late Night.mp3", fileSize: "3100000" }
  ];
  assert.equal(g.findVaultCopy(vault, "Still In.mp3", 4484726).id, "a");
  assert.equal(g.findVaultCopy(vault, "Late Night.mp3", 3100000).id, "b");
  // A new take with the same name is a different file.
  assert.equal(g.findVaultCopy(vault, "Still In.mp3", 4484727), null);
  assert.equal(g.findVaultCopy(vault, "Other.mp3", 4484726), null);
  assert.equal(g.findVaultCopy(vault, "", 0), null);
  assert.equal(g.findVaultCopy(undefined, "Still In.mp3", 4484726), null);
});
