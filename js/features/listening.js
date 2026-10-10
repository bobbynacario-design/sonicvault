// Listening smarts (js/data/listening.js): the "On repeat" rail on Home,
// songs that keep being skipped kept out of the smart mixes, radio and the
// mix for the time of day, a winning take marked among a song's versions
// (offered as the main take by Tidy up, js/features/tidy.js), and "Your
// week" on Insights -- the last seven days of your own listening beside what
// people did on your share links (js/features/listens.js).
// Skips are recorded by the player (skippedTrack in js/features/player.js).

// Songs the vault's own mixes may choose: all but the ones kept being skipped.
function mixableTracks(list) {
  var now = new Date();
  return (list || tracks).filter(function(track) { return !oftenSkipped(track, now); });
}

// "Keep in mixes": the song's skips are forgotten, so it is back in them.
function forgetSkips(id) {
  var track = getVaultTrack(id);
  if (!track) return;
  delete track.skipDays;
  persistTracks();
  renderInsights();
  showToast('“' + (track.title || 'Untitled') + '” is back in your mixes');
}

// The rail on Home: [] until something has been played twice this week.
function onRepeatTracks(limit) {
  if (_coverDemoActive) return [];
  return onRepeat(tracks, new Date(), limit).map(function(item) { return item.track; });
}

// The first day any play was counted by day, or '' -- plays from before the
// vault kept days (2026-10-05) are in the totals only.
function firstPlayDay() {
  var first = '';
  tracks.forEach(function(track) {
    Object.keys(track.playDays && typeof track.playDays === 'object' ? track.playDays : {}).forEach(function(day) {
      if (!first || day < first) first = day;
    });
  });
  return first;
}

// ── Your week, on Insights ───────────────────────────────────────────────

function weekRow(track, facts, actions) {
  return '<div class="rank-row is-gem" role="button" tabindex="0" aria-label="' + attr('Play ' + (track.title || 'track')) + '" onclick="playTrack(' + jsq(track.id) + ')">'
    + buildCoverArt(track, 'xs', false)
    + '<div class="rank-copy"><div class="rank-title">' + esc(track.title || 'Untitled') + '</div><div class="rank-sub">' + esc(facts) + '</div></div>'
    + (actions || '<div class="rank-val"></div>')
    + '</div>';
}

function weekTile(value, label, note) {
  return '<div class="stat-tile"><div class="stat-value">' + esc(value) + '</div><div class="stat-label">' + esc(label) + '</div>'
    + (note ? '<div class="week-note">' + esc(note) + '</div>' : '') + '</div>';
}

// What people did on your share links this week: sums, and the songs most
// played or loved. '' when nothing is shared.
function weekShareHTML() {
  var shared = tracks.filter(function(track) { return track && track.shared; });
  if (!shared.length) return '';
  var body;
  if (!_aiConfig || !_aiConfig.endpoint) {
    body = '<p class="listen-note">Connect the AI worker to see plays and hearts on your share links.</p>';
  } else if (!_shareListens.data) {
    body = '<p class="listen-note">' + (_shareListens.error ? esc(_shareListens.error) : 'Counting…') + '</p>';
  } else {
    var plays = 0;
    var hearts = 0;
    var rows = shared.map(function(track) {
      var s = _shareListens.data[track.id] || {};
      plays += Number(s.playsWeek) || 0;
      hearts += Number(s.heartsWeek) || 0;
      return { track:track, plays:Number(s.playsWeek) || 0, hearts:Number(s.heartsWeek) || 0 };
    }).filter(function(row) { return row.plays || row.hearts; })
      .sort(function(a, b) { return b.plays + b.hearts - a.plays - a.hearts; });
    body = '<p class="week-lead">' + (plays || hearts
      ? esc(plays + (plays === 1 ? ' play' : ' plays') + ' and ' + hearts + ' ♥ from people you shared songs with.')
      : 'No plays on your share links this week.') + '</p>'
      + rows.slice(0, 3).map(function(row) {
        return weekRow(row.track, row.plays + (row.plays === 1 ? ' play' : ' plays') + (row.hearts ? ' · ♥ ' + row.hearts : '') + ' this week');
      }).join('');
  }
  return '<div class="week-block"><div class="week-label">On your share links</div>' + body + '</div>';
}

function renderWeekRecap() {
  var el = document.getElementById('week-recap');
  if (!el) return;
  var now = new Date();
  var first = firstPlayDay();
  if (!first) { el.innerHTML = ''; return; }
  var week = weekRecap(tracks, now);
  // A comparison needs a whole week before this one.
  var comparable = first <= localDayKey(new Date(now.getTime() - 14 * DAY_MS));
  var delta = week.plays - week.playsBefore;
  var tiles = weekTile(String(week.plays), 'Plays this week',
      comparable ? (delta === 0 ? 'Same as the week before' : (delta > 0 ? '↑ ' : '↓ ') + Math.abs(delta) + ' on the week before') : '')
    + weekTile(week.seconds ? fmtLongDuration(week.seconds) : '0m', 'Listening time', week.skips ? week.skips + (week.skips === 1 ? ' skip' : ' skips') : '')
    + weekTile(week.daysListened + ' of 7', 'Days you listened', '')
    + weekTile(String(week.made.length), 'Songs made', week.made.length ? trimText(week.made.map(function(t) { return t.title || 'Untitled'; }).join(', '), 60) : '');

  var repeat = week.top.length
    ? week.top.map(function(item) { return weekRow(item.track, item.listens + (item.listens === 1 ? ' play' : ' plays') + ' this week'); }).join('')
    : '<div class="insight-empty-row">Nothing played this week yet.</div>';

  var skipped = tracks.filter(function(track) { return oftenSkipped(track, now); }).map(function(track) {
    var n = countSince(track.skipDays, now, SKIP_WINDOW_DAYS);
    return weekRow(track, 'Skipped ' + n + ' times lately',
      '<button type="button" class="sec-action" onclick="event.stopPropagation();forgetSkips(' + jsq(track.id) + ')">Keep in mixes</button>');
  });

  el.innerHTML = '<div class="section-card week-card"><div class="section-inner">'
    + '<div class="section-head"><div><div class="section-title">Your week</div>'
    + '<div class="section-sub">The last seven days of your own listening.' + (comparable ? '' : ' Plays have been counted by day since ' + askDate(first) + ', so earlier weeks aren’t here.') + '</div></div></div>'
    + '<div class="stat-grid">' + tiles + '</div>'
    + '<div class="insight-cols">'
    +   '<div class="week-block"><div class="week-label">On repeat</div><div class="rank-list">' + repeat + '</div></div>'
    +   (weekShareHTML() || (week.made.length
          ? '<div class="week-block"><div class="week-label">Made this week</div><div class="rank-list">' + week.made.slice(0, 5).map(function(track) { return weekRow(track, [track.genre, track.mood].filter(Boolean).join(' / ')); }).join('') + '</div></div>'
          : ''))
    + '</div>'
    + (skipped.length ? '<div class="week-block"><div class="week-label">Kept out of mixes</div><p class="week-lead">You keep skipping these, so the smart mixes, radio and the mix for the time of day leave them out. They stay in the library and your playlists.</p><div class="rank-list">' + skipped.join('') + '</div></div>' : '')
    + '</div></div>';
}
