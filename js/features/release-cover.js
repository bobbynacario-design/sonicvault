// Release covers, from the Ready for Spotify card (js/data/release-cover.js):
// a 3000 x 3000 JPEG, the size distributors ask for. The AI worker's
// /release-cover paints the picture (FLUX.2 [klein] 9B, 1536 x 1536); this
// scales it up and sets the title and artist on it, so they are spelt
// exactly as the release. Before there is a picture, the song's own colours
// stand in, so the words can be laid out first.
//
// The last picture of each song is kept on this device (Cache Storage
// sv-covers-v1, which sw.js keeps) with what made it (localStorage
// sv_release_covers), so reopening shows it again without paying twice.

var RELEASE_COVER_PX = 3000;
var RELEASE_COVER_CACHE = 'sv-covers-v1';
var RELEASE_COVER_META_KEY = 'sv_release_covers';
var _releaseCover = { id:'', image:null, busy:false, note:'', error:false };
var _releaseCoverDrawTimer = null;

function readReleaseCoverMeta() {
  try {
    var map = JSON.parse(localStorage.getItem(RELEASE_COVER_META_KEY) || '{}');
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch (e) {
    return {};
  }
}

function saveReleaseCoverMeta(id, fields) {
  var map = readReleaseCoverMeta();
  map[id] = Object.assign({}, map[id], fields);
  try { localStorage.setItem(RELEASE_COVER_META_KEY, JSON.stringify(map)); } catch (e) {}
}

function releaseCoverKey(id) {
  return './__covers/' + encodeURIComponent(id);
}

function releaseArtistName() {
  return String(appSettings && appSettings.release && appSettings.release.artistName || '');
}

// Synced with the settings, like the plan date: it's the same on every
// release.
function setReleaseArtistName(value) {
  appSettings = window.appSettings || appSettings || {};
  appSettings.release = Object.assign({}, appSettings.release, { artistName:String(value || '').trim().slice(0, 120) });
  window.appSettings = appSettings;
  save('settings', appSettings);
}

function releaseCoverField(name) {
  return document.getElementById('rc-' + name);
}

function releaseCoverValue(name) {
  var field = releaseCoverField(name);
  return field ? String(field.value || '').trim() : '';
}

function blobToImage(blob) {
  return new Promise(function(resolve, reject) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { URL.revokeObjectURL(url); reject(new Error('The picture couldn’t be read.')); };
    img.src = url;
  });
}

