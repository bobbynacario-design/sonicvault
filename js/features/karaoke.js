// Karaoke: the song's lyrics full screen, each word filling in as it is
// sung. Word times come from the same transcription as the line times
// (lyricSync.words, karaokeWords in js/data/lyric-sync.js). A song timed
// before word times were kept fetches them once, through the sung check's
// request; until they arrive its words are spread through each line.
// The view is a dialog (#modal-karaoke) so focus, Escape and Tab behave as
// in every other one, but the playback keys still work inside it
// (js/features/keyboard.js).

var KARAOKE_LEAD = .1;       // seconds: a word lights up just ahead of the voice
var _karaoke = null;         // { trackId, key, index, words: { line: [...] }, playing, frame }

function karaokeTrack() {
  return _currentTrack ? getVaultTrack(_currentTrack.id) : null;
}

function karaokeAvailable(track) {
  return !!(track && hasLyrics(track) && hasUsableLyricTimes(track));
}

function openKaraoke() {
  var track = karaokeTrack();
  if (!karaokeAvailable(track)) return;
  _karaoke = { trackId:'', key:'', index:-2, words:{}, playing:null, frame:0 };
  openModal('modal-karaoke');
  karaokeFrame();
}

// Called by closeModal however the view closes.
function onKaraokeClosed() {
  if (_karaoke) cancelAnimationFrame(_karaoke.frame);
  _karaoke = null;
}

// Everything that depends on the song: rebuilt when the song changes or
// its timings do (word times arriving, a line re-timed by hand).
function karaokeSongKey(track) {
  var sync = getLyricSync(track);
  return track.id + '|' + (sync ? sync.at + sync.source + (sync.words ? 'w' : '') : '') + '|' + (_audio.duration || 0);
}

function prepareKaraokeSong(track) {
  _karaoke.trackId = track ? track.id : '';
  _karaoke.key = track ? karaokeSongKey(track) : '';
  _karaoke.index = -2;
  _karaoke.words = {};
  var title = document.getElementById('karaoke-title');
  var sub = document.getElementById('karaoke-sub');
  var backdrop = document.getElementById('karaoke-backdrop');
  var artImg = document.getElementById('karaoke-art');
  title.textContent = track ? track.title || 'Untitled' : (_currentTrack ? _currentTrack.title : '');
  sub.textContent = track ? [track.genre, track.mood].filter(Boolean).join(' · ') : '';
  var palette = getCoverPalette(track || _currentTrack || {});
  var art = track ? getArtURL(track.id) : '';
  artImg.hidden = !art;
  if (art) artImg.src = art;
  else artImg.removeAttribute('src');
  backdrop.style.setProperty('--k-a', palette.a);
  backdrop.style.setProperty('--k-b', palette.b);
  document.getElementById('modal-karaoke').style.setProperty('--k-accent', palette.accent || palette.a);
  // Songs timed before word times were kept get them once.
  var sync = track && getLyricSync(track);
  if (sync && !sync.words && lyricSyncEndpoint() && !_sungCheckJobs[track.id] && !_sungCheckFailed[track.id]) requestSungCheck(track);
}

function karaokeLineWords(track, index, times) {
  if (_karaoke.words[index]) return _karaoke.words[index];
  var lyrics = getTrackLyrics(track);
  var lines = sungLyricLines(lyrics);
  var sync = getLyricSync(track);
  var starts = null;
  if (sync && sync.words) {
    var place = lyricWordOffsets(lyrics);
    starts = sync.words.slice(place.offsets[index], place.offsets[index] + lyricWordsOf(lines[index]).length);
  }
  _karaoke.words[index] = karaokeWords(lines[index], times[index], starts);
  return _karaoke.words[index];
}

function karaokeLineHTML(track, index, times, role) {
  var lines = sungLyricLines(getTrackLyrics(track));
  if (index < 0 || index >= lines.length) return '<div class="k-line k-' + role + '" aria-hidden="true">&nbsp;</div>';
  if (role !== 'now') return '<div class="k-line k-' + role + '">' + esc(lines[index]) + '</div>';
  return '<div class="k-line k-now">' + karaokeLineWords(track, index, times).map(function(word, w) {
    return '<span class="kw" data-w="' + w + '">' + esc(word.text) + '</span>' + esc(word.space);
  }).join('') + '</div>';
}

