// Following: people you share songs with can ask for a notice when there's
// a new one, and you tell them when you choose. A visitor's "Get new songs"
// subscribes their browser to Web Push and hands the subscription to the AI
// worker's public /follow; your share dialog's "Tell your followers" asks
// the worker's /notify (with your token) to send one notice per follower,
// which sw.js shows and opens the song from. On iPhone, Web Push works only
// for SonicVault added to the Home Screen, so the button says how.

// The public half of the worker's VAPID key (the private half is the
// worker secret VAPID_PRIVATE_KEY); push services check notices against it.
var FOLLOW_VAPID_KEY = 'BFPpQ0izrCr3rZarBA-qK4cQSnweV990bbhV6NEAr23Ff84fl1KQj2sqTZaTc61SYDryT_I0AHB4CaYzGO_mGIA';
var _followBusy = false;
var _followers = { count:null, ready:false, loading:false };
var _notifying = {};          // track id -> true while notices go out

function followSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// An iPhone or iPad browsing in Safari, where Web Push needs the Home Screen app.
function followNeedsHomeScreen() {
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var installed = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return ios && !installed;
}

function isFollowing() {
  try { return !!localStorage.getItem('sv_following'); } catch (e) { return false; }
}

function vapidKeyBytes() {
  var b64 = FOLLOW_VAPID_KEY.replace(/-/g, '+').replace(/_/g, '/');
  var bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function followSongwriter() {
  if (_followBusy) return;
  if (followNeedsHomeScreen()) {
    showToast('On iPhone: tap Share, then Add to Home Screen. Open SonicVault from there and tap Get new songs.');
    return;
  }
  if (!followSupported()) { showToast('This browser can’t show notices. Try Chrome, Edge or Firefox.'); return; }
  _followBusy = true;
  renderFollowButtons();
  try {
    var permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast(permission === 'denied' ? 'Notices are blocked for this site in your browser settings.' : 'No notices, then. You can follow any time.');
      return;
    }
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:vapidKeyBytes() });
    var response = await fetch(SHARE_PREVIEW_ORIGIN + '/follow', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ subscription:sub.toJSON() })
    });
    if (!response.ok) throw new Error('The songwriter’s server said no (' + response.status + ').');
    try { localStorage.setItem('sv_following', sub.endpoint); } catch (e) {}
    showToast('You’ll get a notice when there’s a new song.');
  } catch (e) {
    console.warn('Follow failed:', e);
    showToast('Couldn’t follow just now: ' + ((e && e.message) || 'try again.'));
  } finally {
    _followBusy = false;
    renderFollowButtons();
  }
}

async function unfollowSongwriter() {
  if (_followBusy) return;
  _followBusy = true;
  var endpoint = '';
  try { endpoint = localStorage.getItem('sv_following') || ''; } catch (e) {}
  try {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (sub) { endpoint = sub.endpoint; await sub.unsubscribe(); }
    if (endpoint) {
      await fetch(SHARE_PREVIEW_ORIGIN + '/unfollow', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ endpoint:endpoint }) });
    }
  } catch (e) {
    console.warn('Unfollow:', e);
  } finally {
    try { localStorage.removeItem('sv_following'); } catch (e) {}
    _followBusy = false;
    renderFollowButtons();
    showToast('No more notices.');
  }
}

// The button on share pages, for visitors only.
function followButtonHTML() {
  if (window.fbOwnerUser) return '';
  return '<button type="button" class="sec-action has-icon follow-btn" data-follow-btn>' + followButtonInner() + '</button>';
}

function followButtonInner() {
  if (_followBusy) return icon('bell') + '<span>One moment…</span>';
  return isFollowing() ? icon('bell') + '<span>Following</span>' : icon('bell') + '<span>Get new songs</span>';
}

function renderFollowButtons() {
  document.querySelectorAll('[data-follow-btn]').forEach(function(btn) {
    btn.innerHTML = followButtonInner();
    btn.classList.toggle('is-following', isFollowing());
    btn.setAttribute('aria-pressed', isFollowing() ? 'true' : 'false');
    btn.title = isFollowing() ? 'You get a notice for new songs. Tap to stop.' : 'Get a notice when there’s a new song';
  });
}

document.addEventListener('click', function(e) {
  var btn = e.target.closest && e.target.closest('[data-follow-btn]');
  if (!btn) return;
  if (isFollowing()) unfollowSongwriter();
  else followSongwriter();
});

