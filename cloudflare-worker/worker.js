// SonicVault metadata worker — Anthropic (Claude) edition.
//
// Deploy with Wrangler and set these secrets / vars:
//   wrangler secret put ANTHROPIC_API_KEY        (required)
//   wrangler secret put SONICVAULT_CLIENT_TOKEN   (optional — bearer token the web UI must send)
//   wrangler secret put GEMINI_API_KEY            (optional — turns on POST /generate, Lyria songs)
//   ALLOWED_ORIGIN  (optional, comma-separated list of allowed origins, e.g. "https://bobbynacario.github.io")
//
// The web UI posts { title, prompt, lyrics, model, fallback } and expects a raw
// metadata object back (the ai* schema below). Lyrics are optional so
// instrumentals and watcher imports can be tagged too.
//
// POST /transcribe times a song's lyrics: Whisper (Workers AI, the "AI"
// binding in wrangler.toml) listens to the audio and returns every word it
// hears with its start and end. The app lines those words up against the
// lyric sheet it already has (js/data/lyric-sync.js). Send JSON
// { audioURL } for a file in the SonicVault Cloudinary folder -- the worker
// streams it straight to the model -- or the audio itself as the body.
//
// The Create page (js/features/create.js) makes songs through three routes:
//   POST /generate  { title, style, lyrics, instrumental } -- Google's Lyria
//                   writes the song. Gemini's answer is passed straight
//                   through, base64 audio and all, so the worker never parses
//                   megabytes of JSON. Needs the GEMINI_API_KEY secret.
//   POST /lyrics    { title, style, draft } -- Claude writes or finishes a
//                   lyric sheet, returned as { title, lyrics }.
//   POST /cover     { title, style } -- a square cover from FLUX.1 [schnell]
//                   on Workers AI, returned as { mime, image } in base64.
//
// GET /s/... serves share-link previews to link-preview bots (share.js).
// Those routes are public by design: they read only the share records the
// app publishes for anyone to see.

import { handleShareRoute } from "./share.js";

