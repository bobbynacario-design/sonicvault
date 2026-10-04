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
  // A template cannot describe a song, so the local engine does not try.
  assert.equal(a.aiSummary, "");
});

// The opening of "Still In": a reflective song about turning 47, in poker
// terms. The local tagger once called it "energetic synthwave" (from "run"
// inside "turn") with "low energy" (from "still"), themed "coastal reset and
// night-drive escape", and wrote a review saying so.
const STILL_IN = {
  title: "Still In (1)",
  genre: "Country",
  mood: "Warm",
  lyrics: [
    "[Verse 1]",
    "Woke up September, one more turn around the sun",
    "Forty-seven candles and I'm not done, not done",
    "Counted out the quiet years like chips across the felt",
    "Some I played too careful, some I never even dealt",
    "[Chorus]",
    "Still in, still holding, deal me one more night",
    "Still in, still holding, deal me one more night",
    "Still in, still holding, deal me one more night"
  ].join("\n")
};

test("keywords count only as whole words, and 'still' is not a tempo", () => {
  const out = g.buildLocalMetadataSuggestion(STILL_IN);
  assert.equal(out.aiMood, "Warm", "'run' inside 'turn' is not a mood");
  assert.equal(out.aiGenre, "Country", "nothing in the words overrides the chosen genre");
  assert.equal(out.aiEnergy, "Medium", "'still' says nothing about energy");
  assert.equal(out.aiTheme, "", "one 'sun' does not make a song coastal");
  assert.equal(out.aiSummary, "");
  assert.equal(out.aiEra, "");
  assert.equal(out.aiVocalStyle, "Lead vocal");
  assert.equal(g.hasKeyword("one more turn around the sun", "run"), false);
  assert.equal(g.hasKeyword("we run", "run"), true);
  assert.equal(g.hasKeyword("a slow jam tonight", "slow jam"), true);
  assert.equal(g.hasKeyword("r&b soul", "r&b"), true);
});

test("local tags are words the song repeats, not one-off words or lines", () => {
  const out = g.buildLocalMetadataSuggestion(STILL_IN);
  assert.deepEqual(out.aiTags, ["holding", "night", "deal"]);
  assert.equal(g.buildLocalMetadataSuggestion({ title: "X", lyrics: "one two three" }).aiTags.length, 0);
});

test("basic suggestions never overwrite a description Claude wrote", () => {
  const track = { title: "Still In", genre: "Country", aiSource: "claude", aiSummary: "A gambler's birthday toast.", aiTags: ["poker", "birthday"], aiTheme: "Aging" };
  g.applyAIMetadataToDraft(track, g.buildLocalMetadataSuggestion(STILL_IN), false);
  assert.equal(track.aiSummary, "A gambler's birthday toast.");
  assert.deepEqual(track.aiTags, ["poker", "birthday"]);
  assert.equal(track.aiSource, "claude");
  // A song with no AI description takes them.
  const bare = { title: "Still In", genre: "Country" };
  g.applyAIMetadataToDraft(bare, g.buildLocalMetadataSuggestion(STILL_IN), false);
  assert.equal(bare.aiSource, "local");
  assert.deepEqual(bare.aiTags, ["holding", "night", "deal"]);
});

