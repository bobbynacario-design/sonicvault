"use strict";
// The AI worker's /translate: one translated line per sung line, an
// explanation, and notes -- against a stubbed Claude.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const BASE_ENV = { ANTHROPIC_API_KEY: "test-key", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" };

async function call(body, { env = {}, fetchImpl, token = "t" } = {}) {
  const worker = (await load()).default;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.example/translate", {
      method: "POST",
      headers: { Origin: "https://app.example", Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), { ...BASE_ENV, ...env });
    return { res, json: JSON.parse(await res.text()), calls };
  } finally {
    console.error = quiet;
  }
}

// Claude's reply: the JSON, sometimes inside a code fence.
const claude = (answer) => async () => new Response(JSON.stringify({
  content: [{ type: "text", text: "```json\n" + JSON.stringify(answer) + "\n```" }]
}));

const SONG = { title: "Buo At Totoo", lyrics: "[Verse]\nIka an buhay ko\nDai ako mabibiya", lines: ["Ika an buhay ko", "Dai ako mabibiya"], language: "English" };

test("each sung line comes back translated, with what the song is about", async () => {
  const { res, json, calls } = await call(SONG, { fetchImpl: claude({
    from: "Bikol", same: false, lines: ["You are my life", "I will not leave"],
    about: "A tender promise of staying.", notes: [{ line: 2, note: "Mabibiya: to leave behind." }, { line: 9, note: "No such line" }]
  }) });
  assert.equal(res.status, 200);
  assert.deepEqual(json, {
    from: "Bikol", same: false, lines: ["You are my life", "I will not leave"],
    about: "A tender promise of staying.", notes: [{ line: 2, note: "Mabibiya: to leave behind." }]
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.messages[0].content, /Target language: English/);
  assert.match(sent.messages[0].content, /1\. Ika an buhay ko\n2\. Dai ako mabibiya/);
  assert.equal(sent.max_tokens, 4096);
  assert.equal(sent.model, "claude-sonnet-5-5", "translations use the stronger model");
  assert.match(sent.system, /Bikol/);
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.messages.length, 1);
});

test("a song already in the language comes back with no lines, just the explanation", async () => {
  const { json } = await call(SONG, { fetchImpl: claude({ from: "English", same: true, lines: ["ignored"], about: "x", notes: [] }) });
  assert.equal(json.same, true);
  assert.deepEqual(json.lines, []);
});

test("lines that no longer line up are refused; one short is padded", async () => {
  const many = { ...SONG, lines: ["a", "b", "c", "d", "e"] };
  const off = await call(many, { fetchImpl: claude({ from: "Bikol", same: false, lines: ["A", "B"], about: "", notes: [] }) });
  assert.equal(off.res.status, 502);
  assert.match(off.json.error, /didn't line up/);
  const short = await call(many, { fetchImpl: claude({ from: "Bikol", same: false, lines: ["A", "B", "C", "D"], about: "", notes: [] }) });
  assert.deepEqual(short.json.lines, ["A", "B", "C", "D", ""]);
});

test("nothing to translate, or no token, never reaches Claude", async () => {
  const empty = await call({ language: "English", lines: [] }, { fetchImpl: claude({}) });
  assert.equal(empty.res.status, 400);
  assert.equal(empty.calls.length, 0);
  const stranger = await call(SONG, { fetchImpl: claude({}), token: "wrong" });
  assert.equal(stranger.res.status, 401);
  assert.equal(stranger.calls.length, 0);
});