const MODEL_NAME = "claude-haiku-4-5";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
// Lyria 3.5 makes full songs of a couple of minutes, vocals included. The
// LYRIA_MODEL var can name another (lyria-3-clip-preview makes 30s clips).
const LYRIA_MODEL = "lyria-3.5";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";
const LYRIA_RETRY_MS = 1500;
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MAX_SONG_TITLE = 120;
const MAX_SONG_STYLE = 1000;
const MAX_SONG_LYRICS = 6000;
// Only the vault's own Cloudinary files: the worker must not become a way
// to run paid transcription on anything on the internet.
const AUDIO_HOST = "res.cloudinary.com";
const AUDIO_PATH_PREFIX = "/dtw4em0ob/";
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = [
  "You are a strict music metadata extraction engine for SonicVault, a personal vault of AI-generated songs.",
  "Return ONLY a raw JSON object — no markdown, no code fences, no commentary before or after.",
  "Do not omit keys. Do not add extra keys.",
  "The JSON must match this exact schema:",
  '{ "aiGenre": "string", "aiMood": "string", "aiTheme": "string", "aiEnergy": "High/Medium/Low", "aiVocalStyle": "string", "aiEra": "string", "aiInstruments": ["array", "of", "strings"], "aiTags": ["array", "of", "strings"], "aiSummary": "A 2 sentence editorial summary", "coverStyle": "aurora/vinyl/poster/scope/prism/mono/pulse/tape", "aiExplicit": boolean }',
  "Rules:",
  "- aiEnergy must be exactly one of: High, Medium, Low.",
  "- coverStyle must be exactly one of: aurora, vinyl, poster, scope, prism, mono, pulse, tape.",
  "- Pick coverStyle from the strongest visual or production cue: aurora for lush atmospheric color, vinyl for vintage/analog/soul/jazz/R&B, poster for pop anthems and bold hooks, scope for cinematic/ambient/ocean/dream songs, prism for neon/electronic/synthwave/future, mono for dark/minimal/noir, pulse for club/EDM/808/high-energy, tape for lo-fi/cassette/acoustic/folk/country/home-recording.",
  "- aiSummary must be exactly 2 sentences.",
  "- aiVocalStyle should read 'Instrumental' when no lyrics are provided.",
  "- aiInstruments must be a short array of strings.",
  "- aiTags must be a short array of strings.",
  "- Use the title, prompt, and lyrics together when available.",
  "- Be concise, useful, and editorial."
].join("\n");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/s/")) {
      return handleShareRoute(request, env, url);
    }

    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed. Use POST." },
        405,
        request,
        env
      );
    }

    if (!isAllowedOrigin(request, env)) {
      return jsonResponse({ error: "Origin not allowed." }, 403, request, env);
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "Unauthorized." }, 401, request, env);
    }

    const route = url.pathname.replace(/\/+$/, "");
    if (route === "/transcribe") return handleTranscribe(request, env);
    if (route === "/generate") return handleGenerate(request, env);
    if (route === "/lyrics") return handleLyrics(request, env);
    if (route === "/cover") return handleCover(request, env);

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return jsonResponse(
        { error: "Request body must be valid JSON." },
        400,
        request,
        env
      );
    }

    const title = cleanString(payload.title);
    const prompt = cleanString(payload.prompt);
    const lyrics = cleanString(payload.lyrics);

    if (!title) {
      return jsonResponse(
        { error: 'Missing required field "title".' },
        400,
        request,
        env
      );
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse(
        { error: "Worker secret ANTHROPIC_API_KEY is not configured." },
        500,
        request,
        env
      );
    }

    const model = cleanString(payload.model) || MODEL_NAME;

    const userText = [
      "Track title:",
      title,
      "",
      "Prompt / notes:",
      prompt || "(none provided)",
      "",
      "Lyrics:",
      lyrics || "(instrumental — no lyrics provided)",
      "",
      "Available SonicVault cover styles:",
      "aurora, vinyl, poster, scope, prism, mono, pulse, tape"
    ].join("\n");

    const anthropicBody = {
      model: model,
      max_tokens: MAX_TOKENS,
      temperature: 0.25,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userText },
        // Prefill the assistant turn with "{" so the model is forced to emit a
        // bare JSON object; we re-add the leading brace before parsing.
        { role: "assistant", content: "{" }
      ]
    };

    let anthropicResponse;
    try {
      anthropicResponse = await callAnthropic(env, anthropicBody);
    } catch (err) {
      return jsonResponse(
        {
          error: "Could not reach Anthropic.",
          details: cleanString(err && err.message) || "Network request failed."
        },
        502,
        request,
        env
      );
    }

    const rawText = await anthropicResponse.text();
    if (!anthropicResponse.ok) {
      // The app shows only `error`, so Anthropic's own reason goes in it --
      // "credit balance is too low", "invalid x-api-key", an unknown model --
      // instead of a bare "request failed". It is logged for wrangler tail
      // too. Anthropic's error text never contains the key.
      const parsed = safeJsonParse(rawText);
      const apiError = parsed && parsed.error ? parsed.error : {};
      const reason = cleanString(apiError.message) || cleanString(rawText).slice(0, 200) || "no details";
      const kind = cleanString(apiError.type);
      console.error("Anthropic request failed", anthropicResponse.status, kind, reason, "model:", model);
      return jsonResponse(
        {
          error: "Anthropic API request failed (" + anthropicResponse.status + (kind ? " " + kind : "") + "): " + reason,
          status: anthropicResponse.status,
          details: parsed || rawText
        },
        anthropicResponse.status === 429 ? 429 : 502,
        request,
        env
      );
    }

    let anthropicData;
    try {
      anthropicData = JSON.parse(rawText);
    } catch (err) {
      return jsonResponse(
        { error: "Anthropic returned invalid JSON.", raw: rawText },
        502,
        request,
        env
      );
    }

    const text = extractAnthropicText(anthropicData);
    if (!text) {
      return jsonResponse(
        { error: "Anthropic returned no text content.", raw: anthropicData },
        502,
        request,
        env
      );
    }

    let metadata;
    try {
      // Re-add the prefilled "{" before parsing.
      metadata = extractJsonObject("{" + text);
      metadata = normalizeMetadata(metadata);
      validateMetadata(metadata);
    } catch (err) {
      return jsonResponse(
        {
          error: "Anthropic returned invalid metadata JSON.",
          details: cleanString(err && err.message) || "Schema validation failed.",
          raw: text
        },
        502,
        request,
        env
      );
    }

    return jsonResponse(metadata, 200, request, env);
  }
};

