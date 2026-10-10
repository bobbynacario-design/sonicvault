// Tidy up, on Insights (js/data/tidy.js): what in the vault needs fixing,
// each with its fix a tap away -- songs missing lyrics (Whisper writes down
// what is sung, for you to look over before it is kept) or a description
// (Claude, as on the AI worker card), the same file imported twice (merged
// into one), a song whose other take is clearly better than the one
// standing for it, and titles still carrying their file name. The safe
// fixes -- titles and main takes -- also go all at once.

var TIDY_SHOWN = 6;
var _tidy = { open:{}, transcripts:{} };   // transcripts: id -> { status, sheet, error }

function tidyTitleFixes() {
  return tracks.map(function(track) {
    var title = tidyTitle(track.title, getTrackLyrics(track), track.prompt);
    return title ? { track:track, title:title } : null;
  }).filter(Boolean);
}

// Takes of songs that duplicates are not: a duplicate shares its twin's
// lyrics, so it would look like a second take.
function tidyTakeFixes(duplicateIds) {
  var now = new Date();
  var groups = getVersionGroups();
  return Object.keys(groups).map(function(key) {
    var group = groups[key].filter(function(take) { return !duplicateIds[take.id]; });
    var suggestion = suggestMainTake(group, now, getSungCheck);
    return suggestion ? { group:group, take:suggestion.take, reason:suggestion.reason } : null;
  }).filter(Boolean);
}

function tidyState() {
  var duplicates = findDuplicates(tracks);
  var dropping = {};
  duplicates.forEach(function(pair) { dropping[pair.drop.id] = true; });
  return {
    duplicates:duplicates,
    lyrics:tracks.filter(needsLyrics),
    undescribed:tracks.filter(needsDescription),
    takes:tidyTakeFixes(dropping),
    titles:tidyTitleFixes()
  };
}

// ─── Fixes ───────────────────────────────────────────────────────────────────

function renameTidyTrack(id, title) {
  var track = getVaultTrack(id);
  if (!track || !title) return false;
  track.title = title;
  return true;
}

function applyTidyTitle(id) {
  var track = getVaultTrack(id);
  var title = track && tidyTitle(track.title, getTrackLyrics(track), track.prompt);
  if (!renameTidyTrack(id, title)) return;
  persistTracks();
  window.refreshAll();
  showToast('Renamed to “' + title + '”');
}

function applyAllTidyTitles() {
  var fixes = tidyTitleFixes();
  if (!fixes.length || !confirm('Rename ' + fixes.length + (fixes.length === 1 ? ' song' : ' songs') + ' to the tidied titles shown?')) return;
  fixes.forEach(function(fix) { renameTidyTrack(fix.track.id, fix.title); });
  persistTracks();
  window.refreshAll();
  showToast('Renamed ' + fixes.length + (fixes.length === 1 ? ' song' : ' songs'));
}

function applyAllTidyTakes() {
  var fixes = tidyTakeFixes({});
  if (!fixes.length) return;
  fixes.forEach(function(fix) {
    fix.group.forEach(function(take) {
      if (take.id === fix.take.id) take.versionPick = true;
      else delete take.versionPick;
    });
  });
  persistTracks();
  window.refreshAll();
  showToast('Picked the main take of ' + fixes.length + (fixes.length === 1 ? ' song' : ' songs'));
}

// One copy kept: the other's plays, days, karaoke takes and playlist places
// move onto it (mergedTrackFields), and the other goes, its share link
// with it. The file stays on Cloudinary, like any deleted song's.
function mergeTidyDuplicate(keepId, dropId) {
  var keep = getVaultTrack(keepId);
  var drop = getVaultTrack(dropId);
  if (!keep || !drop) return;
  if (!confirm('Keep “' + (keep.title || 'Untitled') + '” and remove its duplicate “' + (drop.title || 'Untitled') + '”? Plays, karaoke takes and playlist places move to the one kept.'
      + (drop.shared ? ' The duplicate’s public link stops working.' : ''))) return;
  var merged = mergedTrackFields(keep, drop);
  Object.keys(merged).forEach(function(key) {
    if (merged[key] === null) delete keep[key];
    else keep[key] = merged[key];
  });
  playlists.forEach(function(pl) {
    var ids = (pl.trackIds || []).map(function(id) { return id === dropId ? keepId : id; });
    pl.trackIds = ids.filter(function(id, i) { return ids.indexOf(id) === i; });
  });
  removeTrackFromVault(dropId);
  window.refreshAll();
  showToast('Merged into “' + (keep.title || 'Untitled') + '”');
}

