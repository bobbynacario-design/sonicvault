"use strict";
// The AI worker's public share-preview routes (cloudflare-worker/share.js),
// run in Node against a stubbed fetch: no network, no Cloudflare.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const load = (rel) => import("file://" + path.join(ROOT, rel).replace(/\\/g, "/"));

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
function mp3WithCover() {
  const apic = [0, ...ascii("image/jpeg"), 0, 3, 0, ...JPEG];
  const frame = [...ascii("APIC"), ...syncsafe(apic.length), 0, 0, ...apic];
  const body = [...frame, ...new Array(16).fill(0)];
  return Uint8Array.from([...ascii("ID3"), 4, 0, 0, ...syncsafe(body.length), ...body, 0xff, 0xfb, 0x90, 0x64]);
}

// A Firestore REST document, typed the way the API returns it.
function typed(value) {
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(typed) } };
  if (typeof value === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typed(v)])) } };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: value };
}
const firestoreDoc = (obj) => ({ name: "x", fields: typed(obj).mapValue.fields });

const AUDIO = "https://res.cloudinary.com/dtw4em0ob/video/upload/sonicvault-bob/audio/t-1.mp3";
const SHARES = {
  "sonicvault-public-tracks/t-1": { id: "t-1", kind: "track", title: "Still In <b>", genre: "Country", mood: "Warm", duration: 249, audioURL: AUDIO, aiSummary: "A song about staying in the game." },
  "sonicvault-public-playlists/pl-1": { id: "pl-1", kind: "playlist", name: "Late Night Drives", desc: "Midnight coding", trackIds: ["t-1", "t-2"], tracks: [{ id: "t-1", audioURL: AUDIO, duration: 200 }, { id: "t-2", duration: 100 }] },
};
function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    calls.push({ url, range: opts && opts.headers && opts.headers.Range });
    const m = /documents\/(sonicvault-public-[a-z]+\/[^?]+)/.exec(url);
    if (m) {
      const data = SHARES[decodeURIComponent(m[1])];
      return data ? new Response(JSON.stringify(firestoreDoc(data)), { status: 200 }) : new Response("{}", { status: 404 });
    }
    if (url.startsWith(AUDIO)) return new Response(mp3WithCover(), { status: 206 });
    if (url.endsWith("/assets/icons/icon-512.png")) return new Response(new Uint8Array([0x89, 0x50]), { status: 200 });
    throw new Error("unexpected fetch " + url);
  };
  return calls;
}
const ENV = { SHARE_APP_URL: "https://bobbynacario-design.github.io/sonicvault", FIRESTORE_PROJECT: "pokerhq-a67e4" };
const get = async (share, p) => share.handleShareRoute(new Request("https://w.example" + p), ENV, new URL("https://w.example" + p));

test("the worker's ID3 parser is the app's, line for line", () => {
  const app = fs.readFileSync(path.join(ROOT, "js/data/artwork.js"), "utf8").replace(/\r\n/g, "\n");
  const worker = fs.readFileSync(path.join(ROOT, "cloudflare-worker/id3.js"), "utf8").replace(/\r\n/g, "\n");
  const copied = /\/\/ BEGIN copied from js\/data\/artwork\.js\n([\s\S]*?)\/\/ END copied/.exec(worker);
  assert.ok(copied, "id3.js has its BEGIN/END markers");
  const start = app.indexOf("function readSyncsafe");
  const end = app.indexOf("// ID3 text in its declared encoding");
  assert.equal(copied[1].trimEnd(), app.slice(start, end).trimEnd(), "re-copy the block from js/data/artwork.js");
});

test("Firestore REST values decode to plain JSON", async () => {
  const share = await load("cloudflare-worker/share.js");
  const obj = { a: "x", n: 3, f: 1.5, b: true, z: null, list: [1, { k: "v" }], m: { deep: ["y"] } };
  assert.deepEqual(share.decodeFirestoreFields(firestoreDoc(obj).fields), obj);
});

test("a shared track previews with its title, cover and summary; people are sent to the app", async () => {
  const share = await load("cloudflare-worker/share.js");
  stubFetch();
  const res = await get(share, "/s/track/t-1");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /<meta property="og:title" content="Still In &lt;b&gt;">/);
  assert.match(html, /og:description" content="A song about staying in the game\. \(Country · Warm · 4:09\)"/);
  assert.match(html, /og:image" content="https:\/\/w\.example\/s\/art\/track\/t-1"/);
  assert.match(html, /og:url" content="https:\/\/w\.example\/s\/track\/t-1"/);
  assert.match(html, /location\.replace\("https:\/\/bobbynacario-design\.github\.io\/sonicvault\/\?sv-route=%2Ftrack%2Ft-1"\)/);
  assert.doesNotMatch(html, /<b>/, "titles are escaped");
});

test("the cover route serves the art embedded in the MP3, read with a ranged request", async () => {
  const share = await load("cloudflare-worker/share.js");
  const calls = stubFetch();
  const res = await get(share, "/s/art/track/t-1");
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], JPEG);
  assert.equal(calls.find((c) => c.url === AUDIO).range, "bytes=0-65535");
});

test("a playlist previews with its track count and its first track's cover", async () => {
  const share = await load("cloudflare-worker/share.js");
  stubFetch();
  const html = await (await get(share, "/s/playlist/pl-1")).text();
  assert.match(html, /og:title" content="Late Night Drives"/);
  assert.match(html, /og:description" content="Midnight coding — 2 tracks · 5:00"/);
  const art = await get(share, "/s/art/playlist/pl-1");
  assert.equal(art.headers.get("Content-Type"), "image/jpeg");
});

test("a revoked link says so, and anything else is refused", async () => {
  const share = await load("cloudflare-worker/share.js");
  stubFetch();
  const gone = await get(share, "/s/track/t-gone");
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /isn’t shared anymore/);
  // no cover to read: the app icon stands in
  assert.equal((await get(share, "/s/art/track/t-gone")).headers.get("Content-Type"), "image/png");
  for (const bad of ["/s/secret/t-1", "/s/track/../x", "/s/track/a%2Fb", "/s/track/t-1/extra", "/s/art/track"]) {
    assert.equal((await get(share, bad)).status, 404, bad);
  }
});

test("only the vault's own Cloudinary audio is ever read for a cover", async () => {
  const share = await load("cloudflare-worker/share.js");
  assert.equal(share.coverSourceURL("track", { audioURL: "https://evil.example/a.mp3" }), "");
  assert.equal(share.coverSourceURL("track", { audioURL: AUDIO }), AUDIO);
  assert.equal(share.coverSourceURL("playlist", { tracks: [{ audioURL: "http://res.cloudinary.com/dtw4em0ob/x" }, { audioURL: AUDIO }] }), AUDIO);
});

test("the share-only worker serves previews, sends the bare domain to the app, and nothing else", async () => {
  const worker = (await load("cloudflare-worker/share-worker.js")).default;
  stubFetch();
  const call = (p, method) => worker.fetch(new Request("https://share.example" + p, { method: method || "GET" }), ENV);
  const page = await call("/s/track/t-1");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /og:url" content="https:\/\/share\.example\/s\/track\/t-1"/);
  const root = await call("/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("Location"), "https://bobbynacario-design.github.io/sonicvault/");
  // None of the AI worker's routes exist here.
  assert.equal((await call("/transcribe", "POST")).status, 404);
  assert.equal((await call("/", "POST")).status, 404);
  assert.equal((await call("/anything")).status, 404);
});
