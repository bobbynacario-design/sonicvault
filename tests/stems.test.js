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

// The same zip the way Suno's stems download writes it: ZIP64, with
// ffffffff in the usual size and position fields, the real ones in each
// file's extra field and in a ZIP64 end record.
function makeZip64(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(([name, text]) => {
    const raw = Buffer.from(text);
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(raw.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(BigInt(offset), 20);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0xffffffff, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf, extra);
    offset += 30 + nameBuf.length + data.length;
  });
  const dir = Buffer.concat(centrals);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(files.length), 24);
  record.writeBigUInt64LE(BigInt(files.length), 32);
  record.writeBigUInt64LE(BigInt(dir.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + dir.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return new Blob([Buffer.concat([...locals, dir, record, locator, end])]);
}

test("Suno's ZIP64 stems zip opens", async () => {
  const zip = makeZip64([["The World Won't End Stems/", ""], ["The World Won't End Stems/0 Lead Vocals.mp3", "voice ".repeat(50)], ["The World Won't End Stems/3 Bass.mp3", "bass ".repeat(20)]]);
  const entries = await g.readZipEntries(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.size]), [["0 Lead Vocals.mp3", 300], ["3 Bass.mp3", 100]]);
  assert.equal(await (await entries[1].read()).text(), "bass ".repeat(20));
});

test("a zip cut short says so, instead of reading past its end", async () => {
  const whole = Buffer.from(await makeZip([["0 Lead Vocals.mp3", "voice ".repeat(50)]], true).arrayBuffer());
  const end = whole.subarray(whole.length - 22);
  end.writeUInt32LE(0x7fffffff, 16);
  await assert.rejects(g.readZipEntries(new Blob([whole])), /damaged or didn’t finish downloading/);
});
