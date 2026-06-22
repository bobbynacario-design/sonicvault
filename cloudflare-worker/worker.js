// SonicVault metadata worker — Anthropic (Claude) edition.
//
// Deploy with Wrangler and set these secrets / vars:
//   wrangler secret put ANTHROPIC_API_KEY        (required)
//   wrangler secret put SONICVAULT_CLIENT_TOKEN   (optional — bearer token the web UI must send)
//   ALLOWED_ORIGIN  (optional, comma-separated list of allowed origins, e.g. "https://bobbynacario.github.io")
//
// The web UI posts { title, prompt, lyrics, model, fallback } and expects a raw
// metadata object back (the ai* schema below). Lyrics are optional so
// instrumentals and watcher imports can be tagged too.

const MODEL_NAME = "claude-haiku-4-5";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = [
  "You are a strict music metadata extraction engine for SonicVault, a personal vault of AI-generated songs.",
  "Return ONLY a raw JSON object — no markdown, no code fences, no commentary before or after.",
  "Do not omit keys. Do not add extra keys.",
  "The JSON must match this exact schema:",
  '{ "aiGenre": "string", "aiMood": "string", "aiTheme": "string", "aiEnergy": "High/Medium/Low", "aiVocalStyle": "string", "aiEra": "string", "aiInstruments": ["array", "of", "strings"], "aiTags": ["array", "of", "strings"], "aiSummary": "A 2 sentence editorial summary", "aiExplicit": boolean }',
  "Rules:",
  "- aiEnergy must be exactly one of: High, Medium, Low.",
  "- aiSummary must be exactly 2 sentences.",
  "- aiVocalStyle should read 'Instrumental' when no lyrics are provided.",
  "- aiInstruments must be a short array of strings.",
  "- aiTags must be a short array of strings.",
  "- Use the title, prompt, and lyrics together when available.",
  "- Be concise, useful, and editorial."
].join("\n");

export default {
  async fetch(request, env) {
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
      lyrics || "(instrumental — no lyrics provided)"
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
      anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify(anthropicBody)
      });
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
      return jsonResponse(
        {
          error: "Anthropic API request failed.",
          status: anthropicResponse.status,
          details: safeJsonParse(rawText) || rawText
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
    "aiSummary"
  ];

  for (const key of requiredStrings) {
    if (!data[key]) {
      throw new Error('Missing field "' + key + '".');
    }
  }

  if (!["High", "Medium", "Low"].includes(data.aiEnergy)) {
    throw new Error('Invalid value for "aiEnergy".');
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
