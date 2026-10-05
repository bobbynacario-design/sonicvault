"use strict";
// The AI worker's metadata route against a fake Anthropic: no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const ENV = { ANTHROPIC_API_KEY: "test-key", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" };
const METADATA = '"aiGenre":"Pop","aiMood":"Warm","aiTheme":"Home","aiEnergy":"Medium","aiVocalStyle":"Lead","aiEra":"Modern","aiInstruments":["Guitar"],"aiTags":["home"],"aiSummary":"One. Two.","coverStyle":"tape","aiExplicit":false}';

// Anthropic answers with each status in turn.
async function run(statuses) {
  const worker = (await load()).default;
  let calls = 0;
  globalThis.fetch = async () => {
    const status = statuses[calls++];
    if (status === 200) return new Response(JSON.stringify({ content: [{ type: "text", text: METADATA }] }), { status });
    const error = status === 529
      ? { type: "overloaded_error", message: "Overloaded" }
      : status === 403
        ? { type: "forbidden", message: "Request not allowed" }
        : { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." };
    return new Response(JSON.stringify({ type: "error", error }), { status });
  };
  const quiet = console.warn;
  const loud = console.error;
  console.warn = console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.example/", {
      method: "POST",
      headers: { Origin: "https://app.example", Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Still In" })
    }), ENV);
    return { res, body: await res.json(), calls };
  } finally {
    console.warn = quiet;
    console.error = loud;
  }
}

test("a momentarily overloaded Anthropic is retried, and the metadata comes back", async () => {
  const { res, body, calls } = await run([529, 200]);
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.equal(body.aiGenre, "Pop");
});

test("a failure that will not pass -- no credit, a bad key -- is reported at once, with Anthropic's reason", async () => {
  const { res, body, calls } = await run([400]);
  assert.equal(calls, 1);
  assert.equal(res.status, 502);
  assert.equal(body.error, "Anthropic API request failed (400 invalid_request_error): Your credit balance is too low to access the Anthropic API.");
});

test("a call from a region Anthropic doesn't serve says so, instead of a bare \"Request not allowed\"", async () => {
  const { res, body, calls } = await run([403]);
  assert.equal(calls, 1);
  assert.equal(res.status, 502);
  assert.equal(body.error, "Anthropic API request failed (403 forbidden): Request not allowed (Anthropic doesn't serve the region the worker ran in; check [placement] in wrangler.toml)");
});
