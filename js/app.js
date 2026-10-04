// Firebase: owner sign-in, the private vault sync, and the public share
// documents. The only ES module. Module scripts run after every classic
// script has loaded, and this one talks to them only through window.*
// (fbSave/fbSaveTrack out, svApplyRemoteTracks/refreshAll back in).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, collection, setDoc, getDoc, getDocs, deleteDoc, writeBatch, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyB_6PnXWdtpR-x-jcJIuzOaROoVRplY5SM",
  authDomain: "pokerhq-a67e4.firebaseapp.com",
  projectId: "pokerhq-a67e4",
  storageBucket: "pokerhq-a67e4.firebasestorage.app",
  messagingSenderId: "91226487101",
  appId: "1:91226487101:web:0cf1b3411ff9d17a00ad54"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const USER_PATH = 'sonicvault-bob';
// One document per track. The old single `tracks` document held the whole
// library as one JSON string: ~1,286 bytes per track against a hard 1MiB
// ceiling, rewritten in full on every play.
const TRACKS_PATH = 'sonicvault-bob-tracks';
const PUBLIC_TRACKS_PATH = 'sonicvault-public-tracks';
const PUBLIC_PLAYLISTS_PATH = 'sonicvault-public-playlists';
let _privateSyncStarted = false;

// True until the first sync attempt resolves one way or the other. A fresh
// device has an empty localStorage cache, so without this the library paints
// the "Start your private label" empty state while the vault is still on the
// wire — telling the owner their music is gone.
window.svBootPending = true;
function settleBoot() {
  if (!window.svBootPending) return;
  window.svBootPending = false;
  if (window.refreshAll) window.refreshAll();
}

// A signed-in account the rules refuse is not the vault's owner. The sign-in
// page (js/features/sign-in.js) decides what to tell them.
function reportDenied(err) {
  if (err && err.code === 'permission-denied' && window.fbOwnerUser && window.svAccessDenied) {
    window.svAccessDenied(window.fbOwnerUser.email);
  }
}

function getInitialRouteState() {
  var search = new URLSearchParams(window.location.search);
  var redirected = search.get('sv-route');
  var rawPath = redirected || window.location.pathname || '/';
  var parts = String(rawPath).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  var routeIndex = parts.indexOf('track');
  var kind = 'track';
  if (routeIndex === -1) {
    routeIndex = parts.indexOf('playlist');
    kind = 'playlist';
  }
  if (routeIndex !== -1 && parts[routeIndex + 1]) {
    return { mode:kind, id:decodeURIComponent(parts[routeIndex + 1]) };
  }
  return { mode:'app', id:'' };
}

function getPublicPath(kind) {
  return kind === 'playlist' ? PUBLIC_PLAYLISTS_PATH : PUBLIC_TRACKS_PATH;
}

function setSyncStatus(status, msg) {
  var el = document.getElementById('sync-status');
  if (!el) return;
  var dots = {
    syncing: 'LIVE',
    ok: 'SYNC',
    error: 'ERR',
    offline: 'OFF'
  };
  var key = dots[status] ? status : 'offline';
  el.textContent = dots[key] + ' ' + msg;
  el.classList.remove('sync-syncing', 'sync-ok', 'sync-error', 'sync-offline');
  el.classList.add('sync-' + key);
  el.style.color = '';
}
// updateOnlineStatus() in js/features/sync.js needs this.
window.setSyncStatus = setSyncStatus;

// Reports success so save() can keep the write queued until the server has
// actually taken it. Swallowing the error here used to drop the write.
async function fbSave(key, data) {
  try {
    setSyncStatus('syncing', 'Saving');
    await setDoc(doc(db, USER_PATH, key), { value: JSON.stringify(data), updated: Date.now() });
    setSyncStatus('ok', 'Synced');
    return true;
  } catch (e) {
    setSyncStatus('error', 'Save failed');
    console.error('fbSave error:', e);
    return false;
  }
}

