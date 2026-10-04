// Share-link previews. Link-preview bots (Facebook, WhatsApp, X, iMessage,
// Discord...) read a page's Open Graph tags without running its JavaScript,
// and the app's own /track/:id URLs exist only as a GitHub Pages 404 that
// redirects in script -- so a pasted link previewed as "SonicVault
// Redirect" with no picture. These public routes answer instead:
//
//   GET /s/track/:id         a page with the track's title, description and
//   GET /s/playlist/:id      cover in its meta tags; people are sent on to
//                            the app by script, bots stop here
//   GET /s/art/:kind/:id     the cover itself, read from the MP3's ID3 tag
//
// They read only the world-readable share records the app publishes
// (sonicvault-public-*), through Firestore's REST API with no credentials,
// so nothing private is reachable from here. No token, no origin check:
// a preview bot has neither.

import { id3TagLength, findEmbeddedArt } from "./id3.js";

const KINDS = { track: "sonicvault-public-tracks", playlist: "sonicvault-public-playlists" };
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const AUDIO_PREFIX = "https://res.cloudinary.com/dtw4em0ob/";
const HEAD_BYTES = 65536;
const MAX_TAG_BYTES = 1024 * 1024;
const DEFAULT_APP_URL = "https://bobbynacario-design.github.io/sonicvault";
const DEFAULT_PROJECT = "pokerhq-a67e4";

// ── Firestore REST ──────────────────────────────────────────────────────
// Documents come back as typed values ({ stringValue: "..." }); this turns
// one back into plain JSON.
export function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return !!value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ("mapValue" in value) return decodeFirestoreFields(value.mapValue.fields || {});
  return null;
}

export function decodeFirestoreFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach(function (key) { out[key] = decodeFirestoreValue(fields[key]); });
  return out;
}

// The public share record, null when there is none (never shared, or the
// link was revoked). Throws on any other failure.
export async function readShare(env, kind, id) {
  const project = env.FIRESTORE_PROJECT || DEFAULT_PROJECT;
  const url = "https://firestore.googleapis.com/v1/projects/" + project
    + "/databases/(default)/documents/" + KINDS[kind] + "/" + encodeURIComponent(id);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Firestore " + response.status);
  const doc = await response.json();
  return decodeFirestoreFields(doc.fields || {});
}

