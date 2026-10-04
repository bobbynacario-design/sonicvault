// Which page is showing: the private app views, or a public /track/:id or
// /playlist/:id share page, and the history entries that move between them.

var _activeView = 'library';
var _routeState = { mode:'app', id:'', prefix:'', path:'/' };
var _publicRoutePayload = null;
var _publicRouteLoading = false;
// 'mode:id' of the last share route whose lookup came back empty or failed.
// A finished lookup re-renders, and rendering is what starts a lookup, so
// without this a missing share was fetched again on every render that the
// previous fetch caused -- an endless run of Firestore reads, with the page
// stuck on its loading skeleton instead of saying "not found".
var _publicRouteMissed = '';

function getPublicPlaylistList() {
  if (!_publicRoutePayload) return [];
  if (_publicRoutePayload.kind === 'track' && Array.isArray(_publicRoutePayload.playlists)) return _publicRoutePayload.playlists;
  if (_publicRoutePayload.kind === 'playlist') return [_publicRoutePayload];
  return [];
}

function getPublicTrackPool() {
  if (!_publicRoutePayload) return [];
  var pool = [];
  var seen = {};
  function add(track) {
    if (!track || !track.id || seen[track.id]) return;
    seen[track.id] = 1;
    pool.push(track);
  }
  if (_publicRoutePayload.kind === 'track') add(_publicRoutePayload);
  (_publicRoutePayload.related || []).forEach(add);
  getPublicPlaylistList().forEach(function(pl) {
    (pl.tracks || []).forEach(add);
  });
  if (_publicRoutePayload.kind === 'playlist') {
    (_publicRoutePayload.tracks || []).forEach(add);
  }
  return pool;
}

function applyRedirectedShareRoute() {
  var params = new URLSearchParams(window.location.search);
  var redirected = params.get('sv-route');
  if (!redirected) return;
  var base = getRoutePrefixFromPath(window.location.pathname);
  var target = (base || '') + normalizeRoutePath(redirected);
  history.replaceState({}, '', target + (window.location.hash || ''));
}

function parseRouteState(path) {
  var normalized = normalizeRoutePath(path || window.location.pathname);
  var parts = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  var routeIndex = parts.indexOf('track');
  var mode = 'track';
  if (routeIndex === -1) {
    routeIndex = parts.indexOf('playlist');
    mode = 'playlist';
  }
  if (routeIndex !== -1 && parts[routeIndex + 1]) {
    return {
      mode: mode,
      id: decodeURIComponent(parts[routeIndex + 1]),
      prefix: routeIndex ? '/' + parts.slice(0, routeIndex).join('/') : '',
      path: '/' + parts.slice(routeIndex).join('/')
    };
  }
  return {
    mode: 'app',
    id: '',
    prefix: parts.length ? '/' + parts.join('/') : '',
    path: '/'
  };
}

function getAppBasePath() {
  if (_routeState && typeof _routeState.prefix === 'string') return _routeState.prefix;
  return getRoutePrefixFromPath(window.location.pathname);
}

// Share links go through the AI worker's public /s/ routes
// (cloudflare-worker/share.js). Link-preview bots -- Facebook, WhatsApp,
// X -- get the title, cover and description there; people are sent straight
// on to the app. The app's own /track/:id URLs only exist as a 404 that
// redirects in script, which no preview bot runs. Local dev keeps local
// links. Links sent before this still work, just without a preview.
var SHARE_PREVIEW_ORIGIN = 'https://sonicvault-ai.bobbynacario.workers.dev';

function buildShareURL(kind, id) {
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  if (SHARE_PREVIEW_ORIGIN && !local) return SHARE_PREVIEW_ORIGIN + '/s/' + kind + '/' + encodeURIComponent(id);
  return window.location.origin + (getAppBasePath() || '') + '/' + kind + '/' + encodeURIComponent(id);
}

// Only pages whose state changes are touched, so re-asserting the current
// page after a sync does not replay its entrance animation.
function setActivePage(pageId) {
  document.querySelectorAll('.page').forEach(function(page) {
    page.classList.toggle('active', page.id === pageId);
  });
}

// Above the app-shell breakpoint, #app-main is its own scroll container and
// window.scrollTo no longer touches the visible content. Below it, the
// document itself scrolls and #app-main is inert. Scrolling both costs
// nothing -- whichever one isn't the active container is just a no-op.
function scrollContentToTop(smooth) {
  var behavior = smooth ? 'smooth' : 'auto';
  var main = document.getElementById('app-main');
  if (main) main.scrollTo({ top:0, behavior:behavior });
  window.scrollTo({ top:0, behavior:behavior });
}

