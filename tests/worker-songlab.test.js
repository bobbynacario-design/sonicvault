"use strict";
// The AI worker's /songlab and /ask, against a stubbed Claude: no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const BASE_ENV = { ANTHROPIC_API_KEY: "test-key", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" };

async function call(route, body, { env = {}, fetchImpl, token = "t" } = {}) {
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
      headers: { Origin: "https://app.example", Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), { ...BASE_ENV, ...env });
    return { res, json: JSON.parse(await res.text()), calls, sent: calls[0] ? JSON.parse(calls[0].init.body) : null };
  } finally {
    console.error = quiet;
  }
}

// Claude's reply: thinking, then the JSON.
const claude = (answer, extra = {}) => async () => new Response(JSON.stringify({
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: JSON.stringify(answer) }],
  ...extra
}));

const DRAFT = { title: "Ilaw sa Pantalan", style: "acoustic folk, warm female vocal, 90 BPM", lyrics: "[Verse 1]\nAn mga ilaw", about: "A homecoming." };
const EXAMPLES = [{ title: "Harbour Lights", sound: "warm folk", lyrics: "[Verse]\nThe boats come home" }, { title: "", sound: "", lyrics: "" }];

test("/songlab writes in the songwriter's voice, from their songs, with the writing model", async () => {
  const { res, json, sent } = await call("/songlab", { idea: "my father's boat", language: "Bikol", examples: EXAMPLES }, { fetchImpl: claude(DRAFT) });
  assert.equal(res.status, 200);
  assert.deepEqual(json, DRAFT);
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.output_config.effort, "medium");
  assert.deepEqual(sent.output_config.format.schema.required, ["title", "style", "lyrics", "about"]);
  assert.match(sent.system, /Central Bikol/);
  assert.match(sent.system, /Never name a real artist/);
  const text = sent.messages[0].content;
  assert.match(text, /^Language: Bikol\nIdea: my father's boat\n/);
  assert.match(text, /1\. Harbour Lights\nSound: warm folk\nLyrics:\n\[Verse\]\nThe boats come home/);
  assert.doesNotMatch(text, /2\. /, "an empty example is left out");
});

test("/songlab rewrites a draft with a change; an unknown language means like my songs", async () => {
  const { sent } = await call("/songlab", {
    language: "Klingon", examples: EXAMPLES,
    previous: { title: "Old", style: "folk", lyrics: "[Chorus]\nla la" }, change: "make the chorus catchier"
  }, { fetchImpl: claude(DRAFT) });
  assert.match(sent.messages[0].content, /^Language: Like my songs\nIdea: \(none/);
  assert.match(sent.messages[0].content, /Previous draft:\nTitle: Old\nStyle: folk\nLyrics:\n\[Chorus\]\nla la\n\nChange: make the chorus catchier$/);
});

test("/songlab refuses what it can't work from, before Claude is asked", async () => {
  const nothing = await call("/songlab", { examples: [] }, { fetchImpl: claude(DRAFT) });
  assert.equal(nothing.res.status, 400);
  const changeAlone = await call("/songlab", { idea: "x", change: "shorter" }, { fetchImpl: claude(DRAFT) });
  assert.equal(changeAlone.res.status, 400);
  const stranger = await call("/songlab", { idea: "x" }, { fetchImpl: claude(DRAFT), token: "wrong" });
  assert.equal(stranger.res.status, 401);
  assert.equal(nothing.calls.length + changeAlone.calls.length + stranger.calls.length, 0);
});

test("/songlab says when Claude declines or sends no lyrics", async () => {
  const declined = await call("/songlab", { idea: "x" }, { fetchImpl: async () => new Response(JSON.stringify({ stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] })) });
  assert.equal(declined.res.status, 502);
  assert.match(declined.json.error, /^Claude declined this one \(general_harms\)/);
  const empty = await call("/songlab", { idea: "x" }, { fetchImpl: claude({ ...DRAFT, lyrics: "" }) });
  assert.equal(empty.res.status, 502);
  assert.match(empty.json.error, /no lyrics/);
});

const CATALOG = "Totals:\nSongs: 2\n\nSongs, newest first:\n[t-1] Harbour Lights · made 2026-10-02\n[t-2] Neon · made 2026-09-15";

test("/ask reads the catalog from the cache, and answers with songs the vault has", async () => {
  const { res, json, sent } = await call("/ask", {
    question: "play something warm", catalog: CATALOG, passages: "[t-1] Harbour Lights\nThe boats come home", today: "2026-10-10",
    history: [{ q: "what's new?", a: "Harbour Lights.", songs: ["t-1"], action: "none" }, { q: "", a: "dropped" }]
  }, { fetchImpl: claude({ answer: "Here's something warm.", songs: ["t-1", "t-9", "t-1"], action: "play", playlistName: "ignored" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { answer: "Here's something warm.", songs: ["t-1"], action: "play", playlistName: "" });
  assert.equal(sent.model, "claude-haiku-5-5");
  assert.equal(sent.output_config.effort, "low");
  assert.match(sent.system[0].text, /Today is 2026-10-10\.$/);
  assert.equal(sent.system[1].text, "The vault:\n" + CATALOG);
  assert.deepEqual(sent.system[1].cache_control, { type: "ephemeral" });
  assert.deepEqual(sent.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(sent.messages[0].content, "Question: what's new?");
  assert.deepEqual(JSON.parse(sent.messages[1].content), { answer: "Harbour Lights.", songs: ["t-1"], action: "none", playlistName: "" });
  assert.equal(sent.messages[2].content, "Question: play something warm\n\nLyrics of the songs closest to this question:\n\n[t-1] Harbour Lights\nThe boats come home");
});

test("/ask keeps a playlist's name, and drops an action with no songs", async () => {
  const named = await call("/ask", { question: "make a playlist", catalog: CATALOG }, { fetchImpl: claude({ answer: "Done.", songs: ["t-2"], action: "playlist", playlistName: "Night drive" }) });
  assert.deepEqual(named.json, { answer: "Done.", songs: ["t-2"], action: "playlist", playlistName: "Night drive" });
  const none = await call("/ask", { question: "play my polka songs", catalog: CATALOG }, { fetchImpl: claude({ answer: "You have none.", songs: [], action: "play", playlistName: "" }) });
  assert.equal(none.json.action, "none");
});

test("/ask needs a question and a catalog, and a catalog that fits", async () => {
  const empty = await call("/ask", { question: "hi", catalog: "" }, { fetchImpl: claude({}) });
  assert.equal(empty.res.status, 400);
  const huge = await call("/ask", { question: "hi", catalog: "x".repeat(600001) }, { fetchImpl: claude({}) });
  assert.equal(huge.res.status, 413);
  assert.equal(empty.calls.length + huge.calls.length, 0);
});
