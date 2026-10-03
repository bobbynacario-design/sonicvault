// The Insights page: totals, distributions, and library health, all derived
// from the tracks already in the vault.

// Sorted horizontal bar rows for a {label: count} map. onclickFn(key) returns
// an inline handler string (jump to the filtered library), or null for static.
function buildDistributionBars(counts, colorFn, total, onclickFn) {
  var keys = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; });
  if (!keys.length) return '<div class="insight-empty-row">No data yet.</div>';
  var max = counts[keys[0]] || 1;
  return keys.map(function(key) {
    var n = counts[key];
    var pct = Math.round((n / total) * 100);
    var w = Math.max(4, Math.round((n / max) * 100));
    var color = colorFn ? colorFn(key) : 'var(--accent-dynamic)';
    var click = onclickFn ? ' onclick="' + onclickFn(key) + '" style="cursor:pointer"' : '';
    return '<div class="dist-row"' + click + '>'
      + '<div class="dist-label"><span class="dist-dot" style="background:' + color + '"></span>' + esc(key) + '</div>'
      + '<div class="dist-track"><div class="dist-fill" style="width:' + w + '%;background:' + color + '"></div></div>'
      + '<div class="dist-val">' + n + ' / ' + pct + '%</div>'
      + '</div>';
  }).join('');
}

