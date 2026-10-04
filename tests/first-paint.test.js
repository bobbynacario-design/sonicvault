"use strict";
// js/first-paint.js decides, before the page paints, whether the sign-in
// page covers the app and which theme it is drawn in.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "js", "first-paint.js"), "utf8");

function firstPaint({ pathname = "/sonicvault/", search = "", store = {}, storageThrows = false } = {}) {
  const overlay = { hidden: true };
  const htmlClasses = new Set();
  const bodyClasses = new Set();
  vm.runInNewContext(SOURCE, {
    URLSearchParams,
    location: { pathname, search },
    localStorage: {
      getItem(key) {
        if (storageThrows) throw new Error("SecurityError");
        return key in store ? store[key] : null;
      }
    },
    document: {
      getElementById: (id) => (id === "login-overlay" ? overlay : null),
      documentElement: { classList: { add: (c) => htmlClasses.add(c) } },
      body: { classList: { add: (c) => bodyClasses.add(c) } }
    }
  });
  return { shown: !overlay.hidden, locked: htmlClasses.has("sv-locked"), light: bodyClasses.has("light") };
}

test("a first visit to the app meets the sign-in page", () => {
  assert.deepEqual(firstPaint(), { shown: true, locked: true, light: false });
  assert.equal(firstPaint({ pathname: "/" }).shown, true);
  // A share route with no id is just the app.
  assert.equal(firstPaint({ pathname: "/sonicvault/track/" }).shown, true);
});

test("whoever was signed in last time opens the vault straight from its cache", () => {
  assert.deepEqual(firstPaint({ store: { sv_owner_hint: "1" } }), { shown: false, locked: false, light: false });
});

test("share links never meet it, direct or through the 404 redirect", () => {
  assert.equal(firstPaint({ pathname: "/sonicvault/track/t-1774791242514" }).shown, false);
  assert.equal(firstPaint({ pathname: "/playlist/pl-1" }).shown, false);
  assert.equal(firstPaint({ search: "?sv-route=%2Ftrack%2Ft-1" }).shown, false);
  assert.equal(firstPaint({ search: "?sv-route=%2Fplaylist%2Fpl-9" }).shown, false);
});

test("the saved theme is applied before anything paints", () => {
  assert.equal(firstPaint({ store: { sv_theme: "light" } }).light, true);
  assert.equal(firstPaint({ store: { sv_theme: "dark" } }).light, false);
});

test("blocked storage still shows the sign-in page rather than failing", () => {
  assert.deepEqual(firstPaint({ storageThrows: true }), { shown: true, locked: true, light: false });
});
