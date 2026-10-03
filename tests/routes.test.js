"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

test("normalizeRoutePath drops query, hash, doubled and trailing slashes", () => {
  assert.equal(g.normalizeRoutePath("//sonicvault//track/abc/?x=1#h"), "/sonicvault/track/abc");
  assert.equal(g.normalizeRoutePath("track/abc"), "/track/abc");
  assert.equal(g.normalizeRoutePath(""), "/");
  assert.equal(g.normalizeRoutePath("/"), "/");
});

test("the app prefix is whatever precedes /track or /playlist", () => {
  // GitHub Pages serves the app under /sonicvault; localhost serves it at /.
  assert.equal(g.getRoutePrefixFromPath("/sonicvault/track/abc"), "/sonicvault");
  assert.equal(g.getRoutePrefixFromPath("/track/abc"), "");
  assert.equal(g.getRoutePrefixFromPath("/a/b/playlist/pl-1"), "/a/b");
  assert.equal(g.getRoutePrefixFromPath("/sonicvault/"), "/sonicvault");
  assert.equal(g.getRoutePrefixFromPath("/"), "");
});