// Firestore rejects undefined field values outright, and audioData is legacy
// base64 that must never leave the device.
function cleanTrackForWrite(track) {
  var out = {};
  Object.keys(track || {}).forEach(function(key) {
    if (key === 'audioData') return;
    if (track[key] === undefined) return;
    out[key] = track[key];
  });
  return out;
}

async function fbSaveTrack(track) {
  if (!track || !track.id) return true;
  try {
    setSyncStatus('syncing', 'Saving');
    await setDoc(doc(db, TRACKS_PATH, String(track.id)), cleanTrackForWrite(track));
    setSyncStatus('ok', 'Synced');
    return true;
  } catch (e) {
    setSyncStatus('error', 'Save failed');
    console.error('fbSaveTrack error:', e);
    return false;
  }
}

async function fbDeleteTrack(id) {
  try {
    setSyncStatus('syncing', 'Saving');
    await deleteDoc(doc(db, TRACKS_PATH, String(id)));
    setSyncStatus('ok', 'Synced');
    return true;
  } catch (e) {
    setSyncStatus('error', 'Save failed');
    console.error('fbDeleteTrack error:', e);
    return false;
  }
}

async function fbReadTracks() {
  var snap = await getDocs(collection(db, TRACKS_PATH));
  var list = [];
  snap.forEach(function(d) { list.push(d.data()); });
  return list;
}

// One-time lift from the legacy single document. Non-destructive: the old
// document is left exactly where it is, so it stays a free rollback copy.
async function migrateTracksToCollection() {
  var existing = await getDocs(collection(db, TRACKS_PATH));
  if (!existing.empty) return 0;
  var legacy = await getDoc(doc(db, USER_PATH, 'tracks'));
  if (!legacy.exists()) return 0;
  var arr = [];
  try { arr = JSON.parse(legacy.data().value); } catch (e) { arr = []; }
  if (!Array.isArray(arr) || !arr.length) return 0;
  setSyncStatus('syncing', 'Upgrading vault');
  // Batches cap at 500 operations.
  for (var i = 0; i < arr.length; i += 400) {
    var batch = writeBatch(db);
    arr.slice(i, i + 400).forEach(function(track) {
      if (track && track.id) batch.set(doc(db, TRACKS_PATH, String(track.id)), cleanTrackForWrite(track));
    });
    await batch.commit();
  }
  console.info('Migrated ' + arr.length + ' tracks to per-track documents');
  return arr.length;
}

async function fbPublishShare(kind, id, data) {
  try {
    setSyncStatus('syncing', 'Publishing');
    await setDoc(doc(db, getPublicPath(kind), id), Object.assign({
      id: id,
      kind: kind,
      updated: Date.now(),
      shared: true
    }, data || {}));
    setSyncStatus('ok', 'Shared');
    return true;
  } catch (e) {
    setSyncStatus('error', 'Share failed');
    console.error('fbPublishShare error:', e);
    throw e;
  }
}

// Revoking a share has to delete the public document, not just flip the
// private `shared` flag: the public doc is world-readable and carries the
// prompt, a lyrics excerpt, and the Cloudinary URL. Leaving it behind means
// the link keeps working after the owner thinks they took it down.
async function fbUnpublishShare(kind, id) {
  try {
    setSyncStatus('syncing', 'Revoking');
    await deleteDoc(doc(db, getPublicPath(kind), id));
    setSyncStatus('ok', 'Share revoked');
    return true;
  } catch (e) {
    setSyncStatus('error', 'Revoke failed');
    console.error('fbUnpublishShare error:', e);
    throw e;
  }
}

async function fbLoadPublicRoute(kind, id) {
  var snap = await getDoc(doc(db, getPublicPath(kind), id));
  return snap.exists() ? snap.data() : null;
}

