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

import { handleShareRoute, readShare } from "./share.js";
import { sendPush, isPushEndpoint, b64urlToBytes, bytesToB64url } from "./push.js";

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

    const route = url.pathname.replace(/\/+$/, "");
    // Share pages report plays and hearts, and follow or unfollow, without
    // the owner's token.
    if (route === "/listen") return handleListen(request, env);
    if (route === "/follow") return handleFollow(request, env);
    if (route === "/unfollow") return handleUnfollow(request, env);

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "Unauthorized." }, 401, request, env);
    }

    if (route === "/transcribe") return handleTranscribe(request, env);
    if (route === "/generate") return handleGenerate(request, env);
    if (route === "/lyrics") return handleLyrics(request, env);
    if (route === "/cover") return handleCover(request, env);
    if (route === "/embed") return handleEmbed(request, env);
    if (route === "/translate") return handleTranslate(request, env);
    if (route === "/story") return handleSongStory(request, env);
    if (route === "/listens") return handleListens(request, env);
    if (route === "/followers") return handleFollowers(request, env);
    if (route === "/notify") return handleNotify(request, env);

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

// A painting of the title as a scene, coloured by the music. Asked for an
// "album cover" with the title named, FLUX lettered it across the picture
// (misspelt) despite "no text"; as "a scene of harbour lights" in a
// painting it draws the scene. Measured 2026-10-04.
function buildCoverPrompt(title, style) {
  return [
    "A square painting with no text in it" + (title ? ": a scene of " + title.toLowerCase() : "") + ".",
    style ? "Its mood and colours come from this music: " + style.slice(0, 600) + "." : "",
    "Cinematic light, rich colour, a strong simple composition.",
    "No text, no letters, no words, no signs, no typography, no logos, no watermark anywhere in the image."
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

// ─── Search by meaning ───────────────────────────────────────────────────────

// POST /embed { texts: [...] } -> { model, vectors: [[...1024 numbers], ...] }
// BGE-M3 on Workers AI: multilingual (the vault holds Bikol and Tagalog
// songs as well as English), one vector per text. The app sends a song's
// words a few at a time, and a search query on its own; batches stay small
// so turning the answer into JSON never costs the worker much CPU.
// ── Translate and explain ────────────────────────────────────────────────
// POST /translate { title, lyrics, lines: [sung lines], language, model? }
// -> { from, same, lines: [one per sung line], about, notes: [{ line, note }] }
// One translated line per sung line, so the app can show each under its
// original and keep it timed to the music.

const MAX_TRANSLATE_LINES = 200;
const MAX_TRANSLATE_LINE = 300;
const MAX_TRANSLATE_TOKENS = 4096;
// Translation is where a stronger model earns its cost (about 2 cents a song,
// once): the fast one took Bikol for Hiligaynon and mistranslated it.
const TRANSLATE_MODEL = "claude-sonnet-5-5";
const TRANSLATE_SYSTEM_PROMPT = [
  "You translate song lyrics and explain them, for the songwriter and the friends they share songs with.",
  "You get a song's title, its whole lyric sheet for context, its sung lines numbered, and a target language.",
  "The songwriter writes in English, Tagalog and Bikol (Central Bikol, from the Bicol region of the Philippines). Don't mistake Bikol for Hiligaynon, Cebuano or Waray.",
  "Translate each numbered line into the target language as a natural line that keeps its meaning and feeling, not word for word. Keep names as they are. A line already in the target language, or an ad-lib like \"oh\", stays as it is.",
  "Then, writing in the target language, say what the song is about and how it feels in two to four plain sentences, and add up to six short notes on lines where an idiom, slang, a cultural or local reference, or wordplay needs explaining. Leave notes empty when nothing does.",
  "Reply with JSON only, no prose around it:",
  "{\"from\": \"the language the song is mostly in, named in English, e.g. Bikol, Tagalog, English\", \"same\": true only if every line is already in the target language, \"lines\": [one string per numbered line, in order, exactly as many as there are numbered lines; [] when same is true], \"about\": \"...\", \"notes\": [{\"line\": the line number, \"note\": \"...\"}]}"
].join("\n");

async function handleTranslate(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Worker secret ANTHROPIC_API_KEY is not configured." }, 500, request, env);
  }
  const payload = await readJsonBody(request);
  if (!payload) {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, request, env);
  }
  const language = cleanString(payload.language).slice(0, 40);
  const lines = Array.isArray(payload.lines) ? payload.lines.map(function (line) { return cleanString(line).slice(0, MAX_TRANSLATE_LINE); }) : [];
  if (!language || !lines.length) {
    return jsonResponse({ error: "Send the sung lines and a language to translate into." }, 400, request, env);
  }
  if (lines.length > MAX_TRANSLATE_LINES) {
    return jsonResponse({ error: "This song has more lines than can be translated at once." }, 400, request, env);
  }
  const title = cleanString(payload.title).slice(0, MAX_SONG_TITLE);
  const sheet = cleanString(payload.lyrics).slice(0, MAX_SONG_LYRICS);
  const model = cleanString(payload.model) || cleanString(env.TRANSLATE_MODEL) || TRANSLATE_MODEL;
  const userText = [
    "Target language: " + language, "",
    "Title: " + (title || "(untitled)"), "",
    "Lyric sheet:", sheet || lines.join("\n"), "",
    "Sung lines (" + lines.length + "):",
    lines.map(function (line, i) { return (i + 1) + ". " + line; }).join("\n")
  ].join("\n");

  let response;
  try {
    response = await callAnthropic(env, {
      model: model,
      max_tokens: MAX_TRANSLATE_TOKENS,
      // No temperature and no started reply: newer models refuse both.
      system: TRANSLATE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }]
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
  let answer;
  try {
    answer = extractJsonObject(extractAnthropicText(parsed || {}));
  } catch (err) {
    answer = null;
  }
  if (!answer) {
    return jsonResponse({ error: "Claude's translation came back unreadable. Try again." }, 502, request, env);
  }
  const same = answer.same === true;
  let translated = Array.isArray(answer.lines) ? answer.lines.map(function (line) { return cleanString(line).slice(0, MAX_TRANSLATE_LINE * 2); }) : [];
  if (!same) {
    // A line or two out is padded or trimmed; more than that means the lines
    // no longer line up, and a wrong line under each lyric is worse than none.
    if (Math.abs(translated.length - lines.length) > 2) {
      return jsonResponse({ error: "Claude's translation didn't line up with the song. Try again." }, 502, request, env);
    }
    translated = lines.map(function (_, i) { return translated[i] || ""; });
  }
  const notes = (Array.isArray(answer.notes) ? answer.notes : [])
    .map(function (item) {
      return { line: Math.round(Number(item && item.line)), note: cleanString(item && item.note).slice(0, 400) };
    })
    .filter(function (item) { return item.note && item.line >= 1 && item.line <= lines.length; })
    .slice(0, 6);
  return jsonResponse({
    from: cleanString(answer.from).slice(0, 40),
    same: same,
    lines: same ? [] : translated,
    about: cleanString(answer.about).slice(0, 1200),
    notes: notes
  }, 200, request, env);
}

// ── The story behind a song ──────────────────────────────────────────────
// POST /story { title, prompt, lyrics, summary, notes } -> { story }
// A short liner note in the songwriter's voice, drafted from their own notes
// and the song, for them to edit. Written by the translation model, which
// writes better than the metadata one; nothing is invented.

const MAX_STORY_NOTES = 1500;
const STORY_SYSTEM_PROMPT = [
  "You help a songwriter write the short note that goes with a song, like liner notes: the story behind it.",
  "Write it in the first person, as the songwriter, in plain and warm words: two to four sentences, under 90 words.",
  "Use only what you are given. The songwriter's own notes come first; the lyrics, the description and the prompt they gave the music AI show what the song is about and how it feels. Never invent people, places, dates or events that aren't there. If the notes don't say who it's for or when it was written, write about the feeling and what the song says instead.",
  "Write in the language of the songwriter's notes, or English when there are none.",
  "No title, no quotation marks around it, no hashtags, no emoji. Reply with the note only."
].join("\n");

async function handleSongStory(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Worker secret ANTHROPIC_API_KEY is not configured." }, 500, request, env);
  }
  const payload = await readJsonBody(request);
  if (!payload) {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, request, env);
  }
  const title = cleanString(payload.title).slice(0, MAX_SONG_TITLE);
  const lyrics = cleanString(payload.lyrics).slice(0, MAX_SONG_LYRICS);
  const notes = cleanString(payload.notes).slice(0, MAX_STORY_NOTES);
  const summary = cleanString(payload.summary).slice(0, 600);
  const prompt = cleanString(payload.prompt).slice(0, MAX_SONG_STYLE);
  if (!notes && !lyrics && !summary && !prompt) {
    return jsonResponse({ error: "Write a few notes, or add lyrics, to draft from." }, 400, request, env);
  }
  const userText = [
    "Title: " + (title || "(untitled)"), "",
    "My notes:", notes || "(none)", "",
    "What the song is about:", summary || "(not described)", "",
    "The prompt I gave the music AI:", prompt || "(none)", "",
    "Lyrics:", lyrics || "(instrumental)"
  ].join("\n");

  let response;
  try {
    response = await callAnthropic(env, {
      model: cleanString(payload.model) || cleanString(env.TRANSLATE_MODEL) || TRANSLATE_MODEL,
      max_tokens: 400,
      system: STORY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }]
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
  const story = cleanString(extractAnthropicText(parsed || {})).replace(/^["\u201c]+|["\u201d]+$/g, "").trim().slice(0, 1200);
  if (!story) {
    return jsonResponse({ error: "Claude returned nothing. Try again." }, 502, request, env);
  }
  return jsonResponse({ story: story }, 200, request, env);
}