// ── Page ───────────────────────────────────────────────────────────────
function escapeHTML(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function clip(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : value;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Where a person following the link should land: the app's own share page,
// straight through the route its 404 redirect would have produced.
export function appTarget(appURL, kind, id) {
  return appURL.replace(/\/+$/, "") + "/?sv-route=" + encodeURIComponent("/" + kind + "/" + id);
}

// What the preview shows, from a share record (or null when there is none).
export function describeShare(kind, data) {
  if (!data) {
    return {
      title: kind === "playlist" ? "Playlist not available" : "Track not available",
      description: "This SonicVault link isn’t shared anymore.",
      found: false
    };
  }
  if (kind === "playlist") {
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    const count = Array.isArray(data.trackIds) && data.trackIds.length ? data.trackIds.length : tracks.length;
    const length = Number(data.totalDuration) || tracks.reduce(function (sum, t) { return sum + (Number(t && t.duration) || 0); }, 0);
    const facts = count + (count === 1 ? " track" : " tracks") + (length ? " · " + formatTime(length) : "");
    return {
      title: clip(data.name || "Playlist", 90),
      description: clip(data.desc ? data.desc + " — " + facts : "A playlist on SonicVault · " + facts, 200),
      found: true
    };
  }
  const facts = [data.genre, data.mood, data.duration ? formatTime(data.duration) : ""].filter(Boolean).join(" · ");
  const blurb = data.aiSummary || data.prompt || "";
  return {
    title: clip(data.title || "Untitled track", 90),
    description: clip(blurb ? blurb + (facts ? " (" + facts + ")" : "") : (facts ? facts + " — on SonicVault" : "A track on SonicVault"), 200),
    found: true
  };
}

export function buildSharePage(info) {
  const title = escapeHTML(info.title);
  const description = escapeHTML(info.description);
  const target = escapeHTML(info.target);
  return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>" + title + " · SonicVault</title>"
    + "<meta name=\"description\" content=\"" + description + "\">"
    + "<meta property=\"og:site_name\" content=\"SonicVault\">"
    + "<meta property=\"og:type\" content=\"website\">"
    + "<meta property=\"og:title\" content=\"" + title + "\">"
    + "<meta property=\"og:description\" content=\"" + description + "\">"
    + "<meta property=\"og:url\" content=\"" + escapeHTML(info.url) + "\">"
    + "<meta property=\"og:image\" content=\"" + escapeHTML(info.image) + "\">"
    + "<meta property=\"og:image:alt\" content=\"Cover of " + title + "\">"
    + "<meta name=\"twitter:card\" content=\"summary\">"
    + "<meta name=\"twitter:title\" content=\"" + title + "\">"
    + "<meta name=\"twitter:description\" content=\"" + description + "\">"
    + "<meta name=\"twitter:image\" content=\"" + escapeHTML(info.image) + "\">"
    + "<link rel=\"canonical\" href=\"" + escapeHTML(info.url) + "\">"
    // People go straight on to the app. Bots do not run script, so they stay
    // here and read the tags above.
    + "<script>location.replace(" + JSON.stringify(info.target).replace(/</g, "\\u003c") + ")</script>"
    + "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05060c;color:#f7f2eb;font:16px system-ui,sans-serif}a{color:inherit}</style>"
    + "</head><body><p><a href=\"" + target + "\">Open “" + title + "” in SonicVault</a></p></body></html>";
}

// ── Cover ──────────────────────────────────────────────────────────────
// The audio file the cover is read from: the track's own, or a playlist's
// first track's. Only the vault's Cloudinary folder.
export function coverSourceURL(kind, data) {
  if (!data) return "";
  const candidates = kind === "playlist" ? (Array.isArray(data.tracks) ? data.tracks : []).map(function (t) { return t && t.audioURL; }) : [data.audioURL];
  return candidates.find(function (url) { return typeof url === "string" && url.indexOf(AUDIO_PREFIX) === 0; }) || "";
}

async function readAudioHead(url) {
  const first = await fetch(url, { headers: { Range: "bytes=0-" + (HEAD_BYTES - 1) } });
  if (!first.ok) throw new Error("audio " + first.status);
  let bytes = new Uint8Array(await first.arrayBuffer());
  const need = Math.min(id3TagLength(bytes), MAX_TAG_BYTES);
  if (first.status === 206 && need > bytes.length) {
    const rest = await fetch(url, { headers: { Range: "bytes=" + bytes.length + "-" + (need - 1) } });
    if (rest.status === 206) {
      const tail = new Uint8Array(await rest.arrayBuffer());
      const joined = new Uint8Array(bytes.length + tail.length);
      joined.set(bytes);
      joined.set(tail, bytes.length);
      bytes = joined;
    }
  }
  return bytes;
}

async function fallbackImage(appURL) {
  const icon = await fetch(appURL.replace(/\/+$/, "") + "/assets/icons/icon-512.png");
  return new Response(icon.body, {
    status: icon.ok ? 200 : 404,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" }
  });
}

// ── Routes ─────────────────────────────────────────────────────────────
export async function handleShareRoute(request, env, url) {
  const appURL = env.SHARE_APP_URL || DEFAULT_APP_URL;
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");   // ["s", ...]
  const isArt = parts[1] === "art";
  const kind = isArt ? parts[2] : parts[1];
  const id = decodeURIComponent((isArt ? parts[3] : parts[2]) || "").replace(/\.(jpe?g|png|webp)$/i, "");
  if (!KINDS[kind] || !ID_PATTERN.test(id) || parts.length !== (isArt ? 4 : 3)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  let data = null;
  let lookupFailed = false;
  try {
    data = await readShare(env, kind, id);
  } catch (err) {
    lookupFailed = true;
  }

  if (isArt) {
    const source = coverSourceURL(kind, data);
    if (source) {
      try {
        const art = findEmbeddedArt(await readAudioHead(source));
        if (art) {
          return new Response(art.data, {
            headers: { "Content-Type": art.mime, "Cache-Control": "public, max-age=86400" }
          });
        }
      } catch (err) {
        // fall through to the app icon
      }
    }
    return fallbackImage(appURL);
  }

  const info = describeShare(kind, data);
  const page = buildSharePage({
    title: info.title,
    description: info.description,
    url: url.origin + "/s/" + kind + "/" + encodeURIComponent(id),
    image: url.origin + "/s/art/" + kind + "/" + encodeURIComponent(id),
    target: appTarget(appURL, kind, id)
  });
  return new Response(page, {
    status: lookupFailed ? 502 : (info.found ? 200 : 404),
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short, so a revoked link stops previewing soon.
      "Cache-Control": "public, max-age=300"
    }
  });
}