async function fbLoadAll() {
  try {
    setSyncStatus('syncing', 'Syncing');
    var keys = ['playlists', 'settings'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (window.svHasPendingWrite && window.svHasPendingWrite(k)) continue;
      var snap = await getDoc(doc(db, USER_PATH, k));
      if (!snap.exists()) continue;
      var val = JSON.parse(snap.data().value);
      if (k === 'playlists') window.playlists = Array.isArray(val) ? val : [];
      if (k === 'settings') window.appSettings = val || {};
      localStorage.setItem('sv_' + k, JSON.stringify(val));
    }
    var tracksResult = await loadTracksFromServer();
    if (window.svApplyRemoteTracks) window.svApplyRemoteTracks(tracksResult.list);
    if (tracksResult.source === 'legacy') {
      // Playlists and settings are syncing; only the per-track collection is
      // unreachable. Say which, rather than collapsing it into "Local only".
      setSyncStatus('error', 'Track sync blocked');
    } else {
      setSyncStatus('ok', 'Synced');
    }
    settleBoot();
    if (window.refreshAll) window.refreshAll();
  } catch (e) {
    setSyncStatus('error', e && e.code === 'permission-denied' ? 'Permission denied' : 'Local only');
    console.error('fbLoadAll error:', e && e.code, e);
    settleBoot();
    reportDenied(e);
  }
}

// Prefer per-track documents, but fall back to the legacy single document if
// the collection cannot be read. The migration deliberately left that document
// in place; without this, a rules problem on the new collection means the
// vault reads as empty on any device whose local cache is cold.
async function loadTracksFromServer() {
  try {
    await migrateTracksToCollection();
    var list = await fbReadTracks();
    subscribeTracks();
    return { list: list, source: 'collection' };
  } catch (e) {
    console.error('Per-track collection unavailable (' + (e && e.code) + '); '
      + 'falling back to the legacy tracks document. Check that the '
      + 'sonicvault-bob-tracks rules are deployed.', e);
    var snap = await getDoc(doc(db, USER_PATH, 'tracks'));
    if (!snap.exists()) throw e;
    var val = JSON.parse(snap.data().value);
    return { list: Array.isArray(val) ? val : [], source: 'legacy' };
  }
}

let _privateUnsubs = [];

function stopPrivateSync() {
  _privateUnsubs.forEach(function(unsub) { try { unsub(); } catch (e) {} });
  _privateUnsubs = [];
  _privateSyncStarted = false;
}

function startPrivateSync() {
  // Always rebuild the listeners: a permission-denied error (signed out)
  // kills an onSnapshot subscription permanently, so re-entry after
  // sign-in must subscribe fresh rather than assume the old ones live.
  stopPrivateSync();
  _privateSyncStarted = true;
  // The tracks collection is subscribed from fbLoadAll(), after the one-time
  // migration has run -- subscribing first would deliver an empty snapshot
  // while the legacy document still held the whole library.
  ['playlists', 'settings'].forEach(function(k) {
    var unsub = onSnapshot(doc(db, USER_PATH, k), function(snap) {
      if (!snap.exists()) return;
      // A local write for this key is still unconfirmed. Applying the server
      // copy here would wipe it from the UI while it sat in the retry queue.
      if (window.svHasPendingWrite && window.svHasPendingWrite(k)) return;
      var val = JSON.parse(snap.data().value);
      if (k === 'playlists') window.playlists = Array.isArray(val) ? val : [];
      if (k === 'settings') window.appSettings = val || {};
      localStorage.setItem('sv_' + k, JSON.stringify(val));
      setSyncStatus('ok', 'Synced');
      if (window.refreshAll) window.refreshAll();
    }, function(err) {
      var who = window.fbOwnerUser && window.fbOwnerUser.email;
      setSyncStatus('error', who ? 'Blocked: ' + who : 'Sign in required');
      console.error('onSnapshot error:', err);
      reportDenied(err);
    });
    _privateUnsubs.push(unsub);
  });
  fbLoadAll();
}