async function openReleaseCover(id) {
  var track = getVaultTrack(id);
  if (!track) return;
  var meta = readReleaseCoverMeta()[id] || {};
  _releaseCover = { id:id, image:null, busy:false, note:'', error:false };
  var title = meta.title || releaseCheck(track, {}).title || track.title || '';
  var artist = releaseArtistName();
  var summary = getTrackSummary(track);
  document.getElementById('release-cover-song').textContent = track.title || 'Untitled';
  document.getElementById('release-cover-side').innerHTML = ''
    + '<div class="form-group"><label class="form-label" for="rc-scene">What the picture shows</label>'
    + '<textarea class="form-input" id="rc-scene" rows="3" maxlength="600">' + esc(meta.scene || releaseCoverScene(track)) + '</textarea>'
    + (summary ? '<p class="week-note">What the song is about, by Claude: ' + esc(summary) + '</p>' : '') + '</div>'
    + '<div class="form-group"><label class="form-label" for="rc-look">Look</label>'
    + '<select class="form-input" id="rc-look">' + COVER_LOOKS.map(function(look) {
      return '<option value="' + attr(look.id) + '"' + (look.id === (meta.look || 'painting') ? ' selected' : '') + '>' + esc(look.label) + '</option>';
    }).join('') + '</select></div>'
    + '<div class="release-cover-actions"><button type="button" class="sec-action primary" id="rc-make" onclick="makeReleaseCoverPicture()">Make the picture</button></div>'
    + '<div class="form-group"><label class="form-label" for="rc-text">Words on the cover</label>'
    + '<select class="form-input" id="rc-text" onchange="scheduleReleaseCoverDraw()">' + COVER_TEXT_MODES.map(function(mode) {
      return '<option value="' + attr(mode.id) + '"' + (mode.id === (meta.text || (artist ? 'both' : 'title')) ? ' selected' : '') + '>' + esc(mode.label) + '</option>';
    }).join('') + '</select>'
    + '<p class="week-note">Distributors allow only the release’s title and artist name on a cover: no handles, links or logos.</p></div>'
    + '<div class="form-group"><label class="form-label" for="rc-title">Title</label>'
    + '<input class="form-input" id="rc-title" maxlength="120" value="' + attr(title) + '" oninput="scheduleReleaseCoverDraw()"></div>'
    + '<div class="form-group"><label class="form-label" for="rc-artist">Artist name, as on Spotify</label>'
    + '<input class="form-input" id="rc-artist" maxlength="120" value="' + attr(artist) + '" oninput="scheduleReleaseCoverDraw()" onchange="setReleaseArtistName(this.value)"></div>'
    + '<div class="release-cover-actions"><button type="button" class="sec-action" id="rc-download" onclick="downloadReleaseCover()">Download 3000 × 3000 JPEG</button></div>'
    + '<p class="week-note" id="rc-note" aria-live="polite"></p>';
  openModal('modal-release-cover');
  renderReleaseCoverNote();
  drawReleaseCover();
  if (!('caches' in window)) return;
  try {
    var cache = await caches.open(RELEASE_COVER_CACHE);
    var saved = await cache.match(releaseCoverKey(id));
    if (!saved || _releaseCover.id !== id) return;
    var image = await blobToImage(await saved.blob());
    if (_releaseCover.id !== id || _releaseCover.image) return;
    _releaseCover.image = image;
    renderReleaseCoverNote();
    drawReleaseCover();
  } catch (e) {
    console.warn('Saved cover picture not restored:', e);
  }
}

function renderReleaseCoverNote() {
  var note = releaseCoverField('note');
  var make = releaseCoverField('make');
  if (make) {
    make.disabled = _releaseCover.busy;
    make.textContent = _releaseCover.busy ? 'Painting…' : (_releaseCover.image ? 'Try another picture' : 'Make the picture');
  }
  if (!note) return;
  note.classList.toggle('tidy-error', !!_releaseCover.error);
  note.textContent = _releaseCover.note || (_aiConfig && _aiConfig.endpoint
    ? 'Each picture uses about 1,600 of the 10,000 AI units Cloudflare gives free each day (shared with lyric timing and search), so about five a day on the free plan.'
    : 'Connect the AI worker under Import to paint a picture. The words can be laid out now.');
}

async function makeReleaseCoverPicture() {
  var id = _releaseCover.id;
  var track = getVaultTrack(id);
  if (!track || _releaseCover.busy) return;
  if (!_aiConfig || !_aiConfig.endpoint) { renderReleaseCoverNote(); return; }
  var scene = releaseCoverValue('scene');
  var look = releaseCoverValue('look') || 'painting';
  var seed = Math.floor(Math.random() * 2147483647);
  _releaseCover.busy = true;
  _releaseCover.error = false;
  _releaseCover.note = 'Painting the picture. It takes about 15 seconds.';
  renderReleaseCoverNote();
  try {
    var response = await workerRequest('/release-cover', {
      title:releaseCoverValue('title') || track.title || '',
      scene:scene,
      style:releaseCoverStyle(track),
      look:look,
      seed:seed
    });
    if (!response.ok) throw new Error(await workerError(response));
    var data = await response.json();
    if (!data || !data.image) throw new Error('The picture came back empty.');
    var bytes = base64ToBytes(data.image);
    var blob = new Blob([bytes], { type:sniffImageMime(bytes) || data.mime || 'image/jpeg' });
    if ('caches' in window) {
      var cache = await caches.open(RELEASE_COVER_CACHE);
      await cache.put(releaseCoverKey(id), new Response(blob, { headers:{ 'Content-Type':blob.type } }));
    }
    saveReleaseCoverMeta(id, { scene:scene, look:look, seed:data.seed, at:new Date().toISOString() });
    var image = await blobToImage(blob);
    if (_releaseCover.id !== id) return;
    _releaseCover.image = image;
    _releaseCover.note = 'Not quite it? Change what it shows or the look, and try another.';
  } catch (e) {
    if (_releaseCover.id !== id) return;
    _releaseCover.error = true;
    _releaseCover.note = (e && e.message) || 'The picture couldn’t be made.';
  } finally {
    if (_releaseCover.id === id) {
      _releaseCover.busy = false;
      renderReleaseCoverNote();
      drawReleaseCover();
    }
  }
}

