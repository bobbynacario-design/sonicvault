"use strict";
// The AI worker's daily spend cap, against a fake Anthropic, a fake Gemini
// and a fake D1: no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const METADATA = '"aiGenre":"Pop","aiMood":"Warm","aiTheme":"Home","aiEnergy":"Medium","aiVocalStyle":"Lead","aiEra":"Modern","aiInstruments":["Guitar"],"aiTags":["home"],"aiSummary":"One. Two.","coverStyle":"tape","aiExplicit":false}';

// Just enough of D1 for the usage table: the create, and the counting upsert.
function fakeD1({ broken } = {}) {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async run() {
          if (broken) throw new Error("D1 is down");
          assert.match(sql, /^CREATE TABLE IF NOT EXISTS ai_usage/);
          return { success: true };
        },
        async first() {
          if (broken) throw new Error("D1 is down");
          assert.match(sql, /^INSERT INTO ai_usage .* RETURNING n$/);
          const [day, kind, weight] = args;
          const key = day + "|" + kind;
          rows.set(key, (rows.get(key) || 0) + weight);
          return { n: rows.get(key) };
        }
      };
      return statement;
    }
  };
}

async function call(route, body, env) {
  const worker = (await load()).default;
  const calls = { anthropic: 0, gemini: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).includes("anthropic")) {
      calls.anthropic++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: route === "/" ? METADATA : '{"story":"A story."}' }] }), { status: 200 });
    }
    calls.gemini++;
    return new Response(JSON.stringify({ error: { message: "stand-in", status: "UNAVAILABLE" } }), { status: 400 });
  };
  const loud = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.example" + route, {
      method: "POST",
      headers: { Origin: "https://app.example", Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), Object.assign({ ANTHROPIC_API_KEY: "k", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example" }, env));
    return { status: res.status, body: await res.json(), calls };
  } finally {
    console.error = loud;
  }
}

test("Claude calls stop for the day once the budget is spent, before Anthropic is called", async () => {
  const db = fakeD1();
  const env = { LISTENS: db, CLAUDE_DAILY_LIMIT: "3" };
  for (let i = 0; i < 3; i++) assert.equal((await call("/", { title: "Still In" }, env)).status, 200);
  const refused = await call("/", { title: "Still In" }, env);
  assert.equal(refused.status, 429);
  assert.equal(refused.calls.anthropic, 0);
  assert.equal(refused.body.dailyLimit, true);
  assert.match(refused.body.error, /^Today's Claude limit is used up/);
});

test("a bigger model costs ten times as much of the budget, whatever the app asks for", async () => {
  const db = fakeD1();
  const env = { LISTENS: db, CLAUDE_DAILY_LIMIT: "15" };
  assert.equal((await call("/", { title: "Still In", model: "claude-opus-5-5" }, env)).status, 200);
  assert.equal((await call("/", { title: "Still In", model: "claude-opus-5-5" }, env)).status, 429);
  // The story route uses Sonnet unless told otherwise: also 10.
  const story = await call("/story", { title: "Still In", lyrics: "words" }, { LISTENS: fakeD1(), CLAUDE_DAILY_LIMIT: "15" });
  assert.equal(story.status, 200);
  assert.deepEqual([...db.rows.values()], [20]);
});

test("Lyria songs have their own, smaller budget", async () => {
  const env = { LISTENS: fakeD1(), GEMINI_API_KEY: "g", LYRIA_DAILY_LIMIT: "1" };
  const first = await call("/generate", { style: "synthwave" }, env);
  assert.notEqual(first.status, 429);
  assert.equal(first.calls.gemini, 1);
  const second = await call("/generate", { style: "synthwave" }, env);
  assert.equal(second.status, 429);
  assert.equal(second.calls.gemini, 0);
  assert.match(second.body.error, /^Today's song-making limit is used up/);
});

test("if the count itself fails, the call still goes ahead", async () => {
  const res = await call("/", { title: "Still In" }, { LISTENS: fakeD1({ broken: true }), CLAUDE_DAILY_LIMIT: "1" });
  assert.equal(res.status, 200);
  assert.equal(res.calls.anthropic, 1);
});

test("with no token set, the paid routes are closed rather than open", async () => {
  const res = await call("/", { title: "Still In" }, { SONICVAULT_CLIENT_TOKEN: "" });
  assert.equal(res.status, 401);
  assert.equal(res.calls.anthropic, 0);
});
