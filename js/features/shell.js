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

function toggleTheme() {
  var isLight = document.body.classList.toggle('light');
  document.getElementById('theme-toggle').textContent = isLight ? 'Sun' : 'Moon';
  localStorage.setItem('sv_theme', isLight ? 'light' : 'dark');
}
if (localStorage.getItem('sv_theme') === 'light') {
  document.body.classList.add('light');
  document.getElementById('theme-toggle').textContent = 'Sun';
}

function updateAuthButton() {
  var btn = document.getElementById('auth-toggle');
  if (!btn) return;
  var user = window.fbOwnerUser;
  btn.textContent = user && user.email ? trimText(user.email, 16) : 'Owner';
  btn.title = user && user.email ? ('Signed in as ' + user.email) : 'Owner sign-in';
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