// Redraw a moment after typing stops, and remember the words for next time.
function scheduleReleaseCoverDraw() {
  clearTimeout(_releaseCoverDrawTimer);
  _releaseCoverDrawTimer = setTimeout(function() {
    if (_releaseCover.id) saveReleaseCoverMeta(_releaseCover.id, { title:releaseCoverValue('title'), text:releaseCoverValue('text') });
    drawReleaseCover();
  }, 120);
}

// The picture filling the square -- or the song's colours until there is
// one -- and the words over a shade at the foot, set in the app's own
// display face.
async function drawReleaseCover() {
  var canvas = document.getElementById('release-cover-canvas');
  var track = getVaultTrack(_releaseCover.id);
  if (!canvas || !track) return;
  var mode = releaseCoverValue('text') || 'title';
  var title = releaseCoverValue('title');
  var artist = releaseCoverValue('artist');
  try {
    await Promise.all([document.fonts.load('700 200px Syne'), document.fonts.load('500 100px "Space Grotesk"')]);
  } catch (e) {}
  var size = RELEASE_COVER_PX;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  if (_releaseCover.image) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(_releaseCover.image, 0, 0, size, size);
  } else {
    var palette = getCoverPalette(track);
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, size, size);
    [[0.3, 0.28, palette.a], [0.75, 0.7, palette.b]].forEach(function(bloom) {
      var glow = ctx.createRadialGradient(size * bloom[0], size * bloom[1], 0, size * bloom[0], size * bloom[1], size * 0.7);
      glow.addColorStop(0, bloom[2]);
      glow.addColorStop(1, 'rgba(11,15,26,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
    });
  }
  var showTitle = mode !== 'none' && !!title;
  var showArtist = mode === 'both' && !!artist;
  if (!showTitle && !showArtist) return;
  var margin = 210;
  var shade = ctx.createLinearGradient(0, size * 0.52, 0, size);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, size * 0.52, size, size * 0.48);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24;
  var bottom = size - margin;
  if (showArtist) {
    var artistSize = 104;
    ctx.font = '500 ' + artistSize + 'px "Space Grotesk", sans-serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = Math.round(artistSize * 0.14) + 'px';
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.fillText(artist.toUpperCase(), margin, bottom);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    bottom -= artistSize * 1.55;
  }
  if (showTitle) {
    var fit = fitCoverTitle(title, function(text, px) {
      ctx.font = '700 ' + px + 'px Syne, sans-serif';
      return ctx.measureText(text).width;
    }, { maxWidth:size - margin * 2, maxSize:330, minSize:150, maxLines:2 });
    ctx.font = '700 ' + fit.size + 'px Syne, sans-serif';
    ctx.fillStyle = '#ffffff';
    fit.lines.slice().reverse().forEach(function(line, i) {
      ctx.fillText(line, margin, bottom - i * fit.size * 1.04);
    });
  }
  ctx.shadowBlur = 0;
}

function downloadReleaseCover() {
  var canvas = document.getElementById('release-cover-canvas');
  if (!canvas) return;
  if (!_releaseCover.image && !confirm('There’s no picture yet, only the song’s colours. Download it like this?')) return;
  canvas.toBlob(function(blob) {
    if (!blob) { showToast('The cover couldn’t be saved.'); return; }
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = coverFileName(releaseCoverValue('title'));
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 4000);
  }, 'image/jpeg', 0.92);
}
