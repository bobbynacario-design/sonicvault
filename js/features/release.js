// Ready for Spotify?, on Insights (js/data/release.js): which songs could go
// out through a distributor, sorted into ready, to fix first, to check and
// can't be released, each with what it needs. The one thing the vault can't
// know -- the day the Suno plan began -- is asked for here and kept in the
// synced settings (appSettings.release.sunoPlanSince). When each song was
// made comes from the stamp Suno writes into its file, which the art sweep
// copies onto the track (applySunoStamps in artwork.js).

var RELEASE_SHOWN = 6;
var RELEASE_SECTIONS = [
  { status:'ready', title:'Ready', lead:'Nothing in the vault stands in the way of these. Each still needs the release steps at the bottom.' },
  { status:'fix', title:'To fix first', lead:'These could go out once what’s shown is fixed.' },
  { status:'check', title:'To check', lead:'Each needs something only you can confirm.' },
  { status:'blocked', title:'Can’t be released', lead:'Made before your Suno plan began. Suno keeps songs made on the free plan for personal use, and subscribing later doesn’t change that.' }
];
var RELEASE_LEVEL_LABELS = { block:'Can’t release: ', check:'Check: ', fix:'Fix: ', note:'Note: ', ok:'OK: ' };
var RELEASE_STEPS = [
  'The WAV from Suno (its Download menu, on Pro or Premier), not the MP3 in the vault.',
  'Cover art at 3000 × 3000 pixels. The picture in a Suno file is 360 × 360, too small for distributors.',
  'Say that AI was used when you upload. DistroKid passes it on to Spotify’s AI credits.',
  'Your artist name, and your own name as songwriter for words you wrote.',
  'One take per song, released a few at a time rather than the whole vault at once.',
  'The synced lyrics file to Musixmatch, which supplies Spotify’s lyrics.',
  'Royalties start once a track passes 1,000 streams in a year.'
];
var _release = { open:{} };

function releasePlanSince() {
  var day = appSettings && appSettings.release && appSettings.release.sunoPlanSince;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : '';
}

function setReleasePlanSince(value) {
  var day = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : '';
  appSettings = window.appSettings || appSettings || {};
  appSettings.release = Object.assign({}, appSettings.release, { sunoPlanSince:day });
  window.appSettings = appSettings;
  save('settings', appSettings);
  renderRelease();
}

function releaseState() {
  var planSince = releasePlanSince();
  var drafts = appSettings && appSettings.songLab && Array.isArray(appSettings.songLab.drafts) ? appSettings.songLab.drafts : [];
  var candidates = releaseCandidates(tracks, memoVersionKey);
  var clashes = releaseTitleClashes(candidates);
  var groups = { ready:[], fix:[], check:[], blocked:[] };
  var suno = 0;
  candidates.forEach(function(track) {
    if (track.source === 'Suno' || track.madeAt || track.sunoId) suno++;
    var check = releaseCheck(track, {
      planSince:planSince,
      takes:getVersionGroup(track),
      clashes:clashes[track.id],
      timed:hasUsableLyricTimes(track),
      fromDraft:drafts.some(function(draft) { return songCameFromDraft(track.lyrics, draft && draft.lyrics); })
    });
    groups[check.status].push({ track:track, check:check, made:releaseMadeDay(track) });
  });
  Object.keys(groups).forEach(function(status) {
    groups[status].sort(function(a, b) {
      return String(b.made.day).localeCompare(String(a.made.day)) || String(a.track.title || '').localeCompare(String(b.track.title || ''));
    });
  });
  return { planSince:planSince, total:candidates.length, suno:suno, groups:groups };
}

