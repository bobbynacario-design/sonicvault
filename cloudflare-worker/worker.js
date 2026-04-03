const MODEL_NAME = "gemini-1.5-flash";

const SYSTEM_PROMPT = [
  "You are a strict music metadata extraction engine for SonicVault.",
  "Return ONLY a raw JSON object.",
  "Do not use markdown.",
  "Do not wrap the JSON in code fences.",
  "Do not add commentary before or after the JSON.",
  "Do not omit keys.",
  "Do not add extra keys.",
  'The JSON must match this exact schema:',
  '{ "aiGenre": "string", "aiMood": "string", "aiTheme": "string", "aiEnergy": "High/Medium/Low", "aiVocalStyle": "string", "aiEra": "string", "aiInstruments": ["array", "of", "strings"], "aiTags": ["array", "of", "strings"], "aiSummary": "A 2 sentence editorial summary", "aiExplicit": boolean }',
  "Rules:",
  "- aiEnergy must be exactly one of: High, Medium, Low.",
  "- aiSummary must be exactly 2 sentences.",
  "- aiInstruments must be a short array of strings.",
  "- aiTags must be a short array of strings.",
  "- Use the title, prompt, and lyrics together.",
  "- Be concise, useful, and editorial."
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    aiGenre: { type: "string" },
    aiMood: { type: "string" },
    aiTheme: { type: "string" },
    aiEnergy: { type: "string", enum: ["High", "Medium", "Low"] },
    aiVocalStyle: { type: "string" },
    aiEra: { type: "string" },
    aiInstruments: { type: "array", items: { type: "string" } },
    aiTags: { type: "array", items: { type: "string" } },
    aiSummary: { type: "string" },
    aiExplicit: { type: "boolean" }
  },
  required: [
    "aiGenre",
    "aiMood",
    "aiTheme",
    "aiEnergy",
    "aiVocalStyle",
    "aiEra",
    "aiInstruments",
    "aiTags",
    "aiSummary",
    "aiExplicit"
  ]
};

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

    if (!lyrics) {
      return jsonResponse(
        { error: 'Missing required field "lyrics".' },
        400,
        request,
        env
      );
    }

    if (!env.GEMINI_API_KEY) {
      return jsonResponse(
        { error: "Worker secret GEMINI_API_KEY is not configured." },
        500,
        request,
        env
      );
    }

    const model = cleanString(payload.model) || MODEL_NAME;
    const geminiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent";

    const geminiBody = {
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Track title:",
                title,
                "",
                "Prompt / notes:",
                prompt || "(none provided)",
                "",
                "Lyrics:",
                lyrics
              ].join("\n")
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.25,
        topP: 0.9,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA
      }
    };

    let geminiResponse;
    try {
      geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify(geminiBody)
      });
    } catch (err) {
      return jsonResponse(
        {
          error: "Could not reach Gemini.",
          details: cleanString(err && err.message) || "Network request failed."
        },
        502,
        request,
        env
      );
    }

    const rawText = await geminiResponse.text();
    if (!geminiResponse.ok) {
      return jsonResponse(
        {
          error: "Gemini API request failed.",
          status: geminiResponse.status,
          details: safeJsonParse(rawText) || rawText
        },
        geminiResponse.status === 429 ? 429 : 502,
        request,
        env
      );
    }

    let geminiData;
    try {
      geminiData = JSON.parse(rawText);
    } catch (err) {
      return jsonResponse(
        { error: "Gemini returned invalid JSON.", raw: rawText },
        502,
        request,
        env
      );
    }

    const text = extractGeminiText(geminiData);
    if (!text) {
      return jsonResponse(
        { error: "Gemini returned no text content.", raw: geminiData },
        502,
        request,
        env
      );
    }

    let metadata;
    try {
      metadata = extractJsonObject(text);
      metadata = normalizeMetadata(metadata);
      validateMetadata(metadata);
    } catch (err) {
      return jsonResponse(
        {
          error: "Gemini returned invalid metadata JSON.",
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

function extractGeminiText(data) {
  try {
    return (
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text
    ) || "";
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
