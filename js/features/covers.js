// Cover art markup built from js/data/covers.js, and the memory-only cover
// demo that previews every style on an empty vault.

var _coverDemoActive = false;

function buildCoverStyleOptions(current) {
  return COVER_STYLES.map(function(style) {
    return '<option value="' + attr(style.id) + '"' + (style.id === current ? ' selected' : '') + '>' + esc(style.name) + '</option>';
  }).join('');
}

function buildCoverStylePicker(item, onSelectCall) {
  var current = getCoverStyle(item);
  return '<div class="cover-style-picker">' + COVER_STYLES.map(function(style) {
    var preview = Object.assign({}, item || {}, { coverStyle: style.id });
    return ''
      + '<button type="button" class="cover-style-option' + (style.id === current ? ' active' : '') + '" onclick="' + onSelectCall + '(' + jsq(style.id) + ')">'
      +   buildCoverArt(preview, 'xs', false)
      +   '<span class="cover-style-label">' + esc(style.name) + '</span>'
      + '</button>';
  }).join('') + '</div>';
}

function makeCoverDemoTracks() {
  var demos = [
    { title:'Neon Highway', genre:'Synthwave', mood:'Energetic', coverStyle:'prism', prompt:'neon synthwave night drive, chrome skyline, bright arps', aiTheme:'Night-drive escape', aiEnergy:'High', aiTags:['Neon','Night drive','Chrome'] },
    { title:'Cassette Porchlight', genre:'Country', mood:'Warm', coverStyle:'tape', prompt:'warm country acoustic, family porch, home-recording feel', aiTheme:'Family devotion', aiEnergy:'Medium', aiTags:['Home','Porchlight','Acoustic'] },
    { title:'Blue Room Static', genre:'Lo-fi', mood:'Chill', coverStyle:'tape', prompt:'lo-fi dusty cassette beat, soft keys, late-night room tone', aiTheme:'Bedroom haze', aiEnergy:'Low', aiTags:['Lo-fi','Cassette','Late night'] },
    { title:'Glass Cathedral', genre:'Ambient', mood:'Dreamy', coverStyle:'scope', prompt:'cinematic ambient pads, ocean light, wide horizon', aiTheme:'Coastal reset', aiEnergy:'Low', aiTags:['Ocean','Cinematic','Wide'] },
    { title:'Velvet Revolver Heart', genre:'R&B', mood:'Melancholic', coverStyle:'vinyl', prompt:'vintage soul and R&B, analog warmth, heartbreak vocal', aiTheme:'Heartbreak fallout', aiEnergy:'Medium', aiTags:['Vintage','Soul','Heartbreak'] },
    { title:'Afterparty Voltage', genre:'Electronic', mood:'Intense', coverStyle:'pulse', prompt:'club drop, 808 kick, strobe lights, high-energy dance track', aiTheme:'Club voltage', aiEnergy:'High', aiTags:['Club','808','Strobe'] },
    { title:'Blackout Hymn', genre:'Rock', mood:'Dark', coverStyle:'mono', prompt:'dark minimal rock, noir shadows, haunted vocal', aiTheme:'Noir devotion', aiEnergy:'Medium', aiTags:['Noir','Shadow','Minimal'] },
    { title:'Radio Sunburst', genre:'Pop', mood:'Uplifting', coverStyle:'poster', prompt:'bold radio pop anthem, big hook, sunrise chorus', aiTheme:'Morning lift', aiEnergy:'High', aiTags:['Pop','Hook','Sunrise'] }
  ];
  return demos.map(function(item, index) {
    return Object.assign({
      id:'demo-cover-' + index,
      source:'Suno',
      lyrics:'[Verse]\nThis is a local SonicVault cover demo.\n[Chorus]\nNo audio is saved, no vault data is changed.',
      audioURL:'',
      duration:180 + (index * 9),
      created:new Date().toISOString().split('T')[0],
      plays:index,
      shared:false,
      fileName:'cover-demo-' + (index + 1) + '.mp3',
      fileSize:0,
      aiSummary:'A temporary local demo track for previewing SonicVault cover styles. It is memory-only and will disappear on reload.',
      aiVocalStyle:'Preview lead',
      aiEra:'Demo',
      aiInstruments:['Synth'],
      aiExplicit:false,
      aiSource:'local',
      aiMetadataVersion:AI_METADATA_VERSION,
      aiGeneratedAt:new Date().toISOString()
    }, item);
  });
}

function startCoverDemo() {
  _coverDemoActive = true;
  _currentTrack = null;
  _isPlaying = false;
  tracks = makeCoverDemoTracks();
  playlists = [];
  window.tracks = tracks;
  window.playlists = playlists;
  invalidateFilterCache();
  clearFilters();
  renderTracks();
  renderPlaylists();
  updateNowPlaying();
  renderRouteAwareView(true);
  showToast('Loaded local cover demo. Nothing will be saved.');
}

function exitCoverDemo() {
  _coverDemoActive = false;
  tracks = load('tracks', []);
  playlists = load('playlists', []);
  window.tracks = tracks;
  window.playlists = playlists;
  invalidateFilterCache();
  window.refreshAll();
  showToast('Cover demo cleared');
}

function buildCoverArt(track, size, includeWords) {
  if (!track) track = { title:'SonicVault', genre:'Other', mood:'Dreamy', source:'Vault' };
  var palette = getTrackPalette(track);
  var style = getCoverStyle(track);
  var tags = getTrackTags(track);
  var top = track.source || 'Vault';
  var bottom = tags[0] || track.mood || track.genre || 'Curated';
  var sizeClass = size || 'md';
  var words = includeWords === false ? '' : '<div class="cover-mark">' + esc(getTrackMonogram(track.title)) + '</div>';
  return ''
    + '<div class="cover-art cover-' + esc(sizeClass) + ' cover-style-' + esc(style) + '" style="--cover-a:' + palette.a + ';--cover-b:' + palette.b + ';--cover-c:' + palette.c + ';--cover-angle:' + palette.angle + 'deg">'
    +   '<div class="cover-grid"></div>'
    +   '<div class="cover-wave"></div>'
    +   '<div class="cover-ring"></div>'
    +   '<div class="cover-grain"></div>'
    +   '<div class="cover-topline"><span>' + esc(top) + '</span><span>' + esc(track.genre || 'Other') + '</span></div>'
    +   words
    +   '<div class="cover-bottomline"><span>' + esc(track.mood || 'Mood') + '</span><span>' + esc(String(bottom).slice(0, 10).toUpperCase()) + '</span></div>'
    + '</div>';
}

function buildPlaylistCover(pl, size) {
  var items = getPlaylistTracks(pl).slice(0, 4);
  if (!items.length) {
    return '<div class="cover-collage">' + buildCoverArt({ title:pl && pl.name || 'Playlist', genre:'Other', mood:'Dreamy', source:'Mix' }, size || 'sm', true) + buildCoverArt({ title:'Private', genre:'Ambient', mood:'Warm', source:'Vault' }, size || 'sm', true) + buildCoverArt({ title:'Curated', genre:'Synthwave', mood:'Dreamy', source:'Vault' }, size || 'sm', true) + buildCoverArt({ title:'Room', genre:'Lo-fi', mood:'Chill', source:'Vault' }, size || 'sm', true) + '</div>';
  }
  while (items.length < 4) items.push(items[items.length - 1]);
  return '<div class="cover-collage">' + items.slice(0, 4).map(function(track) {
    return buildCoverArt(track, size || 'sm', false);
  }).join('') + '</div>';
}
