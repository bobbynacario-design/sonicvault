"use strict";
// Loads js/data/* the way index.html does: as classic scripts sharing one
// global scope, in the page's own order. Their top-level functions land on
// globalThis, so a test calls them by the same names the features do.
// node --test runs each test file in its own process, so nothing leaks.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

function loadDataScripts() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const files = [...html.matchAll(/<script src="(?:\.\/)?(js\/data\/[^"?]+)/g)].map((m) => m[1]);
  if (!files.length) throw new Error("index.html loads no js/data scripts");
  for (const file of files) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), "utf8"), { filename: file });
  }
  return globalThis;
}

module.exports = { loadDataScripts };
