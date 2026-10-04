// The sign-in page (#login-overlay in index.html), laid out like PokerHQ's
// and Enclave's: the vault's private views stay behind it until its owner
// signs in with Google. Share links never see it, and "Look around with
// demo tracks" opens the memory-only cover demo instead.
//
// Whether it shows at first paint is decided by js/first-paint.js, loaded
// under the overlay's markup before the rest of the page is parsed: hidden
// on share links, and for whoever was signed in last time on this device
// (sv_owner_hint), so the owner's vault opens straight from its cache, even
// offline. js/app.js reports the real answer once Firebase knows it
// (svSignInGate), and reports a signed-in account the vault's rules refuse
// (svAccessDenied).

var OWNER_HINT_KEY = 'sv_owner_hint';
// Mirrors isBobGoogleAccount() in firestore.rules. An account on this list
// is never signed out over a refused read: that is a rules or network
// problem the sync pill reports, not a stranger at the door.
var VAULT_OWNER_EMAILS = ['bobbynacario@gmail.com'];
var SIGN_IN_TIMEOUT_MS = 10000;

var _signInAuth = 'unknown';      // 'unknown' | 'owner' | 'signed-out'
var _signInMessage = '';
var _signInBusy = false;
var _signInTimer = null;
var _installPrompt = null;

function getOverlay() {
  return document.getElementById('login-overlay');
}

function isVaultOwnerEmail(email) {
  return VAULT_OWNER_EMAILS.indexOf(lower(email)) !== -1;
}

function setOwnerHint(on) {
  try {
    if (on) localStorage.setItem(OWNER_HINT_KEY, '1');
    else localStorage.removeItem(OWNER_HINT_KEY);
  } catch (e) {}
}

// Everything but the sign-in page (and the toast) is inert while it shows:
// no tab stops, clicks or screen-reader reading behind it, and nothing
// playing on.
function lockApp(locked) {
  document.documentElement.classList.toggle('sv-locked', locked);
  var overlay = getOverlay();
  Array.prototype.forEach.call(document.body.children, function(el) {
    if (el === overlay || el.id === 'sv-toast' || el.tagName === 'SCRIPT' || el.tagName === 'svg') return;
    el.inert = locked;
  });
  if (locked && typeof _isPlaying !== 'undefined' && _isPlaying) togglePlayback();
}

function isSignInLocked() {
  var overlay = getOverlay();
  return !!(overlay && !overlay.hidden);
}

// 'hidden', 'checking' (a status line, no button) or 'signin' (the Google
// button, and the message when there is one).
function setSignInState(state, message) {
  var overlay = getOverlay();
  if (!overlay) return;
  var status = document.getElementById('login-status');
  var error = document.getElementById('login-error');
  var google = document.getElementById('login-google-btn');
  clearTimeout(_signInTimer);
  if (state === 'hidden') {
    overlay.hidden = true;
    lockApp(false);
    return;
  }
  var wasHidden = overlay.hidden;
  overlay.hidden = false;
  lockApp(true);
  if (status) {
    status.hidden = state !== 'checking';
    if (state === 'checking') status.textContent = message || 'Checking sign-in…';
  }
  if (google) google.hidden = state !== 'signin';
  if (error) {
    error.hidden = !(state === 'signin' && message);
    error.textContent = state === 'signin' ? (message || '') : '';
  }
  var install = document.getElementById('login-install-btn');
  if (install) install.hidden = !_installPrompt;
  if (state === 'checking' && _signInAuth === 'unknown') {
    // Firebase never answering (blocked, or offline on a first visit) must
    // not leave the page on "Checking" for good.
    _signInTimer = setTimeout(function() {
      if (_signInAuth === 'unknown') setSignInState('signin', 'Can’t reach Google sign-in right now. Check your connection and try again.');
    }, SIGN_IN_TIMEOUT_MS);
  }
  if (state === 'signin' && google && (wasHidden || !overlay.contains(document.activeElement))) {
    try { google.focus({ preventScroll:true }); } catch (e) {}
  }
}

