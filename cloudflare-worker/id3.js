// Cover art from an MP3's ID3 tag, for share-link previews (share.js).
// A copy of the parser in js/data/artwork.js, which the app uses to show
// the same covers: everything between the BEGIN/END markers must match it
// exactly -- tests/worker-share.test.js fails when the two drift apart.

// BEGIN copied from js/data/artwork.js
function readSyncsafe(bytes, i) {
  return ((bytes[i] & 0x7f) << 21) | ((bytes[i + 1] & 0x7f) << 14) | ((bytes[i + 2] & 0x7f) << 7) | (bytes[i + 3] & 0x7f);
}

function readUint32(bytes, i) {
  return ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
}

// Bytes needed to hold the whole ID3v2 tag at the head of a file (header,
// body, optional footer), or 0 when the file does not open with one.
function id3TagLength(bytes) {
  if (!bytes || bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  if (bytes[3] < 2 || bytes[3] > 4) return 0;
  return 10 + readSyncsafe(bytes, 6) + ((bytes[5] & 0x10) ? 10 : 0);
}

// Undo ID3 unsynchronisation: every 0xFF 0x00 pair was written for 0xFF.
function removeUnsync(bytes) {
  var out = new Uint8Array(bytes.length);
  var n = 0;
  for (var i = 0; i < bytes.length; i++) {
    out[n++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function asciiOf(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// The picture's real type from its first bytes; the declared MIME string is
// free text and not always right.
function sniffImageMime(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 7 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length > 5 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data.length > 11 && asciiOf(data.subarray(0, 4)) === 'RIFF' && asciiOf(data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return '';
}

// APIC (v2.3/2.4) and PIC (v2.2) share a body: text encoding, image format,
// picture type, a description in that encoding, then the image bytes.
function parsePictureFrame(body, isV22) {
  if (!body || body.length < 4) return null;
  var encoding = body[0];
  var p;
  if (isV22) {
    p = 4;
  } else {
    p = 1;
    while (p < body.length && body[p] !== 0) p++;
    p++;
  }
  var type = body[p];
  p++;
  if (encoding === 1 || encoding === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p++;
  }
  if (p >= body.length) return null;
  var data = body.subarray(p);
  var mime = sniffImageMime(data);
  return mime ? { mime: mime, type: type, data: data } : null;
}

// Every frame in an ID3v2.2/2.3/2.4 tag as { id, body }, bodies unwrapped
// and ready to read. Compressed or encrypted frames are rare enough to skip.
// Empty when there is no tag or it is cut short.
function readID3Frames(bytes) {
  var total = id3TagLength(bytes);
  if (!total || bytes.length < total) return [];
  var major = bytes[3];
  var flags = bytes[5];
  var tag = bytes.subarray(10, total - ((flags & 0x10) ? 10 : 0));
  // v2.4 unsynchronises per frame; before it, the whole tag at once.
  if ((flags & 0x80) && major < 4) tag = removeUnsync(tag);
  var pos = 0;
  if ((flags & 0x40) && major > 2) {
    pos = major === 4 ? readSyncsafe(tag, 0) : readUint32(tag, 0) + 4;
  }
  var idLength = major === 2 ? 3 : 4;
  var headLength = major === 2 ? 6 : 10;
  var frames = [];
  while (pos + headLength <= tag.length) {
    var id = asciiOf(tag.subarray(pos, pos + idLength));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    var size = major === 2
      ? (tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5]
      : (major === 4 ? readSyncsafe(tag, pos + 4) : readUint32(tag, pos + 4));
    var end = pos + headLength + size;
    if (size <= 0 || end > tag.length) break;
    var body = tag.subarray(pos + headLength, end);
    var format = major === 2 ? 0 : tag[pos + 9];
    var packed = major === 4 ? (format & 0x0c) : (major === 3 ? (format & 0xc0) : 0);
    if (!packed) {
      if (major === 4) {
        if (format & 0x40) body = body.subarray(1);
        if (format & 0x01) body = body.subarray(4);
        if (format & 0x02) body = removeUnsync(body);
      } else if (major === 3 && (format & 0x20)) {
        body = body.subarray(1);
      }
      frames.push({ id: id, body: body });
    }
    pos = end;
  }
  return frames;
}

// The front cover (picture type 3), else the first picture the tag carries;
// null when there is none or the tag is cut short.
function findEmbeddedArt(bytes) {
  var best = null;
  readID3Frames(bytes).some(function(frame) {
    if (frame.id !== 'APIC' && frame.id !== 'PIC') return false;
    var pic = parsePictureFrame(frame.body, frame.id === 'PIC');
    if (pic && (!best || (pic.type === 3 && best.type !== 3))) best = pic;
    return !!(best && best.type === 3);
  });
  return best ? { mime: best.mime, data: best.data } : null;
}
// END copied from js/data/artwork.js

export { id3TagLength, findEmbeddedArt };