// ── Plays and hearts on share links ──────────────────────────────────────
// POST /listen { id, kind: "play" | "heart", pos } from a share page, no
// token: counted only for a song that really is shared (its public record
// exists), with each visitor known only by a hash of the day, their
// address and browser -- never the address -- so a repeat play within half
// an hour counts once and hearts stop at 20 a day. POST /listens (owner,
// token) sums them up per song: plays, hearts, this week, and the moments
// loved most (in 5-second buckets). Rows live in D1 (binding LISTENS).

const LISTEN_REPEAT_MS = 30 * 60 * 1000;
const LISTEN_HEARTS_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const _sharedTracks = new Map();   // track id -> { ok, until }, per isolate

async function isSharedTrack(env, id) {
  const hit = _sharedTracks.get(id);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok;
  try {
    ok = !!(await readShare(env, "track", id));
  } catch (err) {
    return false;
  }
  _sharedTracks.set(id, { ok: ok, until: Date.now() + 10 * 60 * 1000 });
  return ok;
}

async function visitorId(request, env) {
  const parts = [
    cleanString(env.LISTEN_SALT) || cleanString(env.SONICVAULT_CLIENT_TOKEN) || "sonicvault",
    new Date().toISOString().slice(0, 10),
    request.headers.get("CF-Connecting-IP") || "",
    request.headers.get("User-Agent") || ""
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function handleListen(request, env) {
  if (!env.LISTENS) return jsonResponse({ error: "Listen counts aren't set up." }, 503, request, env);
  const payload = await readJsonBody(request);
  const id = cleanString(payload && payload.id).slice(0, 80);
  const kind = payload && (payload.kind === "play" || payload.kind === "heart") ? payload.kind : "";
  if (!id || !kind) {
    return jsonResponse({ error: "Send a shared song's id, and play or heart." }, 400, request, env);
  }
  const pos = Number(payload.pos);
  if (kind === "heart" && !(isFinite(pos) && pos >= 0 && pos <= 3600)) {
    return jsonResponse({ error: "A heart needs the moment in the song." }, 400, request, env);
  }
  if (!(await isSharedTrack(env, id))) {
    return jsonResponse({ error: "That song isn't shared." }, 404, request, env);
  }
  const visitor = await visitorId(request, env);
  const now = Date.now();
  if (kind === "play") {
    const seen = await env.LISTENS.prepare(
      "SELECT 1 AS seen FROM events WHERE visitor = ? AND track = ? AND kind = 'play' AND at > ? LIMIT 1"
    ).bind(visitor, id, now - LISTEN_REPEAT_MS).first();
    if (seen) return jsonResponse({ ok: true, counted: false }, 200, request, env);
    await env.LISTENS.prepare(
      "INSERT INTO events (track, kind, visitor, at, pos) VALUES (?, 'play', ?, ?, NULL)"
    ).bind(id, visitor, now).run();
  } else {
    const today = await env.LISTENS.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE visitor = ? AND track = ? AND kind = 'heart' AND at > ?"
    ).bind(visitor, id, now - DAY_MS).first();
    if (today && today.n >= LISTEN_HEARTS_PER_DAY) return jsonResponse({ ok: true, counted: false }, 200, request, env);
    await env.LISTENS.prepare(
      "INSERT INTO events (track, kind, visitor, at, pos) VALUES (?, 'heart', ?, ?, ?)"
    ).bind(id, visitor, now, Math.round(pos * 10) / 10).run();
  }
  return jsonResponse({ ok: true, counted: true }, 200, request, env);
}

async function handleListens(request, env) {
  if (!env.LISTENS) return jsonResponse({ tracks: {} }, 200, request, env);
  const weekAgo = Date.now() - 7 * DAY_MS;
  const counts = await env.LISTENS.prepare(
    "SELECT track, kind, COUNT(*) AS total, SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS week, MAX(at) AS last FROM events GROUP BY track, kind"
  ).bind(weekAgo).all();
  const moments = await env.LISTENS.prepare(
    "SELECT track, CAST(pos / 5 AS INTEGER) AS bucket, COUNT(*) AS n FROM events WHERE kind = 'heart' GROUP BY track, bucket"
  ).all();
  const tracks = {};
  (counts.results || []).forEach(function (row) {
    const t = tracks[row.track] = tracks[row.track] || { plays: 0, playsWeek: 0, hearts: 0, heartsWeek: 0, last: 0, moments: [] };
    if (row.kind === "play") { t.plays = Number(row.total) || 0; t.playsWeek = Number(row.week) || 0; }
    if (row.kind === "heart") { t.hearts = Number(row.total) || 0; t.heartsWeek = Number(row.week) || 0; }
    t.last = Math.max(t.last, Number(row.last) || 0);
  });
  (moments.results || []).forEach(function (row) {
    if (tracks[row.track]) tracks[row.track].moments.push({ at: (Number(row.bucket) || 0) * 5, hearts: Number(row.n) || 0 });
  });
  Object.keys(tracks).forEach(function (id) {
    tracks[id].moments = tracks[id].moments.sort(function (a, b) { return b.hearts - a.hearts || a.at - b.at; }).slice(0, 5);
  });
  return jsonResponse({ tracks: tracks }, 200, request, env);
}

// ── Followers: a notice when there's a new song ──────────────────────────
// POST /follow { subscription } from a share page, no token: a browser's
// push subscription, kept only if it points at a real push service (see
// push.js), at most MAX_FOLLOWERS of them. POST /unfollow { endpoint }
// drops one. The owner (token) asks POST /followers for the count and
// POST /notify { id, title, body, url, after } to tell them about a shared
// song: MAX_NOTIFY_BATCH at a time, since a worker may make only so many
// requests per call -- the app repeats with `after` until `next` is null.
// A browser the push service says is gone (404, 410) is dropped.

const MAX_FOLLOWERS = 5000;
const MAX_NOTIFY_BATCH = 40;

// The VAPID key: the private scalar as base64url (the secret
// VAPID_PRIVATE_KEY, the form web-push tools use) and the public point (the
// var VAPID_PUBLIC_KEY, 65 bytes: 0x04, x, y), put together as a JWK.
function vapidFrom(env) {
  const d = cleanString(env.VAPID_PRIVATE_KEY);
  const publicKey = cleanString(env.VAPID_PUBLIC_KEY);
  if (!d || !publicKey) return null;
  let point;
  try { point = b64urlToBytes(publicKey); } catch (err) { return null; }
  if (point.length !== 65 || point[0] !== 4) return null;
  const privateJwk = { kty: "EC", crv: "P-256", x: bytesToB64url(point.slice(1, 33)), y: bytesToB64url(point.slice(33)), d: d };
  return { privateJwk, publicKey, subject: cleanString(env.VAPID_SUBJECT) || cleanString(env.SHARE_APP_URL) || "https://sonicvault.app" };
}

async function handleFollow(request, env) {
  if (!env.LISTENS) return jsonResponse({ error: "Following isn't set up." }, 503, request, env);
  const payload = await readJsonBody(request);
  const sub = payload && payload.subscription;
  const endpoint = cleanString(sub && sub.endpoint).slice(0, 1000);
  const p256dh = cleanString(sub && sub.keys && sub.keys.p256dh);
  const auth = cleanString(sub && sub.keys && sub.keys.auth);
  let keysOk = false;
  try { keysOk = b64urlToBytes(p256dh).length === 65 && b64urlToBytes(auth).length === 16; } catch (err) { keysOk = false; }
  if (!isPushEndpoint(endpoint) || !keysOk) {
    return jsonResponse({ error: "That isn't a browser push subscription." }, 400, request, env);
  }
  const count = await env.LISTENS.prepare("SELECT COUNT(*) AS n FROM followers").first();
  const known = await env.LISTENS.prepare("SELECT 1 AS known FROM followers WHERE endpoint = ?").bind(endpoint).first();
  if (!known && count && count.n >= MAX_FOLLOWERS) {
    return jsonResponse({ error: "This songwriter can't take more followers right now." }, 429, request, env);
  }
  await env.LISTENS.prepare(
    "INSERT INTO followers (endpoint, p256dh, auth, at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, at = excluded.at"
  ).bind(endpoint, p256dh, auth, Date.now()).run();
  return jsonResponse({ ok: true }, 200, request, env);
}

async function handleUnfollow(request, env) {
  if (!env.LISTENS) return jsonResponse({ ok: true }, 200, request, env);
  const payload = await readJsonBody(request);
  const endpoint = cleanString(payload && payload.endpoint).slice(0, 1000);
  if (endpoint) await env.LISTENS.prepare("DELETE FROM followers WHERE endpoint = ?").bind(endpoint).run();
  return jsonResponse({ ok: true }, 200, request, env);
}

async function handleFollowers(request, env) {
  if (!env.LISTENS) return jsonResponse({ count: 0, ready: false }, 200, request, env);
  const row = await env.LISTENS.prepare("SELECT COUNT(*) AS n FROM followers").first();
  return jsonResponse({ count: Number(row && row.n) || 0, ready: !!vapidFrom(env) }, 200, request, env);
}

async function handleNotify(request, env) {
  const vapid = vapidFrom(env);
  if (!env.LISTENS || !vapid) return jsonResponse({ error: "Notices aren't set up on the worker." }, 503, request, env);
  const payload = await readJsonBody(request);
  const id = cleanString(payload && payload.id).slice(0, 80);
  if (!id || !(await isSharedTrack(env, id))) {
    return jsonResponse({ error: "Share the song first, then tell your followers." }, 400, request, env);
  }
  const message = JSON.stringify({
    title: cleanString(payload.title).slice(0, 80) || "A new song",
    body: cleanString(payload.body).slice(0, 160) || "Tap to listen.",
    url: cleanString(payload.url).slice(0, 500),
    tag: "song-" + id
  });
  const after = Math.max(0, Number(payload.after) || 0);
  const rows = await env.LISTENS.prepare(
    "SELECT id, endpoint, p256dh, auth FROM followers WHERE id > ? ORDER BY id LIMIT ?"
  ).bind(after, MAX_NOTIFY_BATCH).all();
  const list = rows.results || [];
  let sent = 0;
  let removed = 0;
  let failed = 0;
  await Promise.all(list.map(async function (row) {
    let status = 0;
    try { status = await sendPush(row, message, vapid); } catch (err) { status = 0; }
    if (status >= 200 && status < 300) sent++;
    else if (status === 404 || status === 410) {
      removed++;
      await env.LISTENS.prepare("DELETE FROM followers WHERE id = ?").bind(row.id).run();
    } else failed++;
  }));
  const next = list.length === MAX_NOTIFY_BATCH ? list[list.length - 1].id : null;
  return jsonResponse({ sent: sent, removed: removed, failed: failed, next: next }, 200, request, env);
}

const EMBED_MODEL = "@cf/baai/bge-m3";
const MAX_EMBED_TEXTS = 16;
const MAX_EMBED_CHARS = 4000;

async function handleEmbed(request, env) {
  if (!env.AI) {
    return jsonResponse({ error: "Workers AI binding \"AI\" is not configured." }, 500, request, env);
  }
  const payload = await readJsonBody(request);
  const texts = payload && Array.isArray(payload.texts)
    ? payload.texts.map(function (text) { return cleanString(text).slice(0, MAX_EMBED_CHARS); })
    : [];
  if (!texts.length || texts.some(function (text) { return !text; })) {
    return jsonResponse({ error: "Send { texts: [...] } with at least one non-empty text." }, 400, request, env);
  }
  if (texts.length > MAX_EMBED_TEXTS) {
    return jsonResponse({ error: "Send at most " + MAX_EMBED_TEXTS + " texts at a time." }, 400, request, env);
  }
  let result;
  try {
    result = await env.AI.run(EMBED_MODEL, { text: texts });
  } catch (err) {
    return jsonResponse({ error: "Embedding failed.", details: cleanString(err && err.message) }, 502, request, env);
  }
  const vectors = result && Array.isArray(result.data) ? result.data : [];
  if (vectors.length !== texts.length) {
    return jsonResponse({ error: "Embedding returned " + vectors.length + " vectors for " + texts.length + " texts." }, 502, request, env);
  }
  return jsonResponse({ model: EMBED_MODEL, vectors: vectors }, 200, request, env);
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
