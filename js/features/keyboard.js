// Keyboard: Enter/Space for card-style buttons, and the player and
// navigation shortcuts (press ? in the app for the list).

// Keyboard shortcuts. Skipped while typing in a field; most are disabled
// while a dialog is open (Escape still closes the dialog). Press ? for help.
var _preMuteVolume = null;

function toggleMute() {
  if (_userVolume > 0) {
    _preMuteVolume = _userVolume;
    setPlayerVolume(0);
    showToast('Muted');
  } else {
    setPlayerVolume(_preMuteVolume != null ? _preMuteVolume : 0.8);
    showToast('Unmuted');
  }
}

function keyboardSeek(delta) {
  if (!_audio.duration) return;
  _audio.currentTime = Math.max(0, Math.min(_audio.duration, _audio.currentTime + delta));
  updateMediaSessionPosition();
}

// Cards and rails are <div onclick> for layout reasons (they wrap cover art
// and multi-line copy). Those carry role="button" + tabindex="0" in the
// markup; this gives them the Enter/Space activation a real button gets.
// Registered BEFORE the shortcut handler so Space activates the focused card
// instead of toggling playback.
document.addEventListener('keydown', function(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  var el = e.target;
  if (!el || !el.getAttribute || el.getAttribute('role') !== 'button') return;
  var tag = (el.tagName || '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  el.click();
});

document.addEventListener('keydown', function(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Nothing behind the sign-in page answers the keyboard.
  if (typeof isSignInLocked === 'function' && isSignInLocked()) return;

  var target = e.target || {};
  var tag = (target.tagName || '').toUpperCase();
  var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;

  // Escape always works: dismiss an open card menu first, then the open
  // dialog, then collapse an expanded track.
  if (e.key === 'Escape') {
    var openMenu = document.querySelector('.card-menu.open');
    if (openMenu) {
      var owner = document.getElementById(openMenu.id.replace('menu-', 'menubtn-'));
      closeAllCardMenus();
      if (owner) owner.focus();
      e.preventDefault();
      return;
    }
    var overlay = getOpenOverlay();
    if (overlay) { closeModal(overlay.id); e.preventDefault(); return; }
    if (_expandedTrackId) { toggleExpand(_expandedTrackId); e.preventDefault(); }
    if (typing && target.blur) target.blur();
    return;
  }

  if (typing) return;

  // While a dialog is open, swallow everything else so shortcuts don't fire
  // behind it.
  if (getOpenOverlay()) return;

  // Let buttons/links/card-buttons handle their own activation keys.
  if ((tag === 'BUTTON' || tag === 'A' || target.getAttribute && target.getAttribute('role') === 'button')
      && (e.key === ' ' || e.key === 'Enter')) return;

  switch (e.key) {
    case ' ':
    case 'k':
    case 'K':
      togglePlayback(); e.preventDefault(); break;
    case 'j':
    case 'J':
      keyboardSeek(-10); e.preventDefault(); break;
    case 'l':
    case 'L':
      keyboardSeek(10); e.preventDefault(); break;
    case 'ArrowLeft':
      keyboardSeek(-5); e.preventDefault(); break;
    case 'ArrowRight':
      keyboardSeek(5); e.preventDefault(); break;
    case 'ArrowUp':
      setPlayerVolume(Math.min(1, _userVolume + 0.05)); e.preventDefault(); break;
    case 'ArrowDown':
      setPlayerVolume(Math.max(0, _userVolume - 0.05)); e.preventDefault(); break;
    case 'n':
    case 'N':
      playNext(); e.preventDefault(); break;
    case 'p':
    case 'P':
      playPrevious(); e.preventDefault(); break;
    case 's':
    case 'S':
      toggleShuffle(); e.preventDefault(); break;
    case 'r':
    case 'R':
      cycleRepeat(); e.preventDefault(); break;
    case 'm':
    case 'M':
      toggleMute(); e.preventDefault(); break;
    case '/':
      switchView('library');
      var search = document.getElementById('search-input');
      if (search) search.focus();
      e.preventDefault(); break;
    case '1':
      switchView('library'); e.preventDefault(); break;
    case '2':
      switchView('playlists'); e.preventDefault(); break;
    case '3':
      switchView('create'); e.preventDefault(); break;
    case '4':
      switchView('upload'); e.preventDefault(); break;
    case '5':
      switchView('insights'); e.preventDefault(); break;
    case '?':
      openModal('modal-shortcuts'); e.preventDefault(); break;
  }
});
