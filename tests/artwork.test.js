"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9];

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be32 = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function apicBody({ type = 3, mime = "image/jpeg", desc = "", image = JPEG, encoding = 0 } = {}) {
  const descBytes = encoding === 1 ? [0xff, 0xfe, ...[...desc].flatMap((c) => [c.charCodeAt(0), 0]), 0, 0] : [...ascii(desc), 0];
  return [encoding, ...ascii(mime), 0, type, ...descBytes, ...image];
}

function frame(major, id, body, formatFlags = 0) {
  if (major === 2) return [...ascii(id), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
  const size = major === 4 ? syncsafe(body.length) : be32(body.length);
  return [...ascii(id), ...size, 0, formatFlags, ...body];
}

function tag(major, frames, { flags = 0, padding = 16, trailing = [0xff, 0xfb, 0x90] } = {}) {
  const body = [...frames.flat(), ...new Array(padding).fill(0)];
  return Uint8Array.from([...ascii("ID3"), major, 0, flags, ...syncsafe(body.length), ...body, ...trailing]);
}

const text = (major, id, s) => frame(major, id, [0, ...ascii(s)]);

test("id3TagLength reads the syncsafe size and refuses anything else", () => {
  const t = tag(3, [text(3, "TIT2", "Still In")]);
  assert.equal(g.id3TagLength(t), t.length - 3);
  assert.equal(g.id3TagLength(Uint8Array.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0])), 0);
  assert.equal(g.id3TagLength(Uint8Array.from(ascii("ID3"))), 0);
});

test("finds a Suno-style v2.3 front cover after the text frames", () => {
  const t = tag(3, [text(3, "TIT2", "Horizon"), text(3, "TPE1", "bobcu250"), frame(3, "APIC", apicBody())]);
  const art = g.findEmbeddedArt(t);
  assert.equal(art.mime, "image/jpeg");
  assert.deepEqual([...art.data], JPEG);
});

test("reads v2.4 syncsafe frame sizes, past a frame bigger than 127 bytes", () => {
  const big = frame(4, "USLT", [0, ...ascii("eng"), 0, ...ascii("x".repeat(300))]);
  const t = tag(4, [big, frame(4, "APIC", apicBody())]);
  assert.deepEqual([...g.findEmbeddedArt(t).data], JPEG);
});

test("prefers the front cover over an earlier picture, and trusts the bytes over the MIME", () => {
  const t = tag(3, [
    frame(3, "APIC", apicBody({ type: 4, image: PNG })),
    frame(3, "APIC", apicBody({ type: 3, mime: "image/png", encoding: 1, desc: "cover" }))
  ]);
  const art = g.findEmbeddedArt(t);
  assert.equal(art.mime, "image/jpeg");
  assert.deepEqual([...art.data], JPEG);
});

test("reads a v2.2 PIC frame", () => {
  const body = [0, ...ascii("PNG"), 3, 0, ...PNG];
  const art = g.findEmbeddedArt(tag(2, [frame(2, "PIC", body)]));
  assert.equal(art.mime, "image/png");
});

test("undoes tag-level unsynchronisation in v2.3", () => {
  // Unsynchronised, every 0xFF in the image is followed by an inserted 0x00.
  const raw = frame(3, "APIC", apicBody());
  const unsynced = raw.flatMap((b) => (b === 0xff ? [0xff, 0x00] : [b]));
  const art = g.findEmbeddedArt(tag(3, [unsynced], { flags: 0x80 }));
  assert.deepEqual([...art.data], JPEG);
});

test("returns null for no picture, a truncated tag, or no tag", () => {
  assert.equal(g.findEmbeddedArt(tag(3, [text(3, "TIT2", "No art")])), null);
  const t = tag(3, [frame(3, "APIC", apicBody())]);
  assert.equal(g.findEmbeddedArt(t.subarray(0, 20)), null);
  assert.equal(g.findEmbeddedArt(Uint8Array.from(JPEG)), null);
});

function pixels(...colors) {
  return Uint8ClampedArray.from(colors.flatMap(([r, g2, b, n = 1]) => new Array(n).fill([r, g2, b, 255]).flat()));
}

test("paletteFromPixels leads with the most vivid colour, not the most common", () => {
  const p = g.paletteFromPixels(pixels([128, 128, 128, 80], [230, 40, 40, 20]));
  const hue = Number(/hsl\((\d+)/.exec(p.a)[1]);
  assert.ok(hue <= 10 || hue >= 350, "expected red, got " + p.a);
  for (const key of ["a", "b", "c", "accent", "soft", "deep"]) assert.equal(typeof p[key], "string");
});

test("paletteFromPixels picks a second, distinct hue when the art has one", () => {
  const p = g.paletteFromPixels(pixels([40, 90, 230, 60], [230, 60, 160, 40]));
  const h1 = Number(/hsl\((\d+)/.exec(p.a)[1]);
  const h2 = Number(/hsl\((\d+)/.exec(p.b)[1]);
  const d = Math.abs(h1 - h2) % 360;
  assert.ok(Math.min(d, 360 - d) >= 30, p.a + " vs " + p.b);
});

test("greyscale art gets a neutral palette, and empty input none", () => {
  const p = g.paletteFromPixels(pixels([20, 20, 20, 50], [200, 200, 200, 50]));
  assert.match(p.accent, /^hsl\(230 14% /);
  assert.equal(g.paletteFromPixels(new Uint8ClampedArray(0)), null);
});