function toggleReleaseSection(status) {
  _release.open[status] = !_release.open[status];
  renderRelease();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function releaseRow(item) {
  var track = item.track;
  var facts = [
    item.made.day ? (item.made.fromFile ? 'Made ' : 'Added ') + askDate(item.made.day) : '',
    Number(track.duration) > 0 ? fmtTime(track.duration) : '',
    track.source || ''
  ].filter(Boolean).join(' · ');
  var tidy = item.check.items.filter(function(entry) { return entry.tidy; })[0];
  var actions = (tidy ? tidyButton('Tidy title', 'applyTidyTitle(' + jsq(track.id) + ')', false) : '')
    + (/^[0-9a-f-]{36}$/i.test(String(track.sunoId || ''))
      ? '<a class="sec-action" href="https://suno.com/song/' + attr(track.sunoId) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open in Suno</a>' : '')
    + (hasUsableLyricTimes(track) ? tidyButton('Synced lyrics', 'downloadLyricsFile(' + jsq(track.id) + ', false)', false) : '');
  var list = '<ul class="release-items">' + item.check.items.map(function(entry) {
    return '<li class="release-item is-' + attr(entry.level) + '"><span class="sr-only">' + RELEASE_LEVEL_LABELS[entry.level] + '</span>' + esc(entry.text) + '</li>';
  }).join('') + '</ul>';
  return tidyRow(track, esc(facts), actions, list);
}

function releaseSection(section, items) {
  if (!items.length) return '';
  var open = !!_release.open[section.status];
  var shown = open ? items : items.slice(0, RELEASE_SHOWN);
  return '<div class="week-block tidy-block">'
    + '<div class="tidy-head"><div class="week-label">' + esc(section.title) + ' <span class="tidy-count">' + items.length + '</span></div></div>'
    + '<p class="week-lead">' + esc(section.lead) + '</p>'
    + '<div class="rank-list">' + shown.map(releaseRow).join('') + '</div>'
    + (items.length > RELEASE_SHOWN ? '<button type="button" class="create-setup-link tidy-more" onclick="toggleReleaseSection(' + jsq(section.status) + ')">' + (open ? 'Show fewer' : 'Show all ' + items.length) + '</button>' : '')
    + '</div>';
}

function releasePlanField(planSince, suno) {
  return '<div class="release-plan">'
    + '<label class="form-label" for="release-plan">On Suno Pro or Premier since</label>'
    + '<input type="date" class="form-input" id="release-plan" value="' + attr(planSince) + '" max="' + attr(localDayKey(new Date())) + '" onchange="setReleasePlanSince(this.value)">'
    + '<p class="week-note">' + (planSince ? '' : 'Set it to sort your ' + suno + (suno === 1 ? ' Suno song' : ' Suno songs') + '. ')
    + 'Suno gives release rights only to songs made while you’re subscribed. If your plan lapsed for a while, songs made in the gap can’t be released either.</p>'
    + '</div>';
}

function releaseSteps() {
  return '<div class="week-block">'
    + '<div class="week-label">Every release also needs</div>'
    + '<ul class="release-steps">' + RELEASE_STEPS.map(function(step) { return '<li>' + esc(step) + '</li>'; }).join('') + '</ul>'
    + '<p class="week-note release-foot">The rules as of October 2026. Check <a href="https://help.suno.com/en/categories/550145" target="_blank" rel="noopener">Suno’s rights page</a> and your distributor’s AI policy before you upload.</p>'
    + '</div>';
}

function renderRelease() {
  var el = document.getElementById('release-card');
  if (!el) return;
  if (!tracks.length || _coverDemoActive) { el.innerHTML = ''; return; }
  var state = releaseState();
  var waiting = !state.planSince && state.suno > 0;
  var body = '';
  if (!waiting) {
    var groups = state.groups;
    body = '<div class="stat-grid release-tally">'
      + RELEASE_SECTIONS.map(function(section) {
        return '<div class="stat-tile"><div class="stat-value">' + groups[section.status].length + '</div><div class="stat-label">' + esc(section.title) + '</div></div>';
      }).join('')
      + '</div>'
      + RELEASE_SECTIONS.map(function(section) { return releaseSection(section, groups[section.status]); }).join('');
  }
  el.innerHTML = '<div class="section-card release-card"><div class="section-inner">'
    + '<div class="section-head"><div><div class="section-title">Ready for Spotify?</div>'
    + '<div class="section-sub">Which of your ' + state.total + (state.total === 1 ? ' song' : ' songs') + ' could go out through a distributor such as DistroKid, and what each needs first. It goes by what the vault knows, including the day Suno stamped in each file, not by your Suno account.</div></div></div>'
    + releasePlanField(state.planSince, state.suno)
    + body
    + releaseSteps()
    + '</div></div>';
}
