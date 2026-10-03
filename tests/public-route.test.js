"use strict";
// Loading the data behind a public /track/:id or /playlist/:id page.
// js/features/routes.js runs the way the page runs it -- a classic script in
// a shared global scope, after the js/data script it calls -- against
// stand-ins for the DOM, Firebase, and the two share-page renderers.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = ["js/data/routes.js", "js/features/routes.js"];

// Firestore answers on a later turn of the event loop, never synchronously.
const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 1));
const failLater = (err) => new Promise((resolve, reject) => setTimeout(() => reject(err), 1));
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function loadRoutes(pathname, lookup) {
  const noop = () => {};
  const g = {
    console: { error: noop },
    document: { body: { classList: { toggle: noop } }, getElementById: () => null, querySelectorAll: () => [] },
    location: { pathname, search: "", hash: "", origin: "https://example.test" },
    history: {},
    scrollTo: noop,
    getTrackById: () => null,
    getPlaylistById: () => null,
    lookups: [],
    renders: [],
  };
  g.window = g;
  g.history.pushState = g.history.replaceState = (state, title, url) => { g.location.pathname = url; };
  // What the share page would draw: the payload, or null for "not found" --
  // unless a lookup is still in flight, when it shows the loading skeleton.
  g.renderPublicTrackPage = g.renderPublicPlaylistPage = (item) => g.renders.push({ item, loading: g._publicRouteLoading });
  g.fbLoadPublicRoute = (kind, id) => {
    g.lookups.push(kind + ":" + id);
    // A runaway loop stops here instead of keeping the test process alive.
    if (g.lookups.length > 50) return new Promise(noop);
    return lookup(kind, id);
  };
  vm.createContext(g);
  for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), g, { filename: file });
  return g;
}

test("a share that does not exist is looked up once, then shown as not found", async () => {
  // Rendering is what starts a lookup, and a finished lookup re-renders. A
  // missing share used to restart the lookup on every render it caused:
  // ~7 Firestore reads a second, with the page stuck on its skeleton.
  const g = loadRoutes("/sonicvault/track/t-gone", () => later(null));
  g.renderRouteAwareView(true);
  await settle();
  assert.deepEqual(g.lookups, ["track:t-gone"]);
  assert.deepEqual(g.renders.at(-1), { item: null, loading: false });
});

test("a lookup that fails is not retried in a loop either", async () => {
  const g = loadRoutes("/sonicvault/playlist/pl-1", () => failLater(new Error("offline")));
  g.renderRouteAwareView(true);
  await settle();
  assert.deepEqual(g.lookups, ["playlist:pl-1"]);
  assert.deepEqual(g.renders.at(-1), { item: null, loading: false });
});

test("following a share link looks it up afresh, once", async () => {
  const g = loadRoutes("/sonicvault/track/t-gone", () => later(null));
  g.renderRouteAwareView(true);
  await settle();
  g.openSharedRoute("track", "t-gone");
  await settle();
  g.openSharedRoute("track", "t-other");
  await settle();
  assert.deepEqual(g.lookups, ["track:t-gone", "track:t-gone", "track:t-other"]);
});

test("a share that exists is drawn from its payload and not fetched again", async () => {
  const share = { id: "t-1", kind: "track", title: "Neon Highways" };
  const g = loadRoutes("/sonicvault/track/t-1", () => later(share));
  g.renderRouteAwareView(true);
  await settle();
  g.renderRouteAwareView(true);
  assert.deepEqual(g.lookups, ["track:t-1"]);
  assert.equal(g.renders.at(-1).item, share);
  assert.equal(g.renders.at(-1).loading, false);
});
