"use strict";
// The AI worker's settings follow the owner's sign-in through the vault.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const set = (at, token = "t") => ({ endpoint: "https://w.example", token, model: "", updatedAt: at });

test("the first browser that has usable settings seeds an empty vault", () => {
  // Saved before syncing existed: no updatedAt, but an address is set.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "https://w.example", token: "t" }, undefined), "push");
  assert.equal(g.resolveAIWorkerSync(set(5), null), "push");
  // A browser with nothing set has nothing to share.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "", token: "" }, undefined), "none");
});

test("half-typed settings never leave the browser they were typed in", () => {
  // A token pasted before its address, newer than everything: it used to
  // spread and blank the address in every other browser.
  const half = { endpoint: "", token: "fresh", updatedAt: 99 };
  assert.equal(g.resolveAIWorkerSync(half, set(10)), "adopt");
  assert.equal(g.resolveAIWorkerSync(half, undefined), "none");
  // And a half-set copy already in the vault never wins: a browser that has
  // the whole thing puts it back.
  assert.equal(g.resolveAIWorkerSync(set(5), half), "push");
  assert.equal(g.resolveAIWorkerSync({ endpoint: "", token: "" }, half), "none");
  assert.equal(g.isUsableAIWorker(half), false);
  assert.equal(g.isUsableAIWorker(set(1)), true);
});

test("a browser with nothing usable, or an older copy, takes the vault's", () => {
  assert.equal(g.resolveAIWorkerSync({ endpoint: "", token: "" }, set(10)), "adopt");
  // An old token from before syncing gives way to the one in the vault.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "https://w.example", token: "old" }, set(10, "new")), "adopt");
  assert.equal(g.resolveAIWorkerSync(set(5, "old"), set(10, "new")), "adopt");
});

test("a newer usable change here goes to the vault; equal copies are left alone", () => {
  assert.equal(g.resolveAIWorkerSync(set(20, "new"), set(10, "old")), "push");
  assert.equal(g.resolveAIWorkerSync(set(10), set(10)), "none");
});

test("records are trimmed and stamped", () => {
  assert.deepEqual(g.aiWorkerRecord({ endpoint: " https://w.example ", token: " t ", model: "" }, 7),
    { endpoint: "https://w.example", token: "t", model: "", updatedAt: 7 });
  assert.ok(g.aiWorkerRecord({}, 0).updatedAt > 0);
});

test("backups leave the worker's token out", () => {
  const settings = { lastPlayedTrackId: "t-1", aiWorker: set(10, "secret") };
  const copy = g.stripVaultSecrets(settings);
  assert.deepEqual(copy, { lastPlayedTrackId: "t-1" });
  assert.equal(settings.aiWorker.token, "secret", "the vault's own copy is untouched");
  assert.deepEqual(g.stripVaultSecrets(null), {});
  assert.deepEqual(g.stripVaultSecrets([1]), {});
});