// What the page should show now, from what is known: never on a share
// link or in the demo, never for the owner, and for anyone else once
// Firebase has said so.
function refreshSignInGate() {
  var share = typeof _routeState !== 'undefined' && _routeState && _routeState.mode !== 'app';
  var demo = typeof _coverDemoActive !== 'undefined' && _coverDemoActive;
  if (share || demo || _signInAuth === 'owner') {
    setSignInState('hidden');
  } else if (_signInAuth === 'signed-out') {
    if (!_signInBusy) setSignInState('signin', _signInMessage);
  } else if (isSignInLocked()) {
    setSignInState('checking');
  }
}

// Called by js/app.js whenever Firebase's sign-in state changes.
function svSignInGate(state) {
  _signInAuth = state === 'owner' ? 'owner' : 'signed-out';
  setOwnerHint(_signInAuth === 'owner');
  if (_signInAuth === 'owner') {
    _signInMessage = '';
    _signInBusy = false;
    // Signing in from the demo means wanting the real vault.
    if (typeof _coverDemoActive !== 'undefined' && _coverDemoActive) exitCoverDemo(true);
  }
  refreshSignInGate();
}

// A signed-in account that is not the owner's: sign it out, and say why on
// the page it lands back on.
function svAccessDenied(email) {
  if (isVaultOwnerEmail(email)) return false;
  _signInMessage = (email || 'This Google account') + ' doesn’t have access to this vault. Sign in with the owner’s Google account.';
  if (window.fbSignOutOwner) window.fbSignOutOwner().catch(function() {});
  return true;
}

function signInErrorMessage(err) {
  switch (err && err.code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return '';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    case 'auth/unauthorized-domain':
      return 'Sign-in isn’t allowed from this address. Open SonicVault from its usual link.';
    case 'auth/user-disabled':
      return 'This Google account has been disabled.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    default:
      return 'Couldn’t sign in. Please try again.';
  }
}

// A redirect sign-in that failed comes back through here (js/app.js).
function svSignInError(err) {
  _signInBusy = false;
  _signInMessage = signInErrorMessage(err);
  if (_signInAuth !== 'owner') setSignInState('signin', _signInMessage);
}

function ownerSignIn() {
  if (_signInBusy) return;
  if (!window.fbSignIn) {
    setSignInState('signin', 'Sign-in is still loading. Try again in a moment.');
    return;
  }
  _signInBusy = true;
  _signInMessage = '';
  setSignInState('checking', 'Waiting for Google…');
  window.fbSignIn().then(function() {
    // onAuthStateChanged takes it from here; a non-owner is turned back by
    // svAccessDenied once the vault refuses them.
    _signInBusy = false;
    if (_signInAuth !== 'owner') setSignInState('checking', 'Opening your vault…');
  }).catch(function(err) {
    _signInBusy = false;
    svSignInError(err);
  });
}

function enterVaultDemo() {
  startCoverDemo();
  refreshSignInGate();
}

// Chrome and Edge offer installing the app; the card carries the button
// while the offer stands, as PokerHQ's does.
window.addEventListener('beforeinstallprompt', function(event) {
  event.preventDefault();
  _installPrompt = event;
  var install = document.getElementById('login-install-btn');
  if (install) install.hidden = false;
});

window.addEventListener('appinstalled', function() {
  _installPrompt = null;
  var install = document.getElementById('login-install-btn');
  if (install) install.hidden = true;
});

function installVaultApp() {
  if (!_installPrompt) return;
  var prompt = _installPrompt;
  _installPrompt = null;
  prompt.prompt();
  prompt.userChoice.finally(function() {
    var install = document.getElementById('login-install-btn');
    if (install) install.hidden = !_installPrompt;
  });
}

window.svSignInGate = svSignInGate;
window.svAccessDenied = svAccessDenied;
window.svSignInError = svSignInError;

// The inline script may already have shown the page; make it whole (status
// line, inert app, the timeout) now that this file has loaded.
if (isSignInLocked()) setSignInState('checking');