// Subscribed only after the migration has run, and only once per sync
// session -- fbLoadAll() can be called again on re-auth.
let _tracksUnsub = null;

function subscribeTracks() {
  if (_tracksUnsub) return;
  _tracksUnsub = onSnapshot(collection(db, TRACKS_PATH), function(snap) {
    var list = [];
    snap.forEach(function(d) { list.push(d.data()); });
    if (window.svApplyRemoteTracks) window.svApplyRemoteTracks(list);
    setSyncStatus('ok', 'Synced');
    if (window.refreshAll) window.refreshAll();
  }, function(err) {
    var who = window.fbOwnerUser && window.fbOwnerUser.email;
    setSyncStatus('error', who ? 'Blocked: ' + who : 'Sign in required');
    console.error('tracks onSnapshot error:', err);
    reportDenied(err);
  });
  _privateUnsubs.push(function() { _tracksUnsub = null; });
  _privateUnsubs.push(_tracksUnsub);
}

// A popup first; where popups are blocked or unsupported (home-screen apps,
// some in-app browsers) the whole page goes to Google and back instead, and
// getRedirectResult below picks the session up. A popup the person closed
// is their answer, not a reason to redirect.
const REDIRECT_FALLBACK_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'];

async function fbSignIn() {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err && REDIRECT_FALLBACK_CODES.indexOf(err.code) !== -1) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw err;
  }
}

async function fbSignOutOwner() {
  await signOut(auth);
}

window.fbSave = fbSave;
window.fbSaveTrack = fbSaveTrack;
window.fbDeleteTrack = fbDeleteTrack;
window.fbLoadAll = fbLoadAll;
window.fbPublishShare = fbPublishShare;
window.fbUnpublishShare = fbUnpublishShare;
window.fbLoadPublicRoute = fbLoadPublicRoute;
window.fbStartPrivateSync = startPrivateSync;
window.fbSignIn = fbSignIn;
window.fbSignOutOwner = fbSignOutOwner;

onAuthStateChanged(auth, function(user) {
  // Email-less sessions (e.g. anonymous auth left behind by PokerHQ or
  // Daily Briefer on this shared origin) can never pass the owner rules.
  // Treat them as signed out so the Owner button offers sign-in instead
  // of silently signing the phantom session out.
  var ownerCandidate = !!(user && user.email);
  window.fbOwnerUser = ownerCandidate ? { email:user.email, uid:user.uid || '' } : null;
  if (ownerCandidate) {
    startPrivateSync();
    if (window.svFlushQueue) window.svFlushQueue();
  } else {
    if (_privateSyncStarted) stopPrivateSync();
    setSyncStatus('offline', user ? 'Sign in required' : 'Local only');
    settleBoot();
  }
  if (window.svSignInGate) window.svSignInGate(ownerCandidate ? 'owner' : 'signed-out');
  if (window.refreshAll) window.refreshAll();
});

// The answer to a redirect sign-in arrives through onAuthStateChanged; only
// a failure needs saying.
getRedirectResult(auth).catch(function(err) {
  if (window.svSignInError) window.svSignInError(err);
});

var initialRoute = getInitialRouteState();
if (initialRoute.mode === 'app') {
  // Private sync starts from onAuthStateChanged once the restored session
  // is known — subscribing before the token is ready just gets a
  // permission-denied that kills the listeners.
  setSyncStatus('syncing', 'Connecting');
} else {
  setSyncStatus('syncing', 'Loading share');
  fbLoadPublicRoute(initialRoute.mode, initialRoute.id).then(function(payload) {
    window._publicShareData = payload;
    setSyncStatus(payload ? 'ok' : 'error', payload ? 'Shared' : 'Missing');
    if (window.refreshAll) window.refreshAll();
  }).catch(function(err) {
    window._publicShareData = null;
    setSyncStatus('error', 'Share failed');
    console.error('fbLoadPublicRoute error:', err);
    if (window.refreshAll) window.refreshAll();
  });
}
