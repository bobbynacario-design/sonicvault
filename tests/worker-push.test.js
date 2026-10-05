"use strict";
// Web Push from the worker: a message only the subscribing browser can read
// (decrypted here the way a browser would, RFC 8291), a signed VAPID header,
// and no posting to anything but a real push service.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "cloudflare-worker", "push.js")).href);
const { subtle } = globalThis.crypto;

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; parts.forEach((p) => { out.set(p, at); at += p.length; }); return out; };

// A browser's side: its key pair and auth secret, and how it opens a message.
async function fakeBrowser(push) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    p256dh: push.bytesToB64url(pub),
    auth: push.bytesToB64url(auth),
    async open(body) {
      const salt = body.slice(0, 16);
      const idlen = body[20];
      const asPublic = body.slice(21, 21 + idlen);
      const cipher = body.slice(21 + idlen);
      const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, pair.privateKey, 256));
      const te = new TextEncoder();
      const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), pub, asPublic), 32);
      const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
      const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
      assert.equal(plain[plain.length - 1], 2, "the last-record delimiter");
      return new TextDecoder().decode(plain.slice(0, -1));
    }
  };
}

test("only the subscribing browser can read the message", async () => {
  const push = await load();
  const browser = await fakeBrowser(push);
  const message = JSON.stringify({ title: "Still In", body: "A new song. Tap to listen." });
  const body = await push.encryptPayload(message, browser.p256dh, browser.auth);
  assert.equal(new DataView(body.buffer).getUint32(16), 4096, "record size");
  assert.equal(await browser.open(body), message);
  const stranger = await fakeBrowser(push);
  await assert.rejects(stranger.open(body), "another browser cannot open it");
});

test("the VAPID header is a JWT the public key verifies", async () => {
  const push = await load();
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const publicKey = push.bytesToB64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const header = await push.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", jwk, publicKey, "https://app.example");
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, publicKey);
  const [head, body, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "https://app.example");
  assert.ok(claims.exp > Date.now() / 1000);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(head + "." + body));
  assert.ok(ok);
});

test("messages only ever go to real push services", async () => {
  const push = await load();
  assert.ok(push.isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(push.isPushEndpoint("https://web.push.apple.com/QH123"));
  assert.ok(push.isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
  assert.ok(push.isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x"));
  assert.ok(!push.isPushEndpoint("https://evil.example/fcm.googleapis.com"));
  assert.ok(!push.isPushEndpoint("http://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(!push.isPushEndpoint("https://fcm.googleapis.com.evil.example/x"));
  assert.ok(!push.isPushEndpoint("not a url"));
});