async function handleTranscribe(request, env) {
  if (!env.AI) {
    return jsonResponse({ error: "Workers AI binding \"AI\" is not configured." }, 500, request, env);
  }

  let audio;
  const type = cleanString(request.headers.get("Content-Type")).toLowerCase();
  if (type.startsWith("audio/") || type === "application/octet-stream") {
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > MAX_AUDIO_BYTES) {
      return jsonResponse({ error: "Audio is larger than 30MB." }, 413, request, env);
    }
    audio = { body: request.body, contentType: type.startsWith("audio/") ? type : "audio/mpeg" };
  } else {
    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return jsonResponse({ error: "Send JSON { audioURL } or the audio itself." }, 400, request, env);
    }
    let url;
    try {
      url = new URL(cleanString(payload.audioURL));
    } catch (err) {
      return jsonResponse({ error: 'Missing or invalid "audioURL".' }, 400, request, env);
    }
    if (url.protocol !== "https:" || url.hostname !== AUDIO_HOST || !url.pathname.startsWith(AUDIO_PATH_PREFIX)) {
      return jsonResponse({ error: "audioURL must be a SonicVault Cloudinary file." }, 400, request, env);
    }
    let file;
    try {
      file = await fetch(url.toString());
    } catch (err) {
      return jsonResponse({ error: "Could not fetch the audio." }, 502, request, env);
    }
    if (!file.ok || !file.body) {
      return jsonResponse({ error: "Audio fetch failed.", status: file.status }, 502, request, env);
    }
    if (Number(file.headers.get("Content-Length") || 0) > MAX_AUDIO_BYTES) {
      return jsonResponse({ error: "Audio is larger than 30MB." }, 413, request, env);
    }
    audio = { body: file.body, contentType: cleanString(file.headers.get("Content-Type")) || "audio/mpeg" };
  }

  let result;
  try {
    result = await env.AI.run(WHISPER_MODEL, {
      audio: audio,
      task: "transcribe",
      // Music loops easily when each window is conditioned on the last.
      condition_on_previous_text: false
    });
  } catch (err) {
    return jsonResponse(
      { error: "Transcription failed.", details: cleanString(err && err.message) },
      502,
      request,
      env
    );
  }

  // Words only, as compact [text, start, end] triples -- all the app needs.
  const words = [];
  (Array.isArray(result && result.segments) ? result.segments : []).forEach(function (segment) {
    (Array.isArray(segment && segment.words) ? segment.words : []).forEach(function (w) {
      const text = cleanString(w && w.word);
      if (!text || typeof w.start !== "number" || typeof w.end !== "number") return;
      words.push([text, Math.round(w.start * 100) / 100, Math.round(w.end * 100) / 100]);
    });
  });

  return jsonResponse(
    {
      model: WHISPER_MODEL,
      language: cleanString(result && result.transcription_info && result.transcription_info.language),
      duration: Number(result && result.transcription_info && result.transcription_info.duration) || 0,
      words: words
    },
    200,
    request,
    env
  );
}

// ─── Create: songs, lyrics and covers ────────────────────────────────────────

