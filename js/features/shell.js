// App chrome that belongs to no one page: the toast, the clock, the theme,
// the owner sign-in button, and the CSS variables that track the fluid
// player and sync banner heights.

var _chromeObserver = null;
function syncChromeHeightVars() {
  syncPlayerHeightVar();
  syncBannerHeightVar();
}

// Both the player and the sync banner are fluid, and everything else in the
// layout positions off their heights.
function observeChromeHeights() {
  var bar = document.getElementById('now-playing');
  var banner = document.getElementById('sync-banner');
  syncChromeHeightVars();
  // The player's .active toggle changes transform, not size, so
  // ResizeObserver never fires for it -- updateNowPlaying() syncs directly.
  if (window.ResizeObserver && !_chromeObserver) {
    _chromeObserver = new ResizeObserver(syncChromeHeightVars);
    if (bar) _chromeObserver.observe(bar);
    if (banner) _chromeObserver.observe(banner);
  }
  window.addEventListener('resize', syncChromeHeightVars);
}

// Markup for one glyph from the sprite at the top of index.html. Decorative:
// the button or row that holds it carries the accessible name.
function icon(name) {
  return '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>';
}

// Animated equaliser marking the current track. It moves only while
// body.is-playing is set (syncPlayerLiveState), so a pause from anywhere --
// the lock screen included -- freezes it in place.
function eqBars() {
  return '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
}

function motionAllowed() {
  return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Replace a cover only when it is a different picture, then fade the new one
// in. The players re-render on every play/pause and timer tick; rebuilding
// the cover each time restarted its image load and its animations.
function swapCover(host, track, size, includeWords) {
  if (!host) return;
  var key = track.id + '|' + size + '|' + (getArtURL(track.id) ? 'art' : getCoverStyle(track));
  if (host.getAttribute('data-cover') === key) return;
  var hadCover = !!host.getAttribute('data-cover');
  host.setAttribute('data-cover', key);
  host.innerHTML = buildCoverArt(track, size, includeWords);
  if (hadCover && motionAllowed()) {
    host.classList.remove('cover-swap');
    void host.offsetWidth;
    host.classList.add('cover-swap');
  }
}

// Transport buttons show the action they will take, and say it, since the
// glyph is all a sighted user gets.
function setPlayButton(btn, playing) {
  if (!btn) return;
  btn.innerHTML = icon(playing ? 'pause' : 'play');
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function showToast(msg) {
  var el = document.getElementById('sv-toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 2500);
}

function tickClock() {
  var t = new Date().toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit', hour12:false });
  document.getElementById('clock').textContent = 'PHT ' + t;
}
tickClock();
setInterval(tickClock, 1000);

// The button shows the theme it switches to.
function paintThemeToggle() {
  var btn = document.getElementById('theme-toggle');
  var isLight = document.body.classList.contains('light');
  var label = isLight ? 'Switch to dark theme' : 'Switch to light theme';
  btn.innerHTML = icon(isLight ? 'moon' : 'sun');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function toggleTheme() {
  var isLight = document.body.classList.toggle('light');
  paintThemeToggle();
  localStorage.setItem('sv_theme', isLight ? 'light' : 'dark');
}
if (localStorage.getItem('sv_theme') === 'light') {
  document.body.classList.add('light');
  paintThemeToggle();
}

function updateAuthButton() {
  var btn = document.getElementById('auth-toggle');
  if (!btn) return;
  var user = window.fbOwnerUser;
  var signedIn = !!(user && user.email);
  btn.classList.toggle('signed-in', signedIn);
  btn.title = signedIn ? ('Signed in as ' + user.email + ' - select to sign out') : 'Owner sign-in';
  btn.setAttribute('aria-label', btn.title);
}

function toggleOwnerAuth() {
  var user = window.fbOwnerUser;
  if (user && window.fbSignOutOwner) {
    window.fbSignOutOwner().then(function() {
      showToast('Signed out');
    }).catch(function(err) {
      console.error('Sign-out failed:', err);
      showToast('Sign-out failed');
    });
    return;
  }
  if (window.fbSignIn) {
    window.fbSignIn().then(function() {
      showToast('Signed in');
    }).catch(function(err) {
      console.error('Sign-in failed:', err);
      showToast('Sign-in failed');
    });
  }
}
