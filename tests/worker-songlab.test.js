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
const EXAMPLES = [{ title: "Harbour Lights", made: "2026-08-31", sound: "warm folk", lyrics: "[Verse]\nThe boats come home" }, { title: "", sound: "", lyrics: "" }];

test("/songlab writes from what they say, in the voice of their songs, with the writing model", async () => {
  const { res, json, sent } = await call("/songlab", {
    what: "the boat my father fixed every summer", who: "my father", feel: "proud, a little sorry",
    language: "Bikol", examples: EXAMPLES, avoid: ["Kape sa Madaling Araw: a quiet morning"]
  }, { fetchImpl: claude({ ...DRAFT, subject: "dropped", images: ["dropped"] }) });
  assert.equal(res.status, 200);
  assert.deepEqual(json, DRAFT);
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.output_config.effort, "high");
  assert.deepEqual(sent.output_config.format.schema.required, ["title", "style", "lyrics", "about"]);
  // Nothing made up: every fact comes from what they said (2026-10-11).
  assert.match(sent.system, /Never make up their life\. Every person, place, event and memory in the song comes from what they told you/);
  assert.match(sent.system, /Don't invent relatives/);
  // The craft of their own best songs: one line the chorus repeats.
  assert.match(sent.system, /One central line carries the song\. It is the title/);
  assert.match(sent.system, /the same words each time it comes back/);
  assert.match(sent.system, /Verses of about four short lines/);
  assert.doesNotMatch(sent.system, /rice cooker|a mother or father|images the recent drafts/, "no lists of props and subjects to stay away from");
  assert.match(sent.system, /Central Bikol/);
  assert.match(sent.system, /Never name a real artist/);
  assert.match(sent.system, /production cue goes inside the tag/);
  const text = sent.messages[0].content;
  assert.match(text, /^Language: Bikol\nWhat happened, or what is on their mind: the boat my father fixed every summer\nWho it's for: my father\nHow it should feel: proud, a little sorry\n/);
  assert.match(text, /Their songs, newest first:\n\n1\. Harbour Lights \(made 2026-08-31\)\nSound: warm folk\nLyrics:\n\[Verse\]\nThe boats come home$/);
  assert.doesNotMatch(text, /2\. /, "an empty example is left out");
  assert.doesNotMatch(text, /Kape|Recent drafts/, "recent drafts no longer steer a song away");
});

test("/songlab takes an older app's idea as what happened; unsaid answers say so", async () => {
  const { sent } = await call("/songlab", { idea: "my father's boat", examples: EXAMPLES }, { fetchImpl: claude(DRAFT) });
  assert.match(sent.messages[0].content, /^Language: Like my songs\nWhat happened, or what is on their mind: my father's boat\nWho it's for: \(not said\)\nHow it should feel: \(not said\)\n/);
});

test("/songlab rewrites a draft with a change; an unknown language means like my songs", async () => {
  const { sent } = await call("/songlab", {
    language: "Klingon", examples: EXAMPLES,
    previous: { title: "Old", style: "folk", lyrics: "[Chorus]\nla la" }, change: "make the chorus catchier"
  }, { fetchImpl: claude(DRAFT) });
  assert.match(sent.messages[0].content, /^Language: Like my songs\n\nTheir songs/, "a draft from before the questions has no answers to send");
  assert.match(sent.messages[0].content, /Previous draft:\nTitle: Old\nStyle: folk\nLyrics:\n\[Chorus\]\nla la\n\nChange: make the chorus catchier$/);
});

test("/songlab refuses what it can't work from, before Claude is asked", async () => {
  const nothing = await call("/songlab", { examples: [] }, { fetchImpl: claude(DRAFT) });
  assert.equal(nothing.res.status, 400);
  // Songs to learn from aren't enough: it writes only from what they say.
  const noStory = await call("/songlab", { examples: EXAMPLES, who: "my son" }, { fetchImpl: claude(DRAFT) });
  assert.equal(noStory.res.status, 400);
  assert.match(noStory.json.error, /what happened/);
  const changeAlone = await call("/songlab", { what: "x", change: "shorter" }, { fetchImpl: claude(DRAFT) });
  assert.equal(changeAlone.res.status, 400);
  const stranger = await call("/songlab", { what: "x" }, { fetchImpl: claude(DRAFT), token: "wrong" });
  assert.equal(stranger.res.status, 401);
  assert.equal(nothing.calls.length + noStory.calls.length + changeAlone.calls.length + stranger.calls.length, 0);
});

test("/songlab says when Claude declines or sends no lyrics", async () => {
  const declined = await call("/songlab", { what: "x" }, { fetchImpl: async () => new Response(JSON.stringify({ stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] })) });
  assert.equal(declined.res.status, 502);
  assert.match(declined.json.error, /^Claude declined this one \(general_harms\)/);
  const empty = await call("/songlab", { what: "x" }, { fetchImpl: claude({ ...DRAFT, lyrics: "" }) });
  assert.equal(empty.res.status, 502);
  assert.match(empty.json.error, /no lyrics/);
});

test("/songlab/ideas offers three answers from their songs, leaving the facts to them", async () => {
  const ideas = [
    { what: "The thing you never thanked someone for", who: "someone who helped early", feel: "grateful" },
    { what: "", who: "dropped", feel: "dropped" },
    { what: "A habit you kept after you stopped needing it", who: "yourself", feel: "wry, warm" },
    { what: "The drive you take when you can't sleep", who: "yourself", feel: "restless" },
    { what: "A fourth", who: "", feel: "" }
  ];
  const { res, json, sent } = await call("/songlab/ideas", { examples: EXAMPLES, recent: ["Kape: a quiet morning", "", "Pauwi: going home"] }, { fetchImpl: claude({ ideas }) });
  assert.equal(res.status, 200);
  assert.deepEqual(json.ideas, [ideas[0], ideas[2], ideas[3]]);
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.output_config.effort, "medium");
  assert.deepEqual(sent.output_config.format.schema.required, ["ideas"]);
  assert.match(sent.system, /Never state facts about their life/);
  assert.match(sent.system, /they add the true details/);
  const text = sent.messages[0].content;
  assert.match(text, /^\nTheir songs, newest first:\n\n1\. Harbour Lights/);
  assert.match(text, /Drafted for them lately:\n- Kape: a quiet morning\n- Pauwi: going home$/);
});

test("/songlab/ideas needs songs to draw from, and says when none come back", async () => {
  const none = await call("/songlab/ideas", { examples: [] }, { fetchImpl: claude({ ideas: [] }) });
  assert.equal(none.res.status, 400);
  assert.equal(none.calls.length, 0);
  const empty = await call("/songlab/ideas", { examples: EXAMPLES }, { fetchImpl: claude({ ideas: [{ what: " ", who: "x", feel: "y" }] }) });
  assert.equal(empty.res.status, 502);
  assert.match(empty.json.error, /no ideas/);
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
