"use strict";
// Structural guards on the shell: index.html, sw.js and the files they load.
// Source-as-text checks, in the style of pokerhq/tests/roadmap.test.js --
// they catch the deploy-time mistakes that no unit test can see.
//
//   npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const html = read("index.html");
const sw = read("sw.js");

// Local code and styles the page loads, in document order.
function localAssets() {
  const out = [];
  const re = /<script\b[^>]*\bsrc="([^"]+)"|<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1] || m[2];
    if (/^(https?:)?\/\//.test(url)) continue;
    const [file, query = ""] = url.split("?");
    out.push({ url, file: file.replace(/^\.\//, ""), query });
  }
  return out;
}

function shellAssets() {
  const block = sw.match(/var SHELL_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(block, "sw.js declares SHELL_ASSETS");
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, ""));
}

test("the stylesheet lives in styles/app.css, not in a <style> block", () => {
  // The whole stylesheet moved out of index.html. A <style> block creeping back
  // in would be a second source of truth for the cascade.
  assert.doesNotMatch(html, /<style\b/i);
  assert.ok(localAssets().some((a) => a.file === "styles/app.css"));
});

test("every local script and stylesheet carries the same ?v= token", () => {
  // sw.js serves same-origin files cache-first. Without a token that changes on
  // each deploy, a fresh index.html would run against stale cached modules.
  const assets = localAssets();
  assert.ok(assets.length > 0);
  const tokens = new Set();
  for (const a of assets) {
    const v = new URLSearchParams(a.query).get("v");
    assert.ok(v, a.url + " has no ?v= token");
    tokens.add(v);
  }
  assert.equal(tokens.size, 1, "tokens disagree: " + [...tokens].join(", "));
});

test("every file the page loads exists on disk", () => {
  for (const a of localAssets()) {
    assert.ok(fs.existsSync(path.join(ROOT, a.file)), a.file + " is referenced but missing");
  }
});

test("every file the page loads is precached for offline boot", () => {
  const shell = new Set(shellAssets());
  for (const a of localAssets()) {
    assert.ok(shell.has(a.file), a.file + " is loaded by index.html but missing from SHELL_ASSETS");
  }
});

test("pure data modules load before the features that call them", () => {
  // Feature scripts call js/data/* at parse time and at boot. A data module
  // loaded after them is undefined when they first run.
  const files = localAssets().map((a) => a.file);
  const lastData = files.reduce((n, f, i) => (f.startsWith("js/data/") ? i : n), -1);
  const firstFeature = files.findIndex((f) => f.startsWith("js/features/"));
  if (lastData === -1 || firstFeature === -1) return;
  assert.ok(lastData < firstFeature, files[lastData] + " loads after " + files[firstFeature]);
});

test("feature scripts declare no top-level let, const or class", () => {
  // Features are plain classic scripts so their top-level `var`s and functions
  // stay on window -- that is what keeps `tracks = …` reassignments and inline
  // onclick handlers working across files. Top-level let/const/class do not
  // become window properties and would break that silently.
  for (const file of classicScripts()) {
    const bad = read(file).split("\n").findIndex((line) => /^(let|const|class)\s/.test(line));
    assert.equal(bad, -1, file + ":" + (bad + 1) + " is a top-level let/const/class");
  }
});

// Classic scripts the page loads, in order: everything local except the module.
function classicScripts() {
  return localAssets().filter((a) => a.file.endsWith(".js") && a.file !== "js/app.js").map((a) => a.file);
}

test("all code lives in js/, with js/app.js the only module", () => {
  // The same reasoning as the stylesheet: an inline script creeping back in
  // would be a second, untested, uncached home for app code.
  const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of tags) {
    if (/\bsrc="https?:/.test(attrs)) continue;
    assert.match(attrs, /\bsrc="/, "inline <script" + attrs + "> in index.html");
    const isApp = /\bsrc="(\.\/)?js\/app\.js\?/.test(attrs);
    assert.equal(/\btype="module"/.test(attrs), isApp, "only js/app.js loads as a module: <script" + attrs + ">");
  }
});

test("js/boot.js loads after every other script", () => {
  // Boot renders the first frame, so it calls into every feature as it loads.
  // A script added after it is undefined at that moment.
  const scripts = classicScripts();
  assert.equal(scripts[scripts.length - 1], "js/boot.js");
});

test("every script under js/ is loaded by the page", () => {
  // A new file that never makes it into index.html works nowhere, silently.
  const loaded = new Set(localAssets().map((a) => a.file));
  for (const dir of ["js", "js/data", "js/features"]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".js"))) {
      assert.ok(loaded.has(dir + "/" + name), dir + "/" + name + " is not loaded by index.html");
    }
  }
});

test("every classic script parses", () => {
  // One file with a syntax error loses only its own functions in the browser,
  // which surfaces later as a ReferenceError somewhere else entirely.
  for (const file of classicScripts()) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), file);
  }
});

test("no two classic scripts declare the same top-level name", () => {
  // They share one global scope, so a second `function save` in another file
  // would quietly replace the first for every caller.
  const seen = new Map();
  for (const file of classicScripts()) {
    for (const m of read(file).matchAll(/^(?:async\s+)?(?:function\s+|var\s+)([A-Za-z_$][\w$]*)/gm)) {
      assert.ok(!seen.has(m[1]), m[1] + " is declared in both " + seen.get(m[1]) + " and " + file);
      seen.set(m[1], file);
    }
  }
});
