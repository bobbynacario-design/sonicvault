"use strict";
// The AI worker's metadata route against a fake Anthropic: no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const ENV = { ANTHROPIC_API_KEY: "test-key", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" };
const METADATA = '{"aiGenre":"Pop","aiMood":"Warm","aiTheme":"Home","aiEnergy":"Medium","aiVocalStyle":"Lead","aiEra":"Modern","aiInstruments":["Guitar"],"aiTags":["home"],"aiSummary":"One. Two.","coverStyle":"tape","aiExplicit":false}';

// Anthropic answers with each status in turn; "refusal" is a 200 that declines.
async function run(statuses, request = { title: "Still In" }) {
  const worker = (await load()).default;
  let calls = 0;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const status = statuses[calls++];
    if (status === "refusal") {
      return new Response(JSON.stringify({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" }, content: [] }), { status: 200 });
    }
    if (status === 200) {
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: METADATA }] }), { status });
    }
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
      body: JSON.stringify(request)
    }), ENV);
    return { res, body: await res.json(), calls, sent };
  } finally {
    console.warn = quiet;
    console.error = loud;
  }
}

test("songs are tagged by Haiku 5.5, held to the schema, with no started reply or temperature", async () => {
  const { res, body, sent } = await run([200]);
  assert.equal(res.status, 200);
  assert.equal(body.coverStyle, "tape");
  assert.equal(sent[0].model, "claude-haiku-5-5");
  assert.equal(sent[0].temperature, undefined);
  assert.deepEqual(sent[0].messages.map((m) => m.role), ["user"]);
  assert.equal(sent[0].output_config.effort, "low");
  assert.equal(sent[0].output_config.format.type, "json_schema");
  assert.deepEqual(sent[0].output_config.format.schema.properties.coverStyle.enum, ["aurora", "vinyl", "poster", "scope", "prism", "mono", "pulse", "tape"]);
});

test("a model named in the app's settings is used as it is, without an effort setting", async () => {
  const { res, sent } = await run([200], { title: "Still In", model: "claude-haiku-4-5" });
  assert.equal(res.status, 200);
  assert.equal(sent[0].model, "claude-haiku-4-5");
  assert.equal(sent[0].output_config.effort, undefined);
  assert.equal(sent[0].output_config.format.type, "json_schema");
});

test("a song Claude declines says so, instead of \"invalid metadata\"", async () => {
  const { res, body } = await run(["refusal"]);
  assert.equal(res.status, 502);
  assert.equal(body.error, "Claude declined this one (general_harms). Try rewording the prompt or lyrics.");
});

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
