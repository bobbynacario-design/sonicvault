"use strict";
// The AI worker's followers: /follow and /unfollow from share pages,
// /followers and /notify for the owner, against a stand-in D1, Firestore
// and push service.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "worker.js")).href);
const { subtle } = globalThis.crypto;
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

function fakeD1() {
  const rows = [];
  let nextId = 1;
  function exec(sql, args) {
    if (sql.startsWith("SELECT COUNT(*) AS n FROM followers")) return { n: rows.length };
    if (sql.startsWith("SELECT 1 AS known")) return rows.find((r) => r.endpoint === args[0]) ? { known: 1 } : null;
    if (sql.startsWith("INSERT INTO followers")) {
      const [endpoint, p256dh, auth, at] = args;
      const row = rows.find((r) => r.endpoint === endpoint);
      if (row) Object.assign(row, { p256dh, auth, at });
      else rows.push({ id: nextId++, endpoint, p256dh, auth, at });
      return {};
    }
    if (sql.startsWith("DELETE FROM followers WHERE endpoint")) { const i = rows.findIndex((r) => r.endpoint === args[0]); if (i >= 0) rows.splice(i, 1); return {}; }
    if (sql.startsWith("DELETE FROM followers WHERE id")) { const i = rows.findIndex((r) => r.id === args[0]); if (i >= 0) rows.splice(i, 1); return {}; }
    if (sql.startsWith("SELECT id, endpoint")) return rows.filter((r) => r.id > args[0]).sort((a, b) => a.id - b.id).slice(0, args[1]);
    throw new Error("unexpected SQL: " + sql);
  }
  const statement = (sql, args) => ({
    bind: (...more) => statement(sql, more),
    first: async () => exec(sql, args),
    run: async () => exec(sql, args),
    all: async () => ({ results: exec(sql, args) })
  });
  return { rows, prepare: (sql) => statement(sql, []) };
}

async function subscription(name) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { endpoint: "https://fcm.googleapis.com/fcm/send/" + name, keys: { p256dh: b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

async function vapidEnv() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  return { VAPID_PRIVATE_KEY: jwk.d, VAPID_PUBLIC_KEY: b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))) };
}

async function call(route, body, { db, token, env = {}, pushStatus = () => 201, pushed = [] } = {}) {
  const worker = (await load()).default;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("firestore.googleapis.com")) return u.endsWith("/song-1") ? new Response(JSON.stringify({ fields: {} })) : new Response("", { status: 404 });
    pushed.push({ url: u, headers: init.headers });
    return new Response("", { status: pushStatus(u) });
  };
  const headers = { Origin: "https://app.example", "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://w.example" + route, { method: "POST", headers, body: JSON.stringify(body) }),
    { ANTHROPIC_API_KEY: "k", SONICVAULT_CLIENT_TOKEN: "t", ALLOWED_ORIGIN: "https://app.example", LISTENS: db, ...env });
  return { res, json: JSON.parse(await res.text()) };
}

test("a share page can follow and unfollow without a token, once per browser", async () => {
  const db = fakeD1();
  const sub = await subscription("a");
  assert.equal((await call("/follow", { subscription: sub }, { db })).res.status, 200);
  assert.equal((await call("/follow", { subscription: sub }, { db })).res.status, 200);
  assert.equal(db.rows.length, 1, "following again doesn't add a second");
  await call("/unfollow", { endpoint: sub.endpoint }, { db });
  assert.equal(db.rows.length, 0);
});

test("only real push subscriptions are kept", async () => {
  const db = fakeD1();
  const sub = await subscription("a");
  const evil = { ...sub, endpoint: "https://evil.example/collect" };
  assert.equal((await call("/follow", { subscription: evil }, { db })).res.status, 400);
  const badKeys = { endpoint: sub.endpoint, keys: { p256dh: "AAAA", auth: "AAAA" } };
  assert.equal((await call("/follow", { subscription: badKeys }, { db })).res.status, 400);
  assert.equal(db.rows.length, 0);
});

test("the owner's notice goes to every follower, drops the gone, and comes in batches", async () => {
  const db = fakeD1();
  const env = await vapidEnv();
  for (let i = 0; i < 45; i++) await call("/follow", { subscription: await subscription("f" + i) }, { db });
  assert.equal((await call("/followers", {}, { db, token: "t", env })).json.count, 45);
  assert.equal((await call("/notify", { id: "song-1" }, { db })).res.status, 401, "needs the token");
  assert.equal((await call("/notify", { id: "private" }, { db, token: "t", env })).res.status, 400, "only shared songs");
  const pushed = [];
  const gone = (url) => (url.endsWith("/f3") ? 410 : 201);
  const first = await call("/notify", { id: "song-1", title: "Still In", body: "New from Bobby", url: "https://x/s/track/song-1" }, { db, token: "t", env, pushStatus: gone, pushed });
  assert.deepEqual([first.json.sent, first.json.removed], [39, 1]);
  assert.ok(first.json.next, "more to send");
  assert.match(pushed[0].headers.Authorization, /^vapid t=.+, k=/);
  assert.equal(pushed[0].headers["Content-Encoding"], "aes128gcm");
  const second = await call("/notify", { id: "song-1", after: first.json.next }, { db, token: "t", env, pushed });
  assert.equal(second.json.sent, 5);
  assert.equal(second.json.next, null);
  assert.equal(db.rows.length, 44, "the gone browser was dropped");
});

test("without the VAPID key the worker says notices aren't set up", async () => {
  const { res } = await call("/notify", { id: "song-1" }, { db: fakeD1(), token: "t" });
  assert.equal(res.status, 503);
});
