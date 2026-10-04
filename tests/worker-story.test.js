"use strict";
// The AI worker's /story: a liner note drafted from the songwriter's notes
// and the song, against a stubbed Claude.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const BASE_ENV = { ANTHROPIC_API_KEY: "test-key", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" };

async function call(body, fetchImpl) {
  const worker = (await load()).default;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(String(url), init); };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.example/story", {
      method: "POST",
      headers: { Origin: "https://app.example", Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), BASE_ENV);
    return { res, json: JSON.parse(await res.text()), calls };
  } finally {
    console.error = quiet;
  }
}

const claude = (text) => async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }));

test("the note comes back without quotes, drafted from the notes first", async () => {
  const { res, json, calls } = await call(
    { title: "Still In", notes: "for my brother's 47th, poker nights", lyrics: "[Verse]\nCounted out the quiet years", summary: "A birthday toast in poker terms." },
    claude("“I wrote this for my brother's 47th birthday.”")
  );
  assert.equal(res.status, 200);
  assert.deepEqual(json, { story: "I wrote this for my brother's 47th birthday." });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.match(sent.system, /Never invent people, places, dates or events/);
  assert.match(sent.messages[0].content, /My notes:\nfor my brother's 47th, poker nights/);
  assert.equal(sent.temperature, undefined);
});

test("nothing to draft from never reaches Claude", async () => {
  const { res, calls } = await call({ title: "Empty" }, claude("x"));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});
