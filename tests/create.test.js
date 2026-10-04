"use strict";
// Songs made on the Create page: reading Lyria's answer and tagging the MP3.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
const MPEG = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be32 = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

function frame(major, id, body) {
  return [...ascii(id), ...(major === 4 ? syncsafe(body.length) : be32(body.length)), 0, 0, ...body];
}
function tag(major, frames) {
  const body = frames.flat();
  return Uint8Array.from([...ascii("ID3"), major, 0, 0, ...syncsafe(body.length), ...body]);
}
const withAudio = (head) => Uint8Array.from([...head, ...MPEG]);

test("the audio and text come out of a Gemini answer, in either part order and either casing", () => {
  const camel = g.readLyriaResponse({
    candidates: [{ content: { parts: [
      { inlineData: { mimeType: "audio/mp3", data: b64(MPEG) } },
      { text: "[Verse 1]\nA line" }
    ] }, finishReason: "STOP" }]
  });
  assert.equal(camel.audio.mime, "audio/mp3");
  assert.deepEqual([...g.base64ToBytes(camel.audio.data)], [...MPEG]);
  assert.deepEqual(camel.texts, ["[Verse 1]\nA line"]);
  assert.equal(camel.reason, "");

  const snake = g.readLyriaResponse({
    candidates: [{ content: { parts: [{ text: "notes" }, { inline_data: { mime_type: "audio/wav", data: "AAAA" } }] } }]
  });
  assert.equal(snake.audio.mime, "audio/wav");
  assert.deepEqual(snake.texts, ["notes"]);
});

test("no audio comes with the reason Gemini gave, explained", () => {
  const blocked = g.readLyriaResponse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } });
  assert.equal(blocked.audio, null);
  assert.equal(blocked.reason, "PROHIBITED_CONTENT");
  assert.match(g.describeLyriaRefusal(blocked.reason), /turned this one down/);

  const finished = g.readLyriaResponse({ candidates: [{ content: { parts: [{ text: "hm" }] }, finishReason: "SAFETY" }] });
  assert.equal(finished.reason, "SAFETY");
  assert.match(g.describeLyriaRefusal("OTHER"), /didn.t send any audio \(other\)/);
  assert.equal(g.readLyriaResponse(null).audio, null);
});

test("a lyric sheet comes from plain tagged text, a JSON structure, or not at all", () => {
  assert.equal(g.lyricsFromLyriaText(["Lyrics:\n[Verse 1]\nOne\nTwo"]), "[Verse 1]\nOne\nTwo");
  assert.equal(g.lyricsFromLyriaText(["first\nsecond\nthird\nfourth"]), "first\nsecond\nthird\nfourth");
  // A caption is not lyrics.
  assert.equal(g.lyricsFromLyriaText(["An upbeat indie-pop song with warm vocals."]), "");
  assert.equal(g.lyricsFromLyriaText([JSON.stringify({ lyrics: "[Chorus]\nHold on" })]), "[Chorus]\nHold on");
  const sections = JSON.stringify({ structure: [
    { section: "Verse 1", lines: ["Out on the water", "Under the light"] },
    { section: "Chorus", lyrics: "Carry me home" },
    { section: "Instrumental break" }
  ] });
  assert.equal(g.lyricsFromLyriaText(["caption first", "```json\n" + sections + "\n```"]),
    "[Verse 1]\nOut on the water\nUnder the light\n\n[Chorus]\nCarry me home");
  assert.equal(g.lyricsFromLyriaText([JSON.stringify({ bpm: 120, key: "G major" })]), "");
});

test("a song saved without a title is named from its first sung line, else its sound", () => {
  assert.equal(g.deriveSongTitle("  Kept  ", "[Verse]\nIgnored", ""), "Kept");
  assert.equal(g.deriveSongTitle("", "[Verse 1]\nOut on the water, under the long light.\nMore", ""), "Out on the water");
  assert.equal(g.deriveSongTitle("", "[Verse]\nWhen the last bus leaves the station and the town goes dark", ""), "When the last bus leaves the");
  assert.equal(g.deriveSongTitle("", "[Verse]\nHey, where did you go", ""), "Hey, where did you go");
  assert.equal(g.deriveSongTitle("", "[Chorus]\nCarry me home!", ""), "Carry me home");
  assert.equal(g.deriveSongTitle("", "", "dreamy synth-pop with airy vocals, 100 BPM"), "Dreamy synth-pop with airy");
  assert.equal(g.deriveSongTitle("", "", ""), "Untitled song");
  assert.equal(g.songFileName("Out on the Water / Part 2?"), "Out on the Water Part 2.mp3");
  assert.equal(g.songFileName(""), "Untitled song.mp3");
});

test("tagging an untagged MP3 puts title, lyrics and cover where the readers find them", () => {
  const lyrics = "[Verse 1]\nÜber the water — café light\n\n[Chorus]\nCarry me home";
  const out = g.writeSongTag(MPEG, { title: "Still été", lyrics, cover: { mime: "image/jpeg", data: JPEG } });
  assert.equal(out[3], 3, "Suno's version, v2.3");
  assert.deepEqual([...out.subarray(out.length - MPEG.length)], [...MPEG], "the audio is untouched");
  assert.equal(g.id3TagLength(out), out.length - MPEG.length);
  assert.equal(g.findEmbeddedLyrics(out), lyrics);
  const art = g.findEmbeddedArt(out);
  assert.equal(art.mime, "image/jpeg");
  assert.deepEqual([...art.data], [...JPEG]);
  const title = g.readID3Frames(out).find((f) => f.id === "TIT2");
  assert.equal(g.decodeID3Text(title.body.subarray(1), title.body[0]), "Still été");
});

test("an existing tag keeps its other frames and its version; the written ones replace theirs", () => {
  const old = withAudio(tag(4, [
    frame(4, "TIT2", [3, ...ascii("Old name")]),
    frame(4, "TXXX", [3, ...ascii("source"), 0, ...ascii("lyria")]),
    frame(4, "USLT", [3, ...ascii("eng"), 0, ...ascii("old words")])
  ]));
  const out = g.writeSongTag(old, { title: "New name", lyrics: "[Verse]\nnew words" });
  assert.equal(out[3], 4);
  const ids = g.readID3Frames(out).map((f) => f.id);
  assert.deepEqual(ids.sort(), ["TIT2", "TXXX", "USLT"]);
  assert.equal(g.findEmbeddedLyrics(out), "[Verse]\nnew words");
  const title = g.readID3Frames(out).find((f) => f.id === "TIT2");
  assert.equal(g.decodeID3Text(title.body.subarray(1), title.body[0]), "New name");
  const txxx = g.readID3Frames(out).find((f) => f.id === "TXXX");
  assert.deepEqual([...txxx.body], [3, ...ascii("source"), 0, ...ascii("lyria")]);
  assert.deepEqual([...out.subarray(out.length - MPEG.length)], [...MPEG]);
  assert.equal(g.findEmbeddedArt(out), null);
});

test("MP3 bytes are told apart from anything else", () => {
  assert.equal(g.looksLikeMP3(MPEG), true);
  assert.equal(g.looksLikeMP3(tag(3, [])), true);
  assert.equal(g.looksLikeMP3(Uint8Array.from(ascii("RIFF....WAVE"))), false);
  assert.equal(g.looksLikeMP3(null), false);
});