async function readJsonBody(request) {
  try {
    const payload = await request.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch (err) {
    return null;
  }
}

// What Lyria is asked for: the sound described in the person's own words,
// then either "instrumental" or the lyric sheet under a "Lyrics:" header,
// the form Google's prompt guide uses. With no lyrics Lyria writes its own,
// and the title gives it something to write about.
function buildSongPrompt(input) {
  const lines = [];
  if (input.style) lines.push(input.style);
  if (input.title) lines.push("Song title: " + input.title);
  if (input.instrumental) {
    lines.push("Instrumental only, no vocals.");
  } else if (input.lyrics) {
    lines.push("", "Lyrics:", input.lyrics);
  }
  return lines.join("\n");
}

async function handleGenerate(request, env) {
  // Checked before the body, so an empty request from the app tells it
  // whether generation is set up without making anything.
  if (!env.GEMINI_API_KEY) {
    return jsonResponse(
      { error: "Song generation is not set up: add the worker secret GEMINI_API_KEY." },
      501,
      request,
      env
    );
  }
  const payload = await readJsonBody(request);
  if (!payload) {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, request, env);
  }
  const input = {
    title: cleanString(payload.title),
    style: cleanString(payload.style),
    lyrics: cleanString(payload.lyrics),
    instrumental: payload.instrumental === true
  };
  if (!input.style && !input.lyrics) {
    return jsonResponse({ error: "Describe the sound you want, or give Lyria some lyrics." }, 400, request, env);
  }
  if (input.title.length > MAX_SONG_TITLE || input.style.length > MAX_SONG_STYLE || input.lyrics.length > MAX_SONG_LYRICS) {
    return jsonResponse(
      { error: "Keep the title under " + MAX_SONG_TITLE + " characters, the description under " + MAX_SONG_STYLE + " and the lyrics under " + MAX_SONG_LYRICS + "." },
      400,
      request,
      env
    );
  }

  const model = cleanString(env.LYRIA_MODEL) || LYRIA_MODEL;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildSongPrompt(input) }] }],
    generationConfig: { responseModalities: ["AUDIO", "TEXT"] }
  });
  let response;
  try {
    // "Unavailable" comes back at once and is not billed, so it is worth
    // one more try before the app is told.
    for (let attempt = 0; ; attempt++) {
      response = await fetch(GEMINI_API + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: body
      });
      if (response.status !== 503 || attempt >= 1) break;
      await response.body?.cancel();
      await new Promise(function (resolve) { setTimeout(resolve, LYRIA_RETRY_MS); });
    }
  } catch (err) {
    return jsonResponse(
      { error: "Could not reach Google's Gemini API.", details: cleanString(err && err.message) },
      502,
      request,
      env
    );
  }

  if (!response.ok) {
    // Google's own reason -- a bad key, billing not enabled, a model name it
    // does not know -- so the app can say what to fix.
    const rawText = await response.text();
    const parsed = safeJsonParse(rawText);
    const apiError = parsed && parsed.error ? parsed.error : {};
    const reason = cleanString(apiError.message) || cleanString(rawText).slice(0, 200) || "no details";
    const kind = cleanString(apiError.status);
    console.error("Lyria request failed", response.status, kind, reason, "model:", model);
    // Quota errors arrive as a paragraph of metric names. The free tier's
    // Lyria quota is zero, so on a key without billing every song fails
    // this way: say what to do instead.
    let error = "Lyria request failed (" + response.status + (kind ? " " + kind : "") + "): " + reason;
    if (response.status === 429 && /free_tier/i.test(reason) && /limit:\s*0\b/.test(reason)) {
      error = "This Gemini key's project is on the free tier, which can't make songs. Turn on billing for it in Google AI Studio, then try again.";
    } else if (response.status === 429) {
      error = "Lyria is limiting how fast this key can make songs. Try again in a minute.";
    } else if (response.status === 503) {
      error = "Lyria is busy right now. Try again in a minute.";
    }
    return jsonResponse(
      {
        error: error,
        status: response.status,
        details: reason
      },
      response.status === 429 ? 429 : 502,
      request,
      env
    );
  }

  // A song is a few MB of base64. Parsing it here would spend the worker's
  // CPU on what the browser has to parse anyway, so it streams through.
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-SonicVault-Model", model);
  headers.set("Access-Control-Expose-Headers", "X-SonicVault-Model");
  return new Response(response.body, { status: 200, headers });
}

const LYRICS_SYSTEM_PROMPT = [
  "You write original song lyrics for SonicVault, a personal vault of AI-generated songs.",
  "Google's Lyria will sing them in a song of about two and a half minutes.",
  "Return ONLY a raw JSON object, no markdown or commentary: { \"title\": \"string\", \"lyrics\": \"string\" }",
  "Rules:",
  "- Start every section with its tag alone on a line: [Verse 1], [Chorus], [Verse 2], [Bridge], [Outro].",
  "- Fit about two and a half minutes: two verses of four lines, a four-line chorus after each verse and again at the end, and at most a short bridge.",
  "- Concrete images over abstractions. Rhyme naturally or not at all; never force it.",
  "- Match the style and mood described, in the language it is written in.",
  "- Never quote or adapt the lyrics of existing songs, and never name or imitate real artists.",
  "- Keep the title you are given. With none, invent a short one.",
  "- When a draft or notes are given, build on them: keep the lines that work and finish the rest."
].join("\n");

