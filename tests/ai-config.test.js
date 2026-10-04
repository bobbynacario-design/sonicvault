"use strict";
// The AI worker's settings follow the owner's sign-in through the vault.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const set = (at, token = "t") => ({ endpoint: "https://w.example", token, model: "", updatedAt: at });

test("the first browser that has the settings seeds an empty vault", () => {
  // Saved before syncing existed: no updatedAt, but something is set.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "https://w.example", token: "t" }, undefined), "push");
  assert.equal(g.resolveAIWorkerSync(set(5), null), "push");
  // A browser with nothing set has nothing to share.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "", token: "" }, undefined), "none");
});

test("a browser with nothing, or an older copy, takes the vault's", () => {
  assert.equal(g.resolveAIWorkerSync({ endpoint: "", token: "" }, set(10)), "adopt");
  // An old token from before syncing gives way to the one in the vault.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "https://w.example", token: "old" }, set(10, "new")), "adopt");
  assert.equal(g.resolveAIWorkerSync(set(5, "old"), set(10, "new")), "adopt");
});

test("a newer change here goes to the vault; equal copies are left alone", () => {
  assert.equal(g.resolveAIWorkerSync(set(20, "new"), set(10, "old")), "push");
  assert.equal(g.resolveAIWorkerSync(set(10), set(10)), "none");
  // Clearing the settings is a change like any other, and spreads.
  assert.equal(g.resolveAIWorkerSync({ endpoint: "", token: "", updatedAt: 30 }, set(10)), "push");
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