function renderInsights() {
  var el = document.getElementById('insights-view');
  if (!el) return;
  if (!tracks.length) {
    el.innerHTML = '<div class="section-card"><div class="section-inner"><div class="empty-state"><strong>No insights yet.</strong>Import a few tracks and start listening — SonicVault will chart your genres, moods, most-played records, and library health here.<div class="modal-actions" style="justify-content:center;margin-top:1rem"><button class="sec-action primary" onclick="switchView(\'upload\')">Import first track</button></div></div></div></div>';
    return;
  }

  var totalPlays = tracks.reduce(function(s, t) { return s + Number(t.plays || 0); }, 0);
  var catalogSecs = tracks.reduce(function(s, t) { return s + Number(t.duration || 0); }, 0);
  var listenSecs = tracks.reduce(function(s, t) { return s + (Number(t.plays || 0) * Number(t.duration || 0)); }, 0);
  var avgPlays = tracks.length ? (totalPlays / tracks.length) : 0;

  var genres = {}, moods = {}, sources = {};
  var withLyrics = 0, withAI = 0, watcherCount = 0;
  tracks.forEach(function(t) {
    genres[t.genre || 'Other'] = (genres[t.genre || 'Other'] || 0) + 1;
    moods[t.mood || 'Other'] = (moods[t.mood || 'Other'] || 0) + 1;
    sources[t.source || 'Other'] = (sources[t.source || 'Other'] || 0) + 1;
    if (hasLyrics(t)) withLyrics++;
    if (getTrackSummary(t) || (t.aiTags && t.aiTags.length)) withAI++;
    if (t.autoImported) watcherCount++;
  });
  var lyricPct = Math.round((withLyrics / tracks.length) * 100);
  var aiPct = Math.round((withAI / tracks.length) * 100);

  var statTiles = [
    { label: 'Tracks in vault', value: fmtCompactNumber(tracks.length) },
    { label: 'Total plays', value: fmtCompactNumber(totalPlays) },
    { label: 'Est. listening time', value: fmtLongDuration(listenSecs) },
    { label: 'Avg plays / track', value: String(Math.round(avgPlays * 10) / 10) }
  ];
  var statsHtml = statTiles.map(function(s) {
    return '<div class="stat-tile"><div class="stat-value">' + esc(s.value) + '</div><div class="stat-label">' + esc(s.label) + '</div></div>';
  }).join('');

  var mostPlayed = getMostPlayedTracks(6).filter(function(t) { return Number(t.plays || 0) > 0; });
  var maxPlay = mostPlayed.length ? Number(mostPlayed[0].plays || 0) : 1;
  var mostHtml = mostPlayed.length ? mostPlayed.map(function(t, i) {
    var w = Math.max(4, Math.round((Number(t.plays || 0) / maxPlay) * 100));
    return '<div class="rank-row" role="button" tabindex="0" aria-label="' + attr('Play ' + (t.title || 'track') + ', ' + (t.plays || 0) + ' plays, rank ' + (i + 1)) + '" onclick="playTrack(' + jsq(t.id) + ')"><div class="rank-num" aria-hidden="true">' + (i + 1) + '</div>' + buildCoverArt(t, 'xs', false) + '<div class="rank-copy"><div class="rank-title">' + esc(t.title) + '</div><div class="rank-bar"><div class="rank-fill" style="width:' + w + '%;background:' + getGenreColor(t.genre || 'Other') + '"></div></div></div><div class="rank-val">' + fmtCompactNumber(t.plays || 0) + '</div></div>';
  }).join('') : '<div class="insight-empty-row">No plays logged yet — start listening to build this rail.</div>';

  var gems = getLeastPlayedTracks(6);
  var gemsHtml = gems.map(function(t) {
    var plays = Number(t.plays || 0);
    var playsLabel = fmtCompactNumber(plays) + (plays === 1 ? ' play' : ' plays');
    return '<div class="rank-row is-gem" role="button" tabindex="0" aria-label="' + attr('Play ' + (t.title || 'track') + ', ' + playsLabel) + '" onclick="playTrack(' + jsq(t.id) + ')">' + buildCoverArt(t, 'xs', false) + '<div class="rank-copy"><div class="rank-title">' + esc(t.title) + '</div><div class="rank-sub">' + esc(t.genre || 'Other') + ' / ' + esc(t.mood || 'Mood') + '</div></div><div class="rank-val">' + playsLabel + '</div></div>';
  }).join('');

  el.innerHTML = ''
    + '<div class="section-card"><div class="section-inner">'
    +   '<div class="section-head"><div><div class="section-title is-hero">Your private listening room, by the numbers</div><div class="section-sub">Everything here is derived from the tracks and play counts already in your vault — no external tracking.</div></div></div>'
    +   '<div class="stat-grid">' + statsHtml + '</div>'
    + '</div></div>'
    + '<div class="insight-cols">'
    +   '<div class="section-card"><div class="section-inner"><div class="section-title">Genres</div><div class="dist-list">' + buildDistributionBars(genres, getGenreColor, tracks.length, function(k) { return 'setGenreFilter(' + jsq(k) + ");switchView('library')"; }) + '</div></div></div>'
    +   '<div class="section-card"><div class="section-inner"><div class="section-title">Moods</div><div class="dist-list">' + buildDistributionBars(moods, getMoodColor, tracks.length, function(k) { return 'browseMood(' + jsq(k) + ')'; }) + '</div></div></div>'
    + '</div>'
    + '<div class="insight-cols">'
    +   '<div class="section-card"><div class="section-inner"><div class="section-title">Most played</div><div class="rank-list">' + mostHtml + '</div></div></div>'
    +   '<div class="section-card"><div class="section-inner"><div class="section-title">Hidden gems</div><div class="section-sub" style="margin-bottom:1rem">Your least-played records — the under-loved corners of the vault.</div><div class="rank-list">' + gemsHtml + '</div></div></div>'
    + '</div>'
    + '<div class="section-card"><div class="section-inner">'
    +   '<div class="section-title">Library health</div>'
    +   '<div class="health-grid">'
    +     '<div class="health-tile"><div class="health-val">' + aiPct + '%</div><div class="health-label">AI-tagged</div><div class="health-sub">' + withAI + ' of ' + tracks.length + ' have AI metadata</div></div>'
    +     '<div class="health-tile"><div class="health-val">' + lyricPct + '%</div><div class="health-label">Lyrics on file</div><div class="health-sub">' + withLyrics + ' of ' + tracks.length + ' have a lyric sheet</div></div>'
    +     '<div class="health-tile"><div class="health-val">' + fmtCompactNumber(watcherCount) + '</div><div class="health-label">Watcher imports</div><div class="health-sub">auto-imported from downloads</div></div>'
    +     '<div class="health-tile"><div class="health-val">' + fmtLongDuration(catalogSecs) + '</div><div class="health-label">Catalog runtime</div><div class="health-sub">total length of the vault</div></div>'
    +   '</div>'
    +   '<div class="dist-list" style="margin-top:1.2rem">' + buildDistributionBars(sources, function() { return 'var(--accent-dynamic)'; }, tracks.length, function(k) { return 'setSourceFilter(' + jsq(k) + ");switchView('library')"; }) + '</div>'
    + '</div></div>';
}