// ── Telling followers (the owner) ────────────────────────────────────────

function ownerWorker(route) {
  if (!_aiConfig || !_aiConfig.endpoint) return null;
  var headers = { 'Content-Type':'application/json' };
  if (_aiConfig.token) headers.Authorization = 'Bearer ' + _aiConfig.token;
  return { url:new URL(route, _aiConfig.endpoint).toString(), headers:headers };
}

async function loadFollowerCount() {
  var call = ownerWorker('/followers');
  if (!call || _followers.loading) return;
  _followers.loading = true;
  try {
    var response = await fetch(call.url, { method:'POST', headers:call.headers, body:'{}' });
    var data = await response.json().catch(function() { return {}; });
    if (response.ok) _followers = { count:Number(data.count) || 0, ready:!!data.ready, loading:false };
  } catch (e) {
    // Offline or no worker: the notify panel just doesn't show.
  } finally {
    _followers.loading = false;
    renderShareNotify();
    if (typeof renderShareListens === 'function') renderShareListens();
  }
}

function songwriterName() {
  var named = appSettings && String(appSettings.artistName || '').trim();
  if (named) return named;
  var full = window.fbOwnerUser && window.fbOwnerUser.displayName;
  return full ? String(full).split(' ')[0] : '';
}

// In the share dialog after sharing a song: tell the followers about it.
var _shareNotifyTrackId = '';
function renderShareNotify(trackId) {
  if (trackId !== undefined) _shareNotifyTrackId = trackId || '';
  var el = document.getElementById('share-notify');
  if (!el) return;
  var track = _shareNotifyTrackId ? getVaultTrack(_shareNotifyTrackId) : null;
  if (!track || !window.fbOwnerUser || !ownerWorker('/notify')) { el.hidden = true; return; }
  if (_followers.count === null) { el.hidden = true; loadFollowerCount(); return; }
  if (!_followers.ready) { el.hidden = true; return; }
  el.hidden = false;
  var n = _followers.count;
  if (track.announcedAt) {
    el.innerHTML = '<span class="share-notify-text">' + icon('bell') + 'Your followers were told about this song ' + esc(storyClipAge(track.announcedAt)) + '.</span>';
  } else if (!n) {
    el.innerHTML = '<span class="share-notify-text">' + icon('bell') + 'No followers yet. People can tap “Get new songs” on any share page.</span>';
  } else {
    el.innerHTML = '<span class="share-notify-text">' + icon('bell') + n + (n === 1 ? ' person follows' : ' people follow') + ' your songs.</span>'
      + '<button type="button" class="sec-action primary" onclick="notifyFollowers(' + jsq(track.id) + ')"' + (_notifying[track.id] ? ' disabled' : '') + '>'
      + (_notifying[track.id] ? 'Telling them…' : 'Tell them about this song') + '</button>';
  }
}

async function notifyFollowers(id) {
  var track = getVaultTrack(id);
  var call = ownerWorker('/notify');
  if (!track || !call || _notifying[id]) return;
  _notifying[id] = true;
  renderShareNotify();
  var name = songwriterName();
  var totals = { sent:0, removed:0, failed:0 };
  try {
    var after = 0;
    for (var round = 0; round < 200; round++) {
      var response = await fetch(call.url, {
        method:'POST',
        headers:call.headers,
        body:JSON.stringify({
          id:id,
          title:track.title || 'A new song',
          body:(name ? 'A new song from ' + name + '.' : 'A new song.') + ' Tap to listen.',
          url:buildShareURL('track', id),
          after:after
        })
      });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok) throw new Error(data.error || ('The worker answered ' + response.status + '.'));
      totals.sent += data.sent || 0;
      totals.removed += data.removed || 0;
      totals.failed += data.failed || 0;
      if (!data.next) break;
      after = data.next;
    }
    track.announcedAt = new Date().toISOString();
    persistTracks();
    _followers.count = Math.max(0, (_followers.count || 0) - totals.removed);
    showToast(totals.sent
      ? 'Told ' + totals.sent + (totals.sent === 1 ? ' follower' : ' followers') + (totals.failed ? ' (' + totals.failed + ' couldn’t be reached)' : '') + '.'
      : totals.removed ? 'Nobody to tell: your followers had turned notices off.' : 'Nobody could be reached just now.');
  } catch (e) {
    showToast('Couldn’t tell your followers: ' + ((e && e.message) || 'try again.'));
  } finally {
    delete _notifying[id];
    renderShareNotify();
  }
}
