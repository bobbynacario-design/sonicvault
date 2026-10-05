"use strict";
// Suno's stems: reading the zip, and telling the voices from the music.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const g = require("./helpers/data-scripts.js").loadDataScripts();

// A zip the way a browser download is laid out: local headers, then the
// central directory, then its end record. deflate: whether to compress.
function makeZip(files, deflate) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(([name, text]) => {
    const raw = Buffer.from(text);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Blob([Buffer.concat([...locals, dir, end])]);
}

test("a stems zip opens, compressed or not, without its folders", async () => {
  for (const deflate of [false, true]) {
    const zip = makeZip([["The World Won't End Stems/", ""], ["The World Won't End Stems/0 Lead Vocals.mp3", "voice ".repeat(50)], ["The World Won't End Stems/2 Drums.mp3", "drums"]], deflate);
    const entries = await g.readZipEntries(zip);
    assert.deepEqual(entries.map((e) => e.name), ["0 Lead Vocals.mp3", "2 Drums.mp3"]);
    assert.equal(await (await entries[0].read()).text(), "voice ".repeat(50));
    assert.equal(await (await entries[1].read()).text(), "drums");
  }
  await assert.rejects(g.readZipEntries(new Blob(["not a zip"])), /isn’t a zip/);
});

test("voices are told from the music by their names", () => {
  assert.deepEqual(g.classifyStem("0 Lead Vocals.mp3"), { label: "Lead Vocals", voice: "lead" });
  assert.deepEqual(g.classifyStem("1 Backing Vocals.mp3"), { label: "Backing Vocals", voice: "backing" });
  assert.deepEqual(g.classifyStem("2 Drums.mp3"), { label: "Drums", voice: "" });
  assert.equal(g.classifyStem("Vocals.wav").voice, "lead");
  assert.equal(g.classifyStem("Song (Instrumental).mp3").voice, "");
  const names = ["0 Lead Vocals.mp3", "1 Backing Vocals.mp3", "2 Drums.mp3", "3 Bass.mp3", "7 Synth.mp3"];
  assert.deepEqual(g.defaultStemPick(names), [false, false, true, true, true]);
  assert.ok(g.isAudioFileName("4 Guitar.mp3") && !g.isAudioFileName("notes.txt"));
});