async function handleLyrics(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Worker secret ANTHROPIC_API_KEY is not configured." }, 500, request, env);
  }
  const payload = await readJsonBody(request);
  if (!payload) {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, request, env);
  }
  const title = cleanString(payload.title).slice(0, MAX_SONG_TITLE);
  const style = cleanString(payload.style).slice(0, MAX_SONG_STYLE);
  const draft = cleanString(payload.draft).slice(0, MAX_SONG_LYRICS);
  if (!title && !style && !draft) {
    return jsonResponse({ error: "Give a title, a description of the sound, or a draft to work from." }, 400, request, env);
  }
  const model = cleanString(payload.model) || MODEL_NAME;
  const userText = [
    "Title:", title || "(none yet)", "",
    "The sound:", style || "(not described)", "",
    "Draft or notes:", draft || "(none)"
  ].join("\n");

  let response;
  try {
    response = await callAnthropic(env, {
      model: model,
      max_tokens: MAX_TOKENS,
      temperature: 0.9,
      system: LYRICS_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: "{" }
      ]
    });
  } catch (err) {
    return jsonResponse({ error: "Could not reach Anthropic." }, 502, request, env);
  }
  const rawText = await response.text();
  const parsed = safeJsonParse(rawText);
  if (!response.ok) {
    const apiError = parsed && parsed.error ? parsed.error : {};
    const reason = cleanString(apiError.message) || cleanString(rawText).slice(0, 200) || "no details";
    return jsonResponse(
      { error: "Anthropic API request failed (" + response.status + "): " + reason },
      response.status === 429 ? 429 : 502,
      request,
      env
    );
  }
  let song;
  try {
    song = extractJsonObject("{" + extractAnthropicText(parsed || {}));
  } catch (err) {
    song = null;
  }
  const lyrics = cleanString(song && song.lyrics);
  if (!lyrics) {
    return jsonResponse({ error: "Claude returned no lyrics. Try again." }, 502, request, env);
  }
  return jsonResponse({ title: title || cleanString(song.title).slice(0, MAX_SONG_TITLE), lyrics: lyrics }, 200, request, env);
}

// The picture is asked for without its title in quotes: FLUX tends to
// letter any quoted words onto the image.
function buildCoverPrompt(title, style) {
  return [
    "Square album cover artwork.",
    style ? "The music: " + style.slice(0, 600) + "." : "",
    title ? "Let the imagery suggest the song's title, " + title + "." : "",
    "One striking image with rich colour and a strong composition.",
    "No text, no letters, no words, no typography, no logos, no watermark."
  ].filter(Boolean).join(" ");
}

async function handleCover(request, env) {
  if (!env.AI) {
    return jsonResponse({ error: "Workers AI binding \"AI\" is not configured." }, 500, request, env);
  }
  const payload = await readJsonBody(request);
  if (!payload) {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, request, env);
  }
  const title = cleanString(payload.title).slice(0, MAX_SONG_TITLE);
  const style = cleanString(payload.style).slice(0, MAX_SONG_STYLE);
  if (!title && !style) {
    return jsonResponse({ error: "Give a title or a description of the sound." }, 400, request, env);
  }
  let result;
  try {
    result = await env.AI.run(IMAGE_MODEL, { prompt: buildCoverPrompt(title, style), steps: 6 });
  } catch (err) {
    return jsonResponse({ error: "Cover generation failed.", details: cleanString(err && err.message) }, 502, request, env);
  }
  const image = cleanString(result && result.image);
  if (!image) {
    return jsonResponse({ error: "Cover generation returned no image." }, 502, request, env);
  }
  return jsonResponse({ model: IMAGE_MODEL, mime: "image/jpeg", image: image }, 200, request, env);
}

// Overloaded (529), rate-limited (429) and server errors (5xx) are usually
// gone a moment later, so they are retried twice -- honouring retry-after
// when Anthropic sends one, capped so a request never hangs -- before the
// app is told. Anything else (a bad key, no credit, an unknown model) is
// returned at once.
const RETRYABLE_STATUS = [429, 500, 502, 503, 504, 529];
const RETRY_DELAYS_MS = [800, 2000];

