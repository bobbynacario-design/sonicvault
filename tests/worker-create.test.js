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

test("a key without billing is told so in words, not quota metric names", async () => {
  const quota = (message) => gemini({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } }, 429);
  const free = await call("/generate", { style: "x" }, {
    env: { GEMINI_API_KEY: "g" },
    fetchImpl: quota("You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: lyria-3-pro\nPlease retry in 20h38m12s.")
  });
  assert.equal(free.res.status, 429);
  assert.match(JSON.parse(free.text).error, /free tier, which can't make songs\. Turn on billing/);
  assert.match(JSON.parse(free.text).details, /limit: 0/);

  const busy = await call("/generate", { style: "x" }, {
    env: { GEMINI_API_KEY: "g" },
    fetchImpl: quota("Quota exceeded for metric: requests_per_minute, limit: 10, model: lyria-3-pro")
  });
  assert.match(JSON.parse(busy.text).error, /Try again in a minute/);
});

test("an unavailable Lyria is tried once more, then reported as busy", async () => {
  const unavailable = () => new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "The service is currently unavailable." } }), { status: 503 });
  const answer = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mp3", data: "SUQz" } }] } }] };
  let n = 0;
  const recovered = await call("/generate", { style: "x" }, {
    env: { GEMINI_API_KEY: "g" },
    fetchImpl: async () => (n++ === 0 ? unavailable() : new Response(JSON.stringify(answer), { status: 200 }))
  });
  assert.equal(recovered.res.status, 200);
  assert.equal(recovered.calls.length, 2);

  const down = await call("/generate", { style: "x" }, { env: { GEMINI_API_KEY: "g" }, fetchImpl: async () => unavailable() });
  assert.equal(down.calls.length, 2);
  assert.equal(down.res.status, 502);
  assert.equal(JSON.parse(down.text).error, "Lyria is busy right now. Try again in a minute.");
});

test("over-long input is refused before Google is asked", async () => {
  const { res, calls } = await call("/generate", { style: "x".repeat(1001) }, { env: { GEMINI_API_KEY: "g" } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("/lyrics writes in the songwriter's voice, from their songs, and keeps the given title", async () => {
  const claude = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: '{"title":"Invented","lyrics":"[Verse 1]\\nOut on the water"}' }]
  }), { status: 200 });
  const examples = [{ title: "Pauwi", made: "2026-10-04", sound: "indie folk", lyrics: "[Verse 1]\nThe bus leaves at eleven" }];
  const { res, text, calls } = await call("/lyrics", { title: "Harbour", style: "folk", draft: "", examples }, { fetchImpl: claude });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { title: "Harbour", lyrics: "[Verse 1]\nOut on the water" });
  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.system, /\[Verse 1\]/);
  assert.match(sent.messages[0].content, /Title:\nHarbour/);
  assert.equal(sent.model, "claude-sonnet-5-5", "lyrics are writing: the writing model");
  assert.equal(sent.output_config.effort, "high");
  assert.match(sent.system, /They show how they write now/);
  assert.match(sent.system, /Never invent relatives/, "a sheet makes nothing up either");
  assert.match(sent.messages[0].content, /\n\nAbout me:\n\(not written yet\)\n/);
  assert.match(sent.system, /no stage directions/);
  assert.match(sent.messages[0].content, /Their songs, newest first:\n\n1\. Pauwi \(made 2026-10-04\)\nSound: indie folk\nLyrics:\n\[Verse 1\]\nThe bus leaves at eleven/);
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.messages.length, 1, "no started reply");
  assert.deepEqual(sent.output_config.format.schema.required, ["title", "lyrics"]);

  const untitled = await call("/lyrics", { style: "folk" }, { fetchImpl: claude });
  assert.equal(JSON.parse(untitled.text).title, "Invented");

  const empty = await call("/lyrics", {}, { fetchImpl: claude });
  assert.equal(empty.res.status, 400);
});

