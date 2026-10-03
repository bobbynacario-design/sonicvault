// What an audio file carries in its ID3 tag -- the cover picture and the
// lyric sheet -- and a palette read from the picture's pixels. Suno writes
// both into every MP3 it exports, inside the first ~30KB: a 360x360 JPEG
// (APIC, picture type 3) and the full lyrics (USLT).
// Pure: bytes and pixel arrays in, plain values out.

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

// ID3 text in its declared encoding: 0 Latin-1, 1 UTF-16 with a byte-order
// mark, 2 UTF-16BE, 3 UTF-8.
function decodeID3Text(bytes, encoding) {
  if (!bytes || !bytes.length) return '';
  if (encoding === 0) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  var label = encoding === 3 ? 'utf-8' : 'utf-16le';
  if (encoding === 2) label = 'utf-16be';
  if (encoding === 1 && bytes.length > 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) bytes = bytes.subarray(2);
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (e) {
    return '';
  }
}

// Offset just past a string terminated in this encoding (one zero byte, or
// two aligned ones for UTF-16).
function skipID3String(body, p, encoding) {
  if (encoding === 1 || encoding === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    return p + 2;
  }
  while (p < body.length && body[p] !== 0) p++;
  return p + 1;
}

// The lyric sheet from USLT (v2.3/2.4) or ULT (v2.2): encoding, a language
// code, a description, then the text. The longest sheet wins when a file
// carries more than one. Tidied for display: stray byte-order marks gone,
// line endings normalised, runs of blank lines folded to one. '' if none.
function findEmbeddedLyrics(bytes) {
  var best = '';
  readID3Frames(bytes).forEach(function(frame) {
    if ((frame.id !== 'USLT' && frame.id !== 'ULT') || frame.body.length < 5) return;
    var encoding = frame.body[0];
    var start = skipID3String(frame.body, 4, encoding);
    var text = decodeID3Text(frame.body.subarray(start), encoding)
      .replace(/\uFEFF/g, '')
      .replace(/\u0000+$/, '')
      .replace(/\r\n?/g, '\n')
      .split('\n').map(function(line) { return line.replace(/\s+$/, ''); }).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length > best.length) best = text;
  });
  return best;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  var l = (max + min) / 2;
  var d = max - min;
  if (!d) return [0, 0, l];
  var s = d / (1 - Math.abs(2 * l - 1));
  var h = max === r ? ((g - b) / d) % 6 : (max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function clampNumber(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// The two strongest colours in a picture, in the same shape as
// getTrackPalette so the rest of the UI can tint from real art. Pixels are
// weighted by how vivid they are, so a red title on a grey photo still wins
// over the grey. A near-greyscale picture gets a quiet neutral palette.
function paletteFromPixels(pixels) {
  if (!pixels || pixels.length < 4) return null;
  var BUCKETS = 24;
  var weight = new Array(BUCKETS).fill(0);
  var hueX = new Array(BUCKETS).fill(0);
  var hueY = new Array(BUCKETS).fill(0);
  var sat = new Array(BUCKETS).fill(0);
  var light = new Array(BUCKETS).fill(0);
  var counted = 0;
  var vivid = 0;
  for (var i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    counted++;
    var hsl = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    var w = hsl[1] * (1 - Math.abs(2 * hsl[2] - 1));
    if (w < 0.08) continue;
    vivid += w;
    var b = Math.floor(hsl[0] / (360 / BUCKETS)) % BUCKETS;
    var rad = hsl[0] * Math.PI / 180;
    weight[b] += w;
    hueX[b] += Math.cos(rad) * w;
    hueY[b] += Math.sin(rad) * w;
    sat[b] += hsl[1] * w;
    light[b] += hsl[2] * w;
  }
  if (!counted) return null;
  if (vivid / counted < 0.05) {
    return {
      a: 'hsl(230 10% 62%)', b: 'hsl(250 8% 46%)', c: 'hsl(240 10% 12%)',
      accent: 'hsl(230 14% 78%)', soft: 'hsla(230, 14%, 70%, .1)', deep: 'hsla(230, 12%, 30%, .2)',
      angle: 135
    };
  }
  function bucketHue(k) {
    var h = Math.atan2(hueY[k], hueX[k]) * 180 / Math.PI;
    return Math.round(h < 0 ? h + 360 : h);
  }
  var order = weight.map(function(w, k) { return k; }).sort(function(x, y) { return weight[y] - weight[x]; });
  var top = order[0];
  var h1 = bucketHue(top);
  var s1 = sat[top] / weight[top];
  var l1 = light[top] / weight[top];
  // Second colour: the strongest bucket at least 30 degrees away, if it is
  // a real presence in the picture; otherwise a neighbour of the first.
  var h2 = (h1 + 32) % 360;
  for (var j = 1; j < order.length; j++) {
    var k = order[j];
    if (weight[k] < weight[top] * 0.18) break;
    var d = Math.abs(bucketHue(k) - h1) % 360;
    if ((d > 180 ? 360 - d : d) >= 30) { h2 = bucketHue(k); break; }
  }
  var sPct = Math.round(clampNumber(s1 * 100, 45, 85));
  return {
    a: 'hsl(' + h1 + ' ' + sPct + '% ' + Math.round(clampNumber(l1 * 100, 48, 64)) + '%)',
    b: 'hsl(' + h2 + ' ' + Math.round(clampNumber(sPct - 6, 40, 80)) + '% 52%)',
    c: 'hsl(' + h1 + ' 40% 13%)',
    accent: 'hsl(' + h1 + ' ' + Math.round(clampNumber(sPct, 55, 80)) + '% 70%)',
    soft: 'hsla(' + h1 + ', ' + sPct + '%, 58%, .12)',
    deep: 'hsla(' + h1 + ', 60%, 34%, .22)',
    angle: 135
  };
}
