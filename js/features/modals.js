// Dialog open/close with real focus management: remember the opener, keep
// Tab inside, and hand focus back on close.

// ── Dialog focus management ────────────────────────────────────────────
// Dialogs are plain divs (not <dialog>), so focus containment is manual:
// remember what opened the dialog, move focus inside, keep Tab from escaping
// to the page behind, and hand focus back on close.
var FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"][tabindex="0"]';
var _modalReturnFocus = {};
var _modalCloseTimers = {};

function getVisibleFocusable(root) {
  return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE_SELECTOR), function(el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
  });
}

function openModal(id) {
  var overlay = document.getElementById(id);
  if (!overlay) return;
  if (id === 'modal-playlist') populatePlaylistCheckboxes();
  // Reopened mid-close: cancel the close so it stays open.
  if (_modalCloseTimers[id]) {
    clearTimeout(_modalCloseTimers[id]);
    delete _modalCloseTimers[id];
    overlay.classList.remove('closing');
  }
  if (!overlay.classList.contains('open')) {
    _modalReturnFocus[id] = document.activeElement;
  }
  overlay.classList.add('open');
  // Synchronous on purpose: querying offsetWidth forces layout, so the
  // dialog's focusables are measurable immediately. Deferring to
  // requestAnimationFrame would silently skip focus placement whenever the
  // tab is backgrounded, since rAF does not fire on unrendered pages.
  focusFirstIn(overlay);
}

function focusFirstIn(overlay) {
  var focusable = getVisibleFocusable(overlay);
  if (focusable.length) {
    focusable[0].focus();
    return true;
  }
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();
  return false;
}

function closeModal(id) {
  var overlay = document.getElementById(id);
  if (!overlay || !overlay.classList.contains('open') || overlay.classList.contains('closing')) return;
  // Play the exit animation, then hide. Focus returns straight away.
  if (motionAllowed()) {
    overlay.classList.add('closing');
    _modalCloseTimers[id] = setTimeout(function() {
      overlay.classList.remove('open', 'closing');
      delete _modalCloseTimers[id];
    }, 240);
  } else {
    overlay.classList.remove('open');
  }
  var returnTo = _modalReturnFocus[id];
  delete _modalReturnFocus[id];
  if (returnTo && returnTo.focus && document.contains(returnTo)) {
    returnTo.focus();
    return;
  }
  // The opener is often gone by now: acting in a dialog (adding a track,
  // saving an edit) re-renders the grid that contained the button that
  // opened it. Land on the current view's nav tab rather than dropping
  // focus to <body>, which would restart tabbing from the top of the page.
  var fallback = document.getElementById('gtab-' + _activeView) || document.querySelector('.group-tab.active');
  if (fallback && fallback.focus) fallback.focus();
}

// Tab containment. Runs on capture so it wins before anything else reacts.
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Tab') return;
  var overlay = getOpenOverlay();
  if (!overlay) return;
  var focusable = getVisibleFocusable(overlay);
  if (!focusable.length) { e.preventDefault(); return; }
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}, true);

document.querySelectorAll('.modal-overlay, .player-modal-overlay').forEach(function(overlay) {
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

function getOpenOverlay() {
  var overlays = document.querySelectorAll('.modal-overlay.open:not(.closing), .player-modal-overlay.open:not(.closing)');
  return overlays.length ? overlays[overlays.length - 1] : null;
}