test("reviews the local tagger wrote are dropped when read; real ones are kept", () => {
  const old = {
    aiSource: "local",
    aiSummary: "“Still In (1)” leans into coastal reset and night-drive escape as a energetic synthwave release, framing the hook around still in 1. The lyric sheet points to a low-energy arrangement with focused production detail and a anthemic lead delivery."
  };
  assert.equal(g.getTrackSummary(old), "");
  assert.equal(g.getTrackSummary({ aiSource: "local", aiSummary: '"X" lands as an uplifting pop cut built around hope.' }), "");
  assert.equal(g.getTrackSummary({ aiSummary: "A curated SonicVault release shaped from the track title, prompt, and lyrics." }), "");
  // Claude's summaries, and anything a person wrote, stay.
  assert.equal(g.getTrackSummary({ aiSource: "claude", aiSummary: '"X" leans into something real.' }), '"X" leans into something real.');
  assert.equal(g.getTrackSummary({ aiSource: "local", aiSummary: "My own words." }), "My own words.");
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

test("the AI's tags lead, and lyric words only fill the space left", () => {
  const track = {
    lyrics: "one hour take not because other one hour take not because other",
    aiTags: ["introspective", "americana", "slow burn"],
    aiTheme: "Nostalgia, Mindfulness, Regret",
    genre: "Other", mood: "Reflective", source: "Suno",
  };
  const tags = g.getTrackTags(track);
  assert.deepEqual(tags.slice(0, 6), ["introspective", "americana", "slow burn", "Nostalgia", "Mindfulness", "Regret"]);
  assert.equal(tags.length, 8);
  assert.ok(!tags.includes("Suno") && !tags.includes("Other"), JSON.stringify(tags));
});

test("the AI's tags are kept as given, with lyric words only when it gave none", () => {
  const lyrics = "weather weather weather whole whole got got the background";
  const given = g.normalizeAIMetadata({ aiTags: ["Introspective", "Love Song"] }, { title: "X", lyrics });
  assert.deepEqual(given.aiTags, ["Introspective", "Love Song"]);
  const none = g.normalizeAIMetadata({}, { title: "X", lyrics });
  assert.deepEqual(none.aiTags.slice(0, 3), ["weather", "whole", "got"]);
});

test("lyric words padded onto tags saved before the fix are dropped when read", () => {
  const track = {
    title: "You Were the Weather",
    lyrics: "you were the weather I lived in\nthe weather the whole time\nI got it wrong, I got it late, the whole weather",
    aiTags: ["Introspective", "Acoustic", "Love Song", "Poetic", "Vulnerable", "got", "weather", "whole"],
    aiSource: "claude",
  };
  assert.deepEqual(g.getTrackAITags(track), ["Introspective", "Acoustic", "Love Song", "Poetic", "Vulnerable"]);
  // A lowercase tag that is not one of the track's words stays.
  assert.deepEqual(g.getTrackAITags({ ...track, aiTags: ["Poetic", "slow burn", "weather", "rain"] }), ["Poetic", "slow burn", "weather", "rain"]);
  // The local tagger's words are its tags.
  assert.deepEqual(g.getTrackAITags({ ...track, aiSource: "local" }), track.aiTags);
});

test("the prompt excerpt falls back from prompt to summary to lyrics to a stock line", () => {
  assert.equal(g.getTrackPromptExcerpt({ prompt: "p", aiSummary: "s" }), "p");
  assert.equal(g.getTrackPromptExcerpt({ aiSummary: "s", lyrics: "l" }), "s");
  assert.equal(g.getTrackPromptExcerpt({ lyrics: "line one\nline two" }), "line one line two");
  assert.equal(g.getTrackPromptExcerpt({ mood: "Chill", source: "Udio" }), g.promptFallback({ mood: "Chill", source: "Udio" }));
});

test("songs without an AI description are the ones to describe; new imports go without asking", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const watcher = { id: "t-1791000000000", title: "Fresh", genre: "Other", mood: "Energetic", created: "2026-10-03" };
  const old = { id: "t-1700000000000", title: "Old", created: "2025-01-01" };
  const fallback = { id: "t-1791000000001", title: "Tagged", created: "2026-10-03", aiSource: "local", aiGeneratedAt: "2026-10-03T00:00:00Z" };
  const claude = { title: "Done", aiSource: "claude", aiSummary: "A song." };
  assert.equal(g.needsDescription(watcher), true);
  assert.equal(g.needsDescription(old), true);
  assert.equal(g.needsDescription(fallback), true);
  assert.equal(g.needsDescription(claude), false);
  assert.equal(g.needsDescription({ title: "  " }), false);
  // Only never-described songs from the last two weeks are done unasked.
  assert.equal(g.isNewUndescribed(watcher, now), true);
  assert.equal(g.isNewUndescribed(old, now), false);
  assert.equal(g.isNewUndescribed(fallback, now), false);
  assert.equal(g.isNewUndescribed(claude, now), false);
});