// The lines on screen: the one just sung, the one being sung, and the two
// after it. Between lines, the next one waits where the sung line goes.
function renderKaraokeLines(track, index, times, t) {
  var box = document.getElementById('karaoke-lines');
  var html;
  if (!track) {
    html = '<div class="k-empty">This song has no timed lyrics.</div>';
  } else if (index >= 0) {
    html = karaokeLineHTML(track, index - 1, times, 'past')
      + karaokeLineHTML(track, index, times, 'now')
      + karaokeLineHTML(track, index + 1, times, 'next')
      + karaokeLineHTML(track, index + 2, times, 'later');
  } else {
    var next = 0;
    while (next < times.length && times[next][0] <= t) next++;
    html = '<div class="k-line k-past" aria-hidden="true">&nbsp;</div>'
      + (next < times.length ? '<div class="k-line k-wait">' + esc(sungLyricLines(getTrackLyrics(track))[next]) + '</div>' : '<div class="k-line k-wait" aria-hidden="true">&nbsp;</div>')
      + karaokeLineHTML(track, next + 1, times, 'next')
      + karaokeLineHTML(track, next + 2, times, 'later');
  }
  box.innerHTML = html;
  box.classList.remove('k-moved');
  void box.offsetWidth;   // restart the slide-in
  box.classList.add('k-moved');
}

// How far through each word of the line being sung, as --p from 0 to 1.
function paintKaraokeWords(track, index, times, t) {
  var words = karaokeLineWords(track, index, times);
  var spans = document.querySelectorAll('#karaoke-lines .k-now .kw');
  var at = t + KARAOKE_LEAD;
  for (var w = 0; w < spans.length; w++) {
    var word = words[w];
    if (!word) continue;
    var p = Math.max(0, Math.min(1, (at - word.start) / Math.max(.15, Math.min(1.5, word.end - word.start))));
    var shown = Number(spans[w].getAttribute('data-p') || -1);
    if (Math.abs(shown - p) > .01 || (p === 1 && shown !== 1) || (p === 0 && shown !== 0)) {
      spans[w].style.setProperty('--p', p.toFixed(3));
      spans[w].setAttribute('data-p', p.toFixed(3));
    }
  }
}

function karaokeStatus(track) {
  if (!track) return '';
  var sync = getLyricSync(track);
  if (sync && !sync.words && _sungCheckJobs[track.id]) return 'Timing each word… the line timings carry it until then.';
  return '';
}

function karaokeFrame() {
  if (!_karaoke) return;
  var track = karaokeTrack();
  var usable = karaokeAvailable(track) ? track : null;
  if ((usable ? usable.id : '') !== _karaoke.trackId || (usable && karaokeSongKey(usable) !== _karaoke.key)) prepareKaraokeSong(usable);
  var t = _audio.currentTime || 0;
  var times = usable ? getCurrentLyricTimes() : [];
  var index = usable && times ? currentLyricIndex(times, t, .25) : -1;
  if (index !== _karaoke.index) {
    _karaoke.index = index;
    renderKaraokeLines(usable, index, times || [], t);
  }
  if (usable && index >= 0) paintKaraokeWords(usable, index, times, t);

  var playing = !_audio.paused;
  if (playing !== _karaoke.playing) {
    _karaoke.playing = playing;
    setPlayButton(document.getElementById('karaoke-play'), playing);
  }
  var duration = _audio.duration || 0;
  document.getElementById('karaoke-fill').style.width = duration ? Math.min(100, t / duration * 100).toFixed(2) + '%' : '0%';
  document.getElementById('karaoke-time').textContent = fmtTime(t) + ' / ' + fmtTime(duration);
  var status = document.getElementById('karaoke-status');
  var note = karaokeStatus(usable);
  if (status.textContent !== note) status.textContent = note;
  // Hidden tabs get no frames; the view catches up when it is seen again.
  _karaoke.frame = requestAnimationFrame(karaokeFrame);
}

function karaokeSeek(event) {
  var bar = event.currentTarget;
  var rect = bar.getBoundingClientRect();
  if (!_audio.duration || !rect.width) return;
  _audio.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * _audio.duration;
  updateMediaSessionPosition();
}

// The Karaoke button in the expanded player's lyrics card.
function renderKaraokeButton() {
  var btn = document.getElementById('xp-karaoke-btn');
  if (btn) btn.hidden = !karaokeAvailable(karaokeTrack());
}