function syncNavState(view, isPublic) {
  document.body.classList.toggle('public-route', !!isPublic);
  document.querySelectorAll('.group-tab').forEach(function(tab) { tab.classList.remove('active'); });
  document.querySelectorAll('.mobile-tab').forEach(function(tab) { tab.classList.remove('active'); });
  if (isPublic) return;
  var navTab = document.getElementById('gtab-' + view);
  if (navTab) navTab.classList.add('active');
  var mobileTab = document.getElementById('mob-' + view);
  if (mobileTab) mobileTab.classList.add('active');
}

function updatePageChrome(title, tintTrack) {
  document.title = title || 'SonicVault - Private AI Music Vault';
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', tintTrack ? getCoverPalette(tintTrack).a : '#090b12');
  }
  if (tintTrack) applyTrackTint(tintTrack);
}

function switchView(view) {
  var skipRoute = arguments[1];
  _activeView = view;
  if (!skipRoute && _routeState.mode !== 'app') {
    navigateToApp(view);
    return;
  }
  setActivePage('page-' + view);
  syncNavState(view, false);
  if (view === 'library') renderTracks();
  if (view === 'playlists') renderPlaylists();
  if (view === 'upload') renderPendingPreview();
  if (view === 'insights') renderInsights();
  updatePageChrome(null, _currentTrack || null);
  if (!skipRoute) scrollContentToTop(true);
}

function navigateToApp(view, replace) {
  _activeView = view || 'library';
  var method = replace ? 'replaceState' : 'pushState';
  history[method]({}, '', (getAppBasePath() || '') + '/');
  _routeState = parseRouteState(window.location.pathname);
  _publicRoutePayload = null;
  window._publicShareData = null;
  if (window.fbStartPrivateSync) window.fbStartPrivateSync();
  renderRouteAwareView(true);
}

function openSharedRoute(kind, id, replace) {
  if (!id) return;
  var method = replace ? 'replaceState' : 'pushState';
  history[method]({}, '', (getAppBasePath() || '') + '/' + kind + '/' + encodeURIComponent(id));
  _routeState = parseRouteState(window.location.pathname);
  _publicRoutePayload = null;
  window._publicShareData = null;
  // Following a link is a fresh question, even for a share that was missing.
  _publicRouteMissed = '';
  renderRouteAwareView();
}

function ensurePublicRouteData() {
  if (_routeState.mode === 'app') return;
  if (window._publicShareData && (!_publicRoutePayload || window._publicShareData.id === _routeState.id)) {
    _publicRoutePayload = window._publicShareData;
  }
  if (_publicRoutePayload && _publicRoutePayload.id === _routeState.id && _publicRoutePayload.kind === _routeState.mode) return;
  var routeKey = _routeState.mode + ':' + _routeState.id;
  if (_publicRouteLoading || _publicRouteMissed === routeKey || !window.fbLoadPublicRoute) return;
  _publicRouteLoading = true;
  window.fbLoadPublicRoute(_routeState.mode, _routeState.id).then(function(payload) {
    _publicRouteLoading = false;
    _publicRoutePayload = payload;
    window._publicShareData = payload;
    if (!payload) _publicRouteMissed = routeKey;
    renderRouteAwareView(true);
  }).catch(function(err) {
    _publicRouteLoading = false;
    _publicRoutePayload = null;
    window._publicShareData = null;
    _publicRouteMissed = routeKey;
    console.error('Public route load failed:', err);
    renderRouteAwareView(true);
  });
}

function renderRouteAwareView(skipScroll) {
  var publicPage = document.getElementById('public-page');
  _routeState = parseRouteState(window.location.pathname);
  if (_routeState.mode === 'track') {
    ensurePublicRouteData();
    syncNavState(_activeView, true);
    setActivePage('page-public');
    renderPublicTrackPage((_publicRoutePayload && _publicRoutePayload.kind === 'track' && _publicRoutePayload.id === _routeState.id) ? _publicRoutePayload : getTrackById(_routeState.id));
  } else if (_routeState.mode === 'playlist') {
    ensurePublicRouteData();
    syncNavState(_activeView, true);
    setActivePage('page-public');
    renderPublicPlaylistPage((_publicRoutePayload && _publicRoutePayload.kind === 'playlist' && _publicRoutePayload.id === _routeState.id) ? _publicRoutePayload : getPlaylistById(_routeState.id));
  } else {
    if (publicPage) publicPage.innerHTML = '';
    _publicRoutePayload = null;
    window._publicShareData = null;
    switchView(_activeView || 'library', true);
    updatePageChrome(null, _currentTrack || null);
  }
  if (!skipScroll) scrollContentToTop(true);
}
