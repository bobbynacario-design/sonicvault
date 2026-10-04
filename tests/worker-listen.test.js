"use strict";
// The AI worker's /listen (share pages report plays and hearts) and
// /listens (the owner's summary), against a stand-in D1 and Firestore.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const BASE_ENV = { ANTHROPIC_API_KEY: "k", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example", FIRESTORE_PROJECT: "p" };

// Just enough of D1 for the statements the worker runs.
function fakeD1() {
  const rows = [];
  function exec(sql, args, mode) {
    if (sql.startsWith("INSERT")) {
      const kind = sql.includes("'play'") ? "play" : "heart";
      rows.push({ track: args[0], kind, visitor: args[1], at: args[2], pos: kind === "heart" ? args[3] : null });
      return { success: true };
    }
    if (sql.includes("SELECT 1 AS seen")) {
      const [visitor, track, since] = args;
      return rows.find((r) => r.visitor === visitor && r.track === track && r.kind === "play" && r.at > since) ? { seen: 1 } : null;
    }
    if (sql.includes("COUNT(*) AS n FROM events WHERE visitor")) {
      const [visitor, track, since] = args;
      return { n: rows.filter((r) => r.visitor === visitor && r.track === track && r.kind === "heart" && r.at > since).length };
    }
    if (sql.includes("GROUP BY track, kind")) {
      const [weekAgo] = args;
      const groups = {};
      rows.forEach((r) => {
        const g = groups[r.track + "|" + r.kind] = groups[r.track + "|" + r.kind] || { track: r.track, kind: r.kind, total: 0, week: 0, last: 0 };
        g.total++; if (r.at > weekAgo) g.week++; g.last = Math.max(g.last, r.at);
      });
      return Object.values(groups);
    }
    if (sql.includes("GROUP BY track, bucket")) {
      const groups = {};
      rows.filter((r) => r.kind === "heart").forEach((r) => {
        const b = Math.floor(r.pos / 5);
        const g = groups[r.track + "|" + b] = groups[r.track + "|" + b] || { track: r.track, bucket: b, n: 0 };
        g.n++;
      });
      return Object.values(groups);
    }
    throw new Error("unexpected SQL: " + sql);
  }
  const statement = (sql, args) => ({
    bind: (...more) => statement(sql, more),
    first: async () => exec(sql, args, "first"),
    run: async () => exec(sql, args, "run"),
    all: async () => ({ results: exec(sql, args, "all") })
  });
  return { rows, prepare: (sql) => statement(sql, []) };
}

async function call(route, body, { db, token, ip = "1.2.3.4", shared = ["song-1"] } = {}) {
  const worker = (await load()).default;
  globalThis.fetch = async (url) => {
    const id = decodeURIComponent(String(url).split("/").pop());
    return shared.includes(id) ? new Response(JSON.stringify({ fields: {} })) : new Response("", { status: 404 });
  };
  const headers = { Origin: "https://app.example", "Content-Type": "application/json", "CF-Connecting-IP": ip, "User-Agent": "test" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://w.example" + route, { method: "POST", headers, body: JSON.stringify(body) }), { ...BASE_ENV, LISTENS: db });
  return { res, json: JSON.parse(await res.text()) };
}

test("a share page's play counts once per visitor per half hour, with no token", async () => {
  const db = fakeD1();
  const first = await call("/listen", { id: "song-1", kind: "play" }, { db });
  assert.equal(first.res.status, 200);
  assert.equal(first.json.counted, true);
  const again = await call("/listen", { id: "song-1", kind: "play" }, { db });
  assert.equal(again.json.counted, false, "the same visitor straight away");
  const other = await call("/listen", { id: "song-1", kind: "play" }, { db, ip: "5.6.7.8" });
  assert.equal(other.json.counted, true, "someone else");
  assert.equal(db.rows.length, 2);
  assert.ok(db.rows.every((r) => !JSON.stringify(r).includes("1.2.3.4")), "no address is stored");
});

test("only songs that are really shared are counted", async () => {
  const db = fakeD1();
  const { res } = await call("/listen", { id: "private-song", kind: "play" }, { db });
  assert.equal(res.status, 404);
  assert.equal(db.rows.length, 0);
  const bad = await call("/listen", { id: "song-1", kind: "heart" }, { db });
  assert.equal(bad.res.status, 400, "a heart needs its moment");
});

test("hearts keep their moment and stop at twenty a day", async () => {
  const db = fakeD1();
  for (let i = 0; i < 22; i++) await call("/listen", { id: "song-1", kind: "heart", pos: 101.26 }, { db });
  assert.equal(db.rows.filter((r) => r.kind === "heart").length, 20);
  assert.equal(db.rows[0].pos, 101.3);
});

test("the owner's summary needs the token and sums each song", async () => {
  const db = fakeD1();
  await call("/listen", { id: "song-1", kind: "play" }, { db });
  await call("/listen", { id: "song-1", kind: "play" }, { db, ip: "9.9.9.9" });
  await call("/listen", { id: "song-1", kind: "heart", pos: 102 }, { db });
  await call("/listen", { id: "song-1", kind: "heart", pos: 103.5 }, { db, ip: "9.9.9.9" });
  await call("/listen", { id: "song-1", kind: "heart", pos: 30 }, { db });
  const stranger = await call("/listens", {}, { db });
  assert.equal(stranger.res.status, 401);
  const { json } = await call("/listens", {}, { db, token: "t" });
  const s = json.tracks["song-1"];
  assert.equal(s.plays, 2);
  assert.equal(s.playsWeek, 2);
  assert.equal(s.hearts, 3);
  assert.deepEqual(s.moments[0], { at: 100, hearts: 2 }, "the most loved five seconds first");
});
