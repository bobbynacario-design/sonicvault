// Web Push from the worker, with nothing but WebCrypto: the message is
// encrypted for the one browser it goes to (RFC 8291, aes128gcm) and the
// request is signed with this worker's VAPID key (RFC 8292), so the browser's
// push service (Google's, Mozilla's, Apple's, Microsoft's) accepts it.

const enc = new TextEncoder();

export function b64urlToBytes(text) {
  const b64 = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// Only real browser push services: the worker must never be made to post to
// any other address.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/
];

export function isPushEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (err) { return false; }
  return url.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

// The body for one browser: salt, record size, this message's own public
// key, then the payload encrypted with a key only that browser can derive.
export async function encryptPayload(payload, p256dh, auth) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// "vapid t=<signed JWT>, k=<public key>": proof to the push service that the
// message comes from the holder of this key.
export async function vapidAuthorization(endpoint, privateJwk, publicKey, subject) {
  const aud = new URL(endpoint).origin;
  const head = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", Object.assign({ ext: true }, privateJwk, { key_ops: ["sign"] }), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + bytesToB64url(sig) + ", k=" + publicKey;
}

// Sends one message; resolves with the push service's status (201 sent; 404
// or 410 means the browser has gone and the follower should be dropped).
export async function sendPush(subscription, payload, vapid) {
  if (!isPushEndpoint(subscription.endpoint)) return 400;
  const body = await encryptPayload(payload, subscription.p256dh, subscription.auth);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "604800",
      Urgency: "normal",
      Authorization: await vapidAuthorization(subscription.endpoint, vapid.privateJwk, vapid.publicKey, vapid.subject)
    },
    body
  });
  return response.status;
}
