"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const coverIds = () => g.COVER_STYLES.map((s) => s.id);

test("parseJSONFromText finds the JSON object inside chatty model output", () => {
  assert.deepEqual(g.parseJSONFromText('{"aiMood":"Chill"}'), { aiMood: "Chill" });
  assert.deepEqual(g.parseJSONFromText('Here you go: {"aiMood":"Chill"} -- enjoy'), { aiMood: "Chill" });
  assert.equal(g.parseJSONFromText("no json here"), null);
  assert.equal(g.parseJSONFromText(""), null);
});

test("extractAIMetadataPayload unwraps every response shape the endpoint may send", () => {
  const meta = { aiMood: "Chill" };
  assert.deepEqual(g.extractAIMetadataPayload({ metadata: meta }), meta);
  assert.deepEqual(g.extractAIMetadataPayload({ data: { metadata: meta } }), meta);
  assert.deepEqual(g.extractAIMetadataPayload({ choices: [{ message: { content: JSON.stringify(meta) } }] }), meta);
  assert.deepEqual(g.extractAIMetadataPayload({ output_text: "result: " + JSON.stringify(meta) }), meta);
  assert.deepEqual(g.extractAIMetadataPayload(JSON.stringify(meta)), meta);
  assert.deepEqual(g.extractAIMetadataPayload(meta), meta);
  assert.equal(g.extractAIMetadataPayload(null), null);
});

test("normalizeAIMetadata accepts short field names and fills safe defaults", () => {
  const out = g.normalizeAIMetadata({ genre: "Rock", tags: "night, drive" }, { title: "X", lyrics: "damn it all" });
  assert.equal(out.aiGenre, "Rock");
  assert.equal(out.aiMood, "Dreamy");
  assert.equal(out.aiEnergy, "Medium");
  assert.ok(out.aiTags.includes("night") && out.aiTags.includes("drive"));
  assert.equal(out.aiExplicit, true);
  assert.equal(out.aiMetadataVersion, g.AI_METADATA_VERSION);
  assert.ok(coverIds().includes(out.coverStyle));
  assert.equal(g.normalizeAIMetadata({ coverStyle: "MONO" }, { title: "X" }).coverStyle, "mono");
  assert.equal(g.normalizeAIMetadata({ aiExplicit: false }, { lyrics: "damn" }).aiExplicit, false);
});

test("the local suggestion engine is deterministic and fills every field", () => {
  const input = {
    title: "Neon Highway",
    prompt: "synthwave night drive, retro arps",
    lyrics: "[Verse]\nneon lights on the highway\n[Chorus]\nneon lights on the highway",
  };
  const a = g.buildLocalMetadataSuggestion(input);
  const b = g.buildLocalMetadataSuggestion(input);
  delete a.aiGeneratedAt;
  delete b.aiGeneratedAt;
  assert.deepEqual(a, b);
  assert.equal(a.aiGenre, "Synthwave");
  assert.equal(a.aiSource, "local");
  assert.ok(coverIds().includes(a.coverStyle));
  assert.ok(a.aiTags.length > 0 && a.aiTags.length <= 10);
  assert.ok(a.aiSummary.includes("Neon Highway"));
});

test("AI suggestions never overwrite a genre or mood the user picked, unless forced", () => {
  const meta = { aiGenre: "Pop", aiMood: "Warm", coverStyle: "tape", aiTags: ["a"] };
  const item = { title: "X", genre: "Rock", genreEdited: true, mood: "Chill", moodEdited: false };
  g.applyAIMetadataToDraft(item, meta, false);
  assert.equal(item.genre, "Rock");
  assert.equal(item.mood, "Warm");
  assert.equal(item.coverStyle, "tape");
  assert.equal(item.aiStatus, "done");
  g.applyAIMetadataToDraft(item, meta, true);
  assert.equal(item.genre, "Pop");
});

test("track tags are capped at eight and deduped across sources", () => {
  const track = {
    prompt: "neon neon synthwave night drive chrome skyline arps",
    lyrics: "neon lights neon lights midnight highway",
    aiTags: ["Neon", "Night drive", "Chrome"],
    genre: "Synthwave", mood: "Energetic", source: "Suno",
  };
  const tags = g.getTrackTags(track);
  assert.ok(tags.length <= 8);
  assert.equal(new Set(tags.map((t) => t.toLowerCase())).size, tags.length);
  assert.deepEqual(g.sanitizeMetadataArray("a, b|c\nA"), ["a", "b", "c"]);
});

test("the prompt excerpt falls back from prompt to summary to lyrics to a stock line", () => {
  assert.equal(g.getTrackPromptExcerpt({ prompt: "p", aiSummary: "s" }), "p");
  assert.equal(g.getTrackPromptExcerpt({ aiSummary: "s", lyrics: "l" }), "s");
  assert.equal(g.getTrackPromptExcerpt({ lyrics: "line one\nline two" }), "line one line two");
  assert.equal(g.getTrackPromptExcerpt({ mood: "Chill", source: "Udio" }), g.promptFallback({ mood: "Chill", source: "Udio" }));
});
