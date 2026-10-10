"use strict";
// The worker's cost ledger: what each paid call records, and /costs reading
// it back -- against stand-ins for Claude, Gemini and Workers AI, with the
// ledger's own SQL run in SQLite (node:sqlite) rather than a fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);

// Just enough of D1, over a real SQLite database: prepare, bind, run, first, all.
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args).map((row) => ({ ...row })) }; }
      };
      return statement;
    }
  };
}

// One ledger for the file: the worker makes its tables once per process.
const D1 = sqliteD1();
const ENV = { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example", LISTENS: D1 };

async function call(route, body, { fetchImpl, ai, token = "t" } = {}) {
  const worker = (await load()).default;
  globalThis.fetch = fetchImpl || (async () => new Response("{}", { status: 500 }));
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.example" + route, {
      method: "POST",
      headers: { Origin: "https://app.example", Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), { ...ENV, ...(ai ? { AI: ai } : {}) });
    return { res, text: await res.text() };
  } finally {
    console.error = quiet;
  }
}

const claude = (text, usage) => async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }], usage }));
const METADATA = '{"aiGenre":"Pop","aiMood":"Warm","aiTheme":"Home","aiEnergy":"Medium","aiVocalStyle":"Lead","aiEra":"Modern","aiInstruments":["Guitar"],"aiTags":["home"],"aiSummary":"One. Two.","coverStyle":"tape","aiExplicit":false}';

async function ledger() {
  const { res, text } = await call("/costs", {});
  assert.equal(res.status, 200);
  return JSON.parse(text);
}
const line = (data, feature) => data.rows.find((row) => row.feature === feature);

test("a described song records Claude's tokens, cache reads and writes, per day, feature and model", async () => {
  const usage = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 };
  await call("/", { title: "Still In" }, { fetchImpl: claude(METADATA, usage) });
  await call("/", { title: "Still In" }, { fetchImpl: claude(METADATA, usage) });
  const data = await ledger();
  const row = line(data, "describe");
  assert.equal(row.model, "claude-haiku-5-5");
  assert.equal(row.day, data.today);
  assert.deepEqual([row.calls, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens], [2, 1800, 600, 4000, 1000]);
});

test("a prompt over 100K tokens on Haiku 5.5 is kept on its own rate card", async () => {
  await call("/ask", { question: "q", catalog: "[t-1] A" }, {
    fetchImpl: claude('{"answer":"A.","songs":[],"action":"none","playlistName":""}', { input_tokens: 90000, output_tokens: 50, cache_read_input_tokens: 15000 })
  });
  const row = line(await ledger(), "ask");
  assert.equal(row.model, "claude-haiku-5-5/over-100k");
  assert.equal(row.input_tokens, 90000);
});

test("Song lab records on the writing model; a failed call records nothing", async () => {
  const draft = '{"title":"T","style":"folk","lyrics":"[Verse]\\nla","about":"a"}';
  await call("/songlab", { idea: "x" }, { fetchImpl: claude(draft, { input_tokens: 3000, output_tokens: 2400 }) });
  await call("/songlab", { idea: "x" }, { fetchImpl: async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } }), { status: 400 }) });
  const row = line(await ledger(), "song-lab");
  assert.deepEqual([row.model, row.calls, row.output_tokens], ["claude-sonnet-5-5", 1, 2400]);
});

test("Workers AI records the neurons it reports, and its units", async () => {
  const ai = {
    run: async (model) => {
      if (/flux/.test(model)) return { image: "/9j/AAAA", usage: { neurons: 249.6 } };
      if (/bge/.test(model)) return { data: [[0.1], [0.2]], shape: [2, 1], meta: { cost_metric_name_1: "input_tokens", cost_metric_value_1: 26, neurons: 0.028 } };
      return { transcription_info: { duration: 180, language: "en" }, segments: [], usage: { neurons: 139.89 } };
    }
  };
  await call("/cover", { title: "Harbour" }, { ai });
  await call("/embed", { texts: ["a", "b"] }, { ai });
  const audio = async () => new Response(new Uint8Array(10), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  await call("/transcribe", { audioURL: "https://res.cloudinary.com/dtw4em0ob/video/upload/x.mp3" }, { ai, fetchImpl: audio });
  const data = await ledger();
  assert.deepEqual([line(data, "cover").units, line(data, "cover").neurons], [1, 249.6]);
  assert.deepEqual([line(data, "embed").units, line(data, "embed").neurons], [26, 0.028]);
  assert.deepEqual([line(data, "transcribe").units, line(data, "transcribe").neurons], [180, 139.89]);
});

test("a Lyria song that comes back is one song on the ledger", async () => {
  await call("/generate", { style: "folk" }, { fetchImpl: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }) });
  const row = line(await ledger(), "lyria");
  assert.deepEqual([row.model, row.units, row.calls], ["lyria-3.5", 1, 1]);
});

test("/costs reports today's spend cap, and is closed without the token", async () => {
  const data = await ledger();
  assert.equal(data.budget.claude.limit, 1000);
  assert.ok(data.budget.claude.used >= 4, "the calls above were counted against the cap");
  assert.equal(data.budget.lyria.used, 1);
  const stranger = await call("/costs", {}, { token: "wrong" });
  assert.equal(stranger.res.status, 401);
});