async function callAnthropic(env, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify(body)
    });
    if (response.ok || attempt >= RETRY_DELAYS_MS.length || !RETRYABLE_STATUS.includes(response.status)) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Math.min(isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt], 5000);
    console.warn("Anthropic " + response.status + ", retrying in " + wait + "ms");
    await response.body?.cancel();
    await new Promise(function (resolve) { setTimeout(resolve, wait); });
  }
}

function handleOptions(request, env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env)
  });
}

function jsonResponse(data, status, request, env) {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders(request, env) {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const resolvedOrigin = getAllowedOriginForRequest(origin, env);
  headers.set("Access-Control-Allow-Origin", resolvedOrigin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
}

function isAllowedOrigin(request, env) {
  return !!getAllowedOriginForRequest(request.headers.get("Origin"), env);
}

function getAllowedOriginForRequest(origin, env) {
  const raw = cleanString(env.ALLOWED_ORIGIN);
  const allowed = raw
    ? raw.split(",").map(cleanString).filter(Boolean)
    : [];
  const normalizedOrigin = cleanString(origin);

  if (!allowed.length) return "*";
  if (!normalizedOrigin) return allowed[0];
  if (allowed.includes("*")) return "*";
  if (allowed.includes(normalizedOrigin)) return normalizedOrigin;
  return "";
}

function isAuthorized(request, env) {
  const expectedToken = cleanString(env.SONICVAULT_CLIENT_TOKEN);
  if (!expectedToken) return true;
  const auth = cleanString(request.headers.get("Authorization"));
  return auth === "Bearer " + expectedToken;
}

function cleanString(value) {
  return String(value || "").trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function extractAnthropicText(data) {
  try {
    if (!Array.isArray(data.content)) return "";
    return data.content
      .filter(function (block) { return block && block.type === "text"; })
      .map(function (block) { return cleanString(block.text); })
      .join("")
      .trim();
  } catch (err) {
    return "";
  }
}

function extractJsonObject(text) {
  const raw = cleanString(text);
  if (!raw) throw new Error("Empty model response.");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in response.");
    return JSON.parse(match[0]);
  }
}

function normalizeMetadata(data) {
  return {
    aiGenre: cleanString(data.aiGenre),
    aiMood: cleanString(data.aiMood),
    aiTheme: cleanString(data.aiTheme),
    aiEnergy: cleanString(data.aiEnergy),
    aiVocalStyle: cleanString(data.aiVocalStyle),
    aiEra: cleanString(data.aiEra),
    aiInstruments: Array.isArray(data.aiInstruments)
      ? data.aiInstruments.map(cleanString).filter(Boolean)
      : [],
    aiTags: Array.isArray(data.aiTags)
      ? data.aiTags.map(cleanString).filter(Boolean)
      : [],
    aiSummary: cleanString(data.aiSummary),
    coverStyle: cleanString(data.coverStyle).toLowerCase(),
    aiExplicit: Boolean(data.aiExplicit)
  };
}

function validateMetadata(data) {
  const requiredStrings = [
    "aiGenre",
    "aiMood",
    "aiTheme",
    "aiEnergy",
    "aiVocalStyle",
    "aiEra",
    "aiSummary",
    "coverStyle"
  ];

  for (const key of requiredStrings) {
    if (!data[key]) {
      throw new Error('Missing field "' + key + '".');
    }
  }

  if (!["High", "Medium", "Low"].includes(data.aiEnergy)) {
    throw new Error('Invalid value for "aiEnergy".');
  }

  if (!["aurora", "vinyl", "poster", "scope", "prism", "mono", "pulse", "tape"].includes(data.coverStyle)) {
    throw new Error('Invalid value for "coverStyle".');
  }

  if (!Array.isArray(data.aiInstruments)) {
    throw new Error('"aiInstruments" must be an array.');
  }

  if (!Array.isArray(data.aiTags)) {
    throw new Error('"aiTags" must be an array.');
  }

  if (typeof data.aiExplicit !== "boolean") {
    throw new Error('"aiExplicit" must be a boolean.');
  }
}