function markTidyInstrumental(id) {
  var track = getVaultTrack(id);
  if (!track) return;
  track.aiVocalStyle = 'Instrumental';
  persistTracks();
  window.refreshAll();
  showToast('“' + (track.title || 'Untitled') + '” is marked as an instrumental');
}

// What Whisper hears, as a sheet to look over before it is kept.
async function transcribeTidyLyrics(id) {
  var track = getVaultTrack(id);
  if (!track || !lyricSyncEndpoint() || (_tidy.transcripts[id] && _tidy.transcripts[id].status === 'busy')) return;
  _tidy.transcripts[id] = { status:'busy', sheet:'', error:'' };
  renderTidy();
  try {
    var sheet = sheetFromWords(await transcribeTrack(track));
    _tidy.transcripts[id] = sheet
      ? { status:'done', sheet:sheet, error:'' }
      : { status:'error', sheet:'', error:'Whisper heard no words. It may be an instrumental.' };
  } catch (e) {
    _tidy.transcripts[id] = { status:'error', sheet:'', error:(e && e.name === 'AbortError') ? 'Whisper took too long. Try again.' : ((e && e.message) || 'Couldn’t transcribe it.') };
  }
  renderTidy();
}

function keepTidyLyrics(id) {
  var track = getVaultTrack(id);
  var transcript = _tidy.transcripts[id];
  var field = document.getElementById('tidy-sheet-' + id);
  var sheet = String(field ? field.value : (transcript && transcript.sheet) || '').trim();
  if (!track || !sheet) return;
  track.lyrics = sheet;
  delete _tidy.transcripts[id];
  persistTracks();
  window.refreshAll();
  showToast('Lyrics kept for “' + (track.title || 'Untitled') + '”');
}

function dropTidyLyrics(id) {
  delete _tidy.transcripts[id];
  renderTidy();
}

function toggleTidySection(name) {
  _tidy.open[name] = !_tidy.open[name];
  renderTidy();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function tidyRow(track, facts, actions, extra) {
  return '<div class="tidy-row">'
    + '<div class="rank-row is-gem" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track')) + '" onclick="playTrack(' + jsq(track.id) + ')">'
    +   buildCoverArt(track, 'xs', false)
    +   '<div class="rank-copy"><div class="rank-title">' + esc(track.title || 'Untitled') + '</div><div class="rank-sub">' + facts + '</div></div>'
    +   '<div class="tidy-actions">' + actions + '</div>'
    + '</div>'
    + (extra || '')
    + '</div>';
}

function tidyButton(label, call, primary) {
  return '<button type="button" class="sec-action' + (primary ? ' primary' : '') + '" onclick="event.stopPropagation();' + call + '">' + esc(label) + '</button>';
}

function tidySection(name, title, lead, items, allButton) {
  if (!items.length) return '';
  var open = !!_tidy.open[name];
  var shown = open ? items : items.slice(0, TIDY_SHOWN);
  return '<div class="week-block tidy-block">'
    + '<div class="tidy-head"><div class="week-label">' + esc(title) + ' <span class="tidy-count">' + items.length + '</span></div>' + (allButton || '') + '</div>'
    + '<p class="week-lead">' + lead + '</p>'
    + '<div class="rank-list">' + shown.join('') + '</div>'
    + (items.length > TIDY_SHOWN ? '<button type="button" class="create-setup-link tidy-more" onclick="toggleTidySection(' + jsq(name) + ')">' + (open ? 'Show fewer' : 'Show all ' + items.length) + '</button>' : '')
    + '</div>';
}

function tidyLyricsRow(track) {
  var transcript = _tidy.transcripts[track.id];
  var canTranscribe = !!lyricSyncEndpoint() && /^https:\/\/res\.cloudinary\.com\//.test(track.audioURL || '') && Number(track.duration || 0) <= 900;
  var actions = (canTranscribe && !(transcript && transcript.status === 'done')
      ? tidyButton(transcript && transcript.status === 'busy' ? 'Listening…' : 'Transcribe', 'transcribeTidyLyrics(' + jsq(track.id) + ')', false) : '')
    + tidyButton('Instrumental', 'markTidyInstrumental(' + jsq(track.id) + ')', false)
    + tidyButton('Type them', 'openEditTrack(' + jsq(track.id) + ')', false);
  var extra = '';
  if (transcript && transcript.status === 'done') {
    extra = '<div class="tidy-sheet">'
      + '<label class="form-label" for="tidy-sheet-' + attr(track.id) + '">What Whisper heard: fix it, then keep it</label>'
      + '<textarea class="form-input create-lyrics" id="tidy-sheet-' + attr(track.id) + '" rows="8" oninput="_tidy.transcripts[' + jsq(track.id) + '].sheet = this.value">' + esc(transcript.sheet) + '</textarea>'
      + '<div class="tidy-actions">' + tidyButton('Keep these lyrics', 'keepTidyLyrics(' + jsq(track.id) + ')', true) + tidyButton('Discard', 'dropTidyLyrics(' + jsq(track.id) + ')', false) + '</div>'
      + '</div>';
  } else if (transcript && transcript.status === 'error') {
    extra = '<p class="tidy-error" role="alert">' + esc(transcript.error) + '</p>';
  }
  return tidyRow(track, esc([track.genre, track.mood].filter(Boolean).join(' / ') || 'No lyrics'), actions, extra);
}

