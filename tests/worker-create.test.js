"use strict";
// The AI worker's Create routes -- /generate, /lyrics, /cover -- against
// stand-ins for Gemini, Anthropic and Workers AI: no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const BASE_ENV = { ANTHROPIC_API_KEY: "test-key", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" };

async function call(route, body, { env = {}, fetchImpl, ai } = {}) {
  const worker = (await load()).default;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.example" + route, {
      method: "POST",
      headers: { Origin: "https://app.example", Authorization: "Bearer t", "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }), { ...BASE_ENV, ...env, ...(ai ? { AI: ai } : {}) });
    return { res, text: await res.text(), calls };
  } finally {
    console.error = quiet;
  }
}

const gemini = (payload, status = 200) => async () => new Response(JSON.stringify(payload), { status });

test("without a Gemini key, /generate says so before reading anything", async () => {
  const { res, text, calls } = await call("/generate", {});
  assert.equal(res.status, 501);
  assert.match(JSON.parse(text).error, /GEMINI_API_KEY/);
  assert.equal(calls.length, 0);
});

test("with a key, an empty /generate asks for a description and calls nobody", async () => {
  const { res, text, calls } = await call("/generate", {}, { env: { GEMINI_API_KEY: "g" } });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(text).error, /Describe the sound/);
  assert.equal(calls.length, 0);
});

test("/generate asks Lyria for audio with the sound, title and lyrics, and passes the answer through", async () => {
  const answer = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mp3", data: "SUQz" } }, { text: "[Verse]\nla" }] } }] };
  const { res, text, calls } = await call("/generate", {
    title: "Harbour", style: "Warm indie folk, 90 BPM", lyrics: "[Verse]\nla", instrumental: false
  }, { env: { GEMINI_API_KEY: "g-key" }, fetchImpl: gemini(answer) });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), answer);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/lyria-3.5:generateContent");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-key");
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.generationConfig.responseModalities, ["AUDIO", "TEXT"]);
  assert.equal(sent.contents[0].parts[0].text, "Warm indie folk, 90 BPM\nSong title: Harbour\n\nLyrics:\n[Verse]\nla");
});

test("an instrumental leaves the lyrics out and says so; LYRIA_MODEL picks the model", async () => {
  const { calls } = await call("/generate", { style: "Lo-fi beat", lyrics: "[Verse]\nignored", instrumental: true }, {
    env: { GEMINI_API_KEY: "g", LYRIA_MODEL: "lyria-3-clip-preview" },
    fetchImpl: gemini({ candidates: [] })
  });
  assert.match(calls[0].url, /models\/lyria-3-clip-preview:generateContent$/);
  assert.equal(JSON.parse(calls[0].init.body).contents[0].parts[0].text, "Lo-fi beat\nInstrumental only, no vocals.");
});

test("Google's refusal comes back with its reason", async () => {
  const { res, text } = await call("/generate", { style: "x" }, {
    env: { GEMINI_API_KEY: "g" },
    fetchImpl: gemini({ error: { code: 403, status: "PERMISSION_DENIED", message: "Billing is not enabled." } }, 403)
  });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(text).error, "Lyria request failed (403 PERMISSION_DENIED): Billing is not enabled.");
});

test("over-long input is refused before Google is asked", async () => {
  const { res, calls } = await call("/generate", { style: "x".repeat(1001) }, { env: { GEMINI_API_KEY: "g" } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("/lyrics returns Claude's sheet and keeps the given title", async () => {
  const claude = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: '"title":"Invented","lyrics":"[Verse 1]\\nOut on the water"}' }]
  }), { status: 200 });
  const { res, text, calls } = await call("/lyrics", { title: "Harbour", style: "folk", draft: "" }, { fetchImpl: claude });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { title: "Harbour", lyrics: "[Verse 1]\nOut on the water" });
  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.system, /\[Verse 1\]/);
  assert.match(sent.messages[0].content, /Title:\nHarbour/);

  const untitled = await call("/lyrics", { style: "folk" }, { fetchImpl: claude });
  assert.equal(JSON.parse(untitled.text).title, "Invented");

  const empty = await call("/lyrics", {}, { fetchImpl: claude });
  assert.equal(empty.res.status, 400);
});

test("/cover draws with FLUX and never quotes the title", async () => {
  let asked;
  const ai = { run: async (model, input) => { asked = { model, input }; return { image: "/9j/AAAA" }; } };
  const { res, text } = await call("/cover", { title: "Harbour Lights", style: "warm folk" }, { ai });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/jpeg", image: "/9j/AAAA" });
  assert.equal(asked.model, "@cf/black-forest-labs/flux-1-schnell");
  assert.match(asked.input.prompt, /warm folk/);
  assert.match(asked.input.prompt, /No text/);
  assert.doesNotMatch(asked.input.prompt, /"Harbour Lights"/);

  const failing = await call("/cover", { title: "x" }, { ai: { run: async () => { throw new Error("capacity"); } } });
  assert.equal(failing.res.status, 502);
});

test("the Create routes need the token like every other", async () => {
  const worker = (await load()).default;
  const res = await worker.fetch(new Request("https://w.example/generate", {
    method: "POST",
    headers: { Origin: "https://app.example", "Content-Type": "application/json" },
    body: "{}"
  }), { ...BASE_ENV, GEMINI_API_KEY: "g" });
  assert.equal(res.status, 401);
});