test("/cover paints the title as a scene, never as a name to letter", async () => {
  let asked;
  const ai = { run: async (model, input) => { asked = { model, input }; return { image: "/9j/AAAA" }; } };
  const { res, text } = await call("/cover", { title: "Harbour Lights", style: "warm folk" }, { ai });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/jpeg", image: "/9j/AAAA" });
  assert.equal(asked.model, "@cf/black-forest-labs/flux-1-schnell");
  assert.match(asked.input.prompt, /warm folk/);
  assert.match(asked.input.prompt, /No text/);
  assert.match(asked.input.prompt, /a scene of harbour lights/);
  assert.doesNotMatch(asked.input.prompt, /Harbour Lights|album cover/);

  const failing = await call("/cover", { title: "x" }, { ai: { run: async () => { throw new Error("capacity"); } } });
  assert.equal(failing.res.status, 502);
});

// FLUX.2 takes multipart form data: read the fields back the way the model
// would.
async function multipartFields(input) {
  const form = await new Response(input.multipart.body, { headers: { "Content-Type": input.multipart.contentType } }).formData();
  return Object.fromEntries(form.entries());
}

test("/release-cover asks FLUX.2 [klein] for a 1536 square, as a form, with no lettering", async () => {
  let asked;
  const ai = { run: async (model, input) => { asked = { model, fields: await multipartFields(input) }; return { image: "iVBORw0KGgo" }; } };
  const { res, text } = await call("/release-cover", { title: "Pauwi", scene: "a long road home at dusk", style: "acoustic folk", look: "photo", seed: 42 }, { ai });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { model: "@cf/black-forest-labs/flux-2-klein-9b", mime: "image/png", image: "iVBORw0KGgo", size: 1536, seed: 42 });
  assert.equal(asked.model, "@cf/black-forest-labs/flux-2-klein-9b");
  assert.equal(asked.fields.width, "1536");
  assert.equal(asked.fields.height, "1536");
  assert.equal(asked.fields.seed, "42");
  assert.match(asked.fields.prompt, /a cinematic photograph, with no text in it: a long road home at dusk\./);
  assert.match(asked.fields.prompt, /acoustic folk/);
  assert.match(asked.fields.prompt, /no signature/);
  assert.doesNotMatch(asked.fields.prompt, /Pauwi/, "the title is set by the app, not painted");
});

test("/release-cover falls back to a scene of the title, a painting and a seed of its own", async () => {
  let fields;
  const ai = { run: async (model, input) => { fields = await multipartFields(input); return { image: "/9j/AAAA" }; } };
  const { res, text } = await call("/release-cover", { title: "Still In", look: "neon", seed: -3 }, { ai });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(text).mime, "image/jpeg");
  assert.match(fields.prompt, /a rich oil painting, with no text in it: a scene of still in\./);
  assert.ok(Number(fields.seed) >= 0, "a seed out of range is replaced");
  const empty = await call("/release-cover", { scene: "", title: "" }, { ai });
  assert.equal(empty.res.status, 400);
});

test("/release-cover says plainly when Cloudflare's free daily allowance is spent", async () => {
  const spent = { run: async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); } };
  const out = await call("/release-cover", { title: "x" }, { ai: spent });
  assert.equal(out.res.status, 429);
  assert.match(JSON.parse(out.text).error, /free AI allowance for today is used up/);
  assert.equal(JSON.parse(out.text).dailyLimit, true);
  const broken = await call("/release-cover", { title: "x" }, { ai: { run: async () => { throw new Error("3043: Internal server error"); } } });
  assert.equal(broken.res.status, 502);
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

test("/embed turns texts into vectors with BGE-M3, a few at a time", async () => {
  let asked;
  const ai = { run: async (model, input) => { asked = { model, input }; return { shape: [input.text.length, 3], data: input.text.map((_, i) => [i, 0.5, -1]) }; } };
  const { res, text } = await call("/embed", { texts: ["the one about my brother", "rain"] }, { ai });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { model: "@cf/baai/bge-m3", vectors: [[0, 0.5, -1], [1, 0.5, -1]] });
  assert.equal(asked.model, "@cf/baai/bge-m3");
  assert.deepEqual(asked.input, { text: ["the one about my brother", "rain"] });

  const tooMany = await call("/embed", { texts: new Array(17).fill("x") }, { ai });
  assert.equal(tooMany.res.status, 400);
  const empty = await call("/embed", { texts: ["ok", "  "] }, { ai });
  assert.equal(empty.res.status, 400);
  const short = await call("/embed", { texts: ["a"] }, { ai: { run: async () => ({ data: [] }) } });
  assert.equal(short.res.status, 502);
});
