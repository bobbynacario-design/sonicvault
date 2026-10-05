// Suno's stems, made into a karaoke track (js/features/singer.js). Suno Pro
// gives a song as a zip of parts -- "0 Lead Vocals.mp3", "1 Backing
// Vocals.mp3", "2 Drums.mp3"... -- and the instrumental is every part but
// the voices, added together. This file reads the zip and sorts the parts;
// the feature decodes, mixes, encodes and uploads.

// The files in a zip: [{ name, size, read() -> Promise<Blob> }]. Handles the
// two ways zips store files (as they are, and deflated), which is all a
// browser download produces; folders are left out. Also ZIP64, which
// Suno's stems download uses even for a small zip: the usual size and
// position fields hold ffffffff and the real ones are in a ZIP64 record
// (for the whole zip) and an extra field (for each file).
async function readZipEntries(blob) {
  var bytes = new Uint8Array(await blob.arrayBuffer());
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var end = -1;
  for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('That isn’t a zip file.');
  var count = view.getUint16(end + 10, true);
  var at = view.getUint32(end + 16, true);
  if ((count === 0xffff || at === 0xffffffff) && end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    var record = zipUint64(view, end - 12);
    zipCheck(bytes, record, 56);
    if (view.getUint32(record, true) !== 0x06064b50) throw new Error('That zip is damaged.');
    count = zipUint64(view, record + 32);
    at = zipUint64(view, record + 48);
  }
  var decoder = new TextDecoder();
  var entries = [];
  for (var n = 0; n < count; n++) {
    zipCheck(bytes, at, 46);
    if (view.getUint32(at, true) !== 0x02014b50) break;
    var method = view.getUint16(at + 10, true);
    var compressed = view.getUint32(at + 20, true);
    var size = view.getUint32(at + 24, true);
    var nameLength = view.getUint16(at + 28, true);
    var extraLength = view.getUint16(at + 30, true);
    var commentLength = view.getUint16(at + 32, true);
    var local = view.getUint32(at + 42, true);
    zipCheck(bytes, at + 46, nameLength + extraLength);
    var name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // ZIP64's extra field (id 1): the real values, in this order, for
    // just the fields that hold ffffffff.
    for (var x = at + 46 + nameLength, xEnd = x + extraLength; x + 4 <= xEnd;) {
      var id = view.getUint16(x, true), length = view.getUint16(x + 2, true), v = x + 4;
      if (id === 1) {
        if (size === 0xffffffff && v + 8 <= x + 4 + length) { size = zipUint64(view, v); v += 8; }
        if (compressed === 0xffffffff && v + 8 <= x + 4 + length) { compressed = zipUint64(view, v); v += 8; }
        if (local === 0xffffffff && v + 8 <= x + 4 + length) { local = zipUint64(view, v); v += 8; }
      }
      x += 4 + length;
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (/\/$/.test(name)) continue;
    entries.push(zipEntry(bytes, view, name, method, local, compressed, size));
  }
  return entries;
}

function zipUint64(view, at) {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 4294967296;
}

// Reading past the end means a damaged or cut-short download.
function zipCheck(bytes, at, length) {
  if (!(at >= 0) || at + length > bytes.length) throw new Error('That zip is damaged or didn’t finish downloading.');
}

function zipEntry(bytes, view, name, method, local, compressed, size) {
  return {
    name:name.split('/').pop(),
    size:size,
    read:function() {
      try {
        zipCheck(bytes, local, 30);
        var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        zipCheck(bytes, start, compressed);
      } catch (e) {
        return Promise.reject(e);
      }
      var data = bytes.slice(start, start + compressed);
      if (method === 0) return Promise.resolve(new Blob([data]));
      if (method === 8) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      return Promise.reject(new Error(name + ' is packed in a way the browser can’t open.'));
    }
  };
}

// What a part is, from its file name: { label, voice: 'lead' | 'backing' | '' }.
function classifyStem(fileName) {
  var label = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/^\s*\d+\s*[-_.]?\s*/, '').trim() || String(fileName || '');
  var lower = label.toLowerCase();
  var voice = '';
  if (/vocal|voice|vox|acapella|a cappella/.test(lower)) voice = /back|bgv|harmon|choir|ad.?lib/.test(lower) ? 'backing' : 'lead';
  return { label:label, voice:voice };
}

function isAudioFileName(name) {
  return /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(String(name || ''));
}

// The parts ticked to begin with: everything that isn't a voice.
function defaultStemPick(names) {
  return names.map(function(name) { return !classifyStem(name).voice; });
}

// Whether a file picked as the instrumental is really the song itself, voice
// and all: Suno's MP3 download sits next to the stems zip with the song's
// name ("The World Won't End.mp3"), and attaching it makes Singer off play
// the singer. The same size as the uploaded song, or the song's title with
// nothing saying instrumental.
function looksLikeTheSong(track, fileName, fileSize) {
  if (!track) return false;
  if (track.fileSize && fileSize && Number(track.fileSize) === Number(fileSize)) return true;
  var name = String(fileName || '');
  if (/instrumental|karaoke|inst\b|no.?vocals?|minus.?one|backing.?track|accompaniment/i.test(name)) return false;
  var bare = function(text) {
    return String(text || '').replace(/\.[a-z0-9]+$/i, '').replace(/\s*\(\d+\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  };
  return !!bare(track.title) && bare(name) === bare(track.title);
}
