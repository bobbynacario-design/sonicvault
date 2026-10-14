"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function app(store = {}, images = new Map()) {
  let serial = 0;
  const cover = new Blob(["finished cover with lettering"], { type: "image/jpeg" });
  const fields = {
    "rc-apply": {}, "rc-make": {},
    "rc-note": { classList: { toggle() {} } },
    "rc-title": { value: "Positive EV" },
    "rc-text": { value: "both" }, "rc-place": { value: "bottom" },
    "release-cover-canvas": { toBlob(callback) { callback(cover); } }
  };
  const backdrop = {
    attrs: {}, innerHTML: "",
    getAttribute(key) { return this.attrs[key]; },
    setAttribute(key, value) { this.attrs[key] = value; }
  };
  fields["xp-backdrop"] = backdrop;
  const track = { id: "t1", audioURL: "https://example.test/song.mp3" };
  const ctx = vm.createContext({
    Blob, Response, Promise, Date, Math, console, setTimeout, clearTimeout,
    window: { caches: true },
    caches: { async open() { return {
      async put(key, response) { images.set(key, await response.blob()); },
      async match(key) { return images.has(key) ? new Response(images.get(key)) : undefined; },
      async delete(key) { return images.delete(key); }
    }; } },
    localStorage: {
      getItem(key) { return store[key] || null; },
      setItem(key, value) { store[key] = value; }
    },
    URL: { createObjectURL() { return "blob:cover-" + ++serial; }, revokeObjectURL() {} },
    document: { getElementById(id) { return fields[id] || null; }, querySelectorAll() { return []; } },
    getTrackPalette() { return { a: "fallback" }; },
    getVaultTrack(id) { return id === track.id ? track : null; },
    attr(value) { return value; },
    showToast(message) { ctx.toast = message; },
    _currentTrack: null, _aiConfig: null
  });
  for (const file of ["artwork", "release-cover"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/features/" + file + ".js"), "utf8"), ctx);
  }
  ctx.paletteFromBlob = async () => ({ a: "#123456", b: "#234567", c: "#345678", angle: 30 });
  ctx.drawReleaseCover = async () => { ctx.drawn = true; };
  return { ctx, track, fields, backdrop, cover, store, images };
}

test("applying exports the finished preview, updates artwork and restores the choice after reload", async () => {
  const { ctx, track, cover, fields, store, images } = app();
  ctx._releaseCover = { id: track.id, image: {}, busy: false };
  await ctx.applyReleaseCoverToSong();
  assert.equal(ctx.drawn, true);
  assert.equal(ctx.toast, "Song cover updated");
  assert.equal(fields["rc-apply"].disabled, false);
  assert.equal(ctx.trackHasArt(track), true);
  assert.equal(ctx.getCoverPalette(track).a, "#123456");
  const saved = JSON.parse(store.sv_song_covers)[track.id];
  assert.equal(await images.get(saved.key).text(), await cover.text());
  const restored = app(store, images);
  await restored.ctx.loadCachedArt();
  assert.ok(restored.ctx.getArtURL(track.id));
  assert.equal(restored.ctx.getCoverPalette(track).a, "#123456");
});

test("an embedded-art scan cannot replace the selected cover or its palette", async () => {
  const { ctx, track, cover } = app();
  await ctx.useSongCoverBlob(track.id, cover);
  const selectedURL = ctx.getArtURL(track.id);
  ctx.paletteFromBlob = async () => ({ a: "embedded" });
  await ctx.rememberTrackArt(track, { mime: "image/jpeg", data: [1, 2, 3] }, true, { made: "2026-10-14" });
  assert.equal(ctx.getArtURL(track.id), selectedURL);
  assert.equal(ctx.getCoverPalette(track).a, "#123456");
  assert.equal(ctx.getArtIndex()[track.id].lyrics, true);
  assert.equal(ctx.getArtIndex()[track.id].stamp.made, "2026-10-14");
  await ctx.rememberTrackArt(track, null, false, null);
  assert.equal(ctx.getArtURL(track.id), selectedURL);
});

test("failed selection preserves the previous cover and reports the saving error", async () => {
  const { ctx, track, cover, fields, images, store } = app();
  await ctx.useSongCoverBlob(track.id, cover);
  const previous = store.sv_song_covers;
  const previousURL = ctx.getArtURL(track.id);
  ctx.localStorage.setItem = () => { throw new Error("Quota exceeded"); };
  ctx._releaseCover = { id: track.id, image: {}, busy: false };
  await ctx.applyReleaseCoverToSong();
  assert.equal(ctx.getArtURL(track.id), previousURL);
  assert.equal(store.sv_song_covers, previous);
  assert.equal(images.size, 1, "failed save removes the unused image");
  assert.equal(ctx._releaseCover.error, true);
  assert.match(fields["rc-note"].textContent, /could not be saved/);
  assert.equal(fields["rc-apply"].disabled, false);
  assert.equal(ctx.toast, undefined);
});

test("a replaced cover refreshes the player backdrop even for the same song", async () => {
  const { ctx, track, cover, backdrop } = app();
  ctx._currentTrack = track;
  ctx.applyTrackTint = () => {};
  ctx.updateMediaSession = () => {};
  await ctx.useSongCoverBlob(track.id, cover);
  const first = backdrop.innerHTML;
  await ctx.useSongCoverBlob(track.id, new Blob(["replacement"], { type: "image/jpeg" }));
  assert.notEqual(backdrop.innerHTML, first);
  assert.ok(backdrop.innerHTML.includes(ctx.getArtURL(track.id)));
});

test("applying requires a picture and cannot apply to a different song after switching dialogs", async () => {
  const { ctx, track, images } = app();
  ctx._releaseCover = { id: track.id, image: null };
  await ctx.applyReleaseCoverToSong();
  assert.equal(ctx.drawn, undefined);
  ctx._releaseCover.image = {};
  ctx.drawReleaseCover = async () => { ctx._releaseCover = { id: "t2", image: {} }; };
  await ctx.applyReleaseCoverToSong();
  assert.equal(images.size, 0);
  assert.equal(ctx.toast, undefined);
});