function renderTidy() {
  var el = document.getElementById('tidy-card');
  if (!el) return;
  if (!tracks.length || _coverDemoActive) { el.innerHTML = ''; return; }
  var state = tidyState();
  var sections = [];

  sections.push(tidySection('duplicates', 'The same file twice',
    'Each of these is a second copy of a song already in the vault. Merging removes the copy and moves its plays, karaoke takes and playlist places onto the song it duplicates.',
    state.duplicates.map(function(pair) {
      return tidyRow(pair.drop,
        'Same file as “' + esc(pair.keep.title || 'Untitled') + '” · ' + fmtTime(pair.drop.duration || 0) + ' · ' + fmtCompactNumber(pair.drop.plays || 0) + (Number(pair.drop.plays) === 1 ? ' play' : ' plays'),
        tidyButton('Merge into “' + trimText(pair.keep.title || 'Untitled', 24) + '”', 'mergeTidyDuplicate(' + jsq(pair.keep.id) + ', ' + jsq(pair.drop.id) + ')', false));
    })));

  sections.push(tidySection('lyrics', 'No lyrics',
    'These have singing, as far as the vault knows, but no lyric sheet, and their files carry none. Whisper can write down what is sung for you to fix and keep.',
    state.lyrics.map(tidyLyricsRow)));

  if (state.undescribed.length) {
    var describing = typeof _describeRun !== 'undefined' && _describeRun;
    sections.push('<div class="week-block tidy-block"><div class="tidy-head"><div class="week-label">No description <span class="tidy-count">' + state.undescribed.length + '</span></div>'
      + (describeWorkerReady() ? tidyButton(describing ? 'Describing…' : 'Describe ' + (state.undescribed.length === 1 ? 'it' : 'them'), 'describeAllSongs()', false) : '') + '</div>'
      + '<p class="week-lead">Claude hasn’t described ' + (state.undescribed.length === 1 ? 'this song' : 'these ' + state.undescribed.length + ' songs') + ' yet: genre, mood, tags and a summary, which search by meaning, smart mixes and Ask your vault all use. Less than a cent each.'
      + (describeWorkerReady() ? '' : ' Connect the AI worker to describe them.') + '</p></div>');
  }

  sections.push(tidySection('takes', 'A better take',
    'Another take of these songs is clearly the better one, by what you play or by how much of the sheet it sang as written. Making it main puts it in the song’s place on the shelf and in mixes.',
    state.takes.map(function(fix) {
      return tidyRow(fix.take, esc(versionLabel(fix.take, fix.group) + ': ' + fix.reason),
        tidyButton('Make it main', 'setMainVersion(' + jsq(fix.take.id) + ');renderInsights()', false));
    }),
    state.takes.length > 1 ? tidyButton('Pick them all', 'applyAllTidyTakes()', false) : ''));

  sections.push(tidySection('titles', 'Messy titles',
    'These still carry their file name, are all capitals, or have no title at all.',
    state.titles.map(function(fix) {
      return tidyRow(fix.track, 'Tidied: <strong>' + esc(fix.title) + '</strong>',
        tidyButton('Rename', 'applyTidyTitle(' + jsq(fix.track.id) + ')', false));
    }),
    state.titles.length > 1 ? tidyButton('Rename them all', 'applyAllTidyTitles()', false) : ''));

  var body = sections.filter(Boolean).join('');
  el.innerHTML = '<div class="section-card tidy-card"><div class="section-inner">'
    + '<div class="section-head"><div><div class="section-title">Tidy up</div>'
    + '<div class="section-sub">' + (body ? 'What in the vault could use a hand, each with its fix.' : 'Nothing to tidy: every song has its lyrics, description, main take and a clean title.') + '</div></div></div>'
    + body
    + '</div></div>';
}
