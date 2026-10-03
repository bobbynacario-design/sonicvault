"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("validateBackup names the problem with a file, or returns ''", () => {
  const ok = { app: "sonicvault", format: g.BACKUP_FORMAT, tracks: [], playlists: [] };
  assert.equal(g.validateBackup(ok), "");
  assert.equal(g.validateBackup({ tracks: [], playlists: [] }), "");
  assert.match(g.validateBackup(null), /not a SonicVault backup/);
  assert.match(g.validateBackup([]), /not a SonicVault backup/);
  assert.match(g.validateBackup({ ...ok, app: "pokerhq" }), /different app/);
  assert.match(g.validateBackup({ ...ok, playlists: undefined }), /missing its tracks or playlists/);
  assert.match(g.validateBackup({ ...ok, format: g.BACKUP_FORMAT + 1 }), /newer version/);
});

test("buildM3U writes an extended playlist other players can open", () => {
  const text = g.buildM3U([
    { title: "A\nB", duration: 61.6, audioURL: "https://x/a.mp3" },
    { title: "", duration: 0, audioURL: "https://x/b.mp3" },
  ], "Mix\r\nOne");
  assert.equal(text, [
    "#EXTM3U",
    "#PLAYLIST:Mix One",
    "#EXTINF:62,A B",
    "https://x/a.mp3",
    "#EXTINF:-1,Untitled",
    "https://x/b.mp3",
    "",
  ].join("\n"));
  assert.doesNotMatch(g.buildM3U([], ""), /#PLAYLIST/);
});

test("only streamable http(s) tracks are exported to M3U", () => {
  const list = [{ audioURL: "https://a" }, { audioURL: "HTTP://b" }, { audioURL: "data:audio/mp3;base64,AA" }, {}];
  assert.deepEqual(g.getExportableTracks(list).map((t) => t.audioURL), ["https://a", "HTTP://b"]);
});

test("export file names are slugged and stamped", () => {
  assert.equal(g.safeFileName("  Late Night: Vol. 2! "), "late-night-vol-2");
  assert.equal(g.safeFileName("!!!"), "sonicvault");
  assert.match(g.backupStamp(), /^\d{8}-\d{4}$/);
});
