// Boot. Loads last: it calls into every feature, so each of them has to be
// defined before this runs. Installs the refresh hook js/app.js calls after
// each sync, restores the route, paints the first frame, and registers the
// service worker.

window.refreshAll = function() {
  tracks = window.tracks;
  playlists = window.playlists;
  appSettings = window.appSettings || {};
  syncAIConfigWithVault();
  _publicRoutePayload = window._publicShareData || _publicRoutePayload;
  renderTracks();
  renderPlaylists();
  renderPendingPreview();
  updateNowPlaying();
  updateAuthButton();
  updateAIConfigStatus();
  scheduleAutoDescribe();
  scheduleOfflineTopUp();
  scheduleMeaningIndex();
  scheduleShareRefresh();
  renderSyncBanner();
  renderBackupPanel();
  renderRouteAwareView(true);
  scheduleArtSweep(2000);
};

pinHeadLinks();
applyRedirectedShareRoute();
_routeState = parseRouteState(window.location.pathname);
window.addEventListener('popstate', function() {
  renderRouteAwareView(true);
});

renderTracks();
renderPlaylists();
renderPendingPreview();
updateNowPlaying();
updateAIConfigStatus();
renderBackupPanel();
renderRouteAwareView(true);
observeChromeHeights();
// A queue restored from localStorage means the last session ended with
// writes the server never took. Surface it, and retry once sync is up.
renderSyncBanner();
scheduleRetry();

// Cached cover art paints over the generated covers as soon as it is read
// back; tracks not yet checked are probed once things have settled.
loadCachedArt();
scheduleArtSweep(5000);

// Backfill real waveforms for any tracks still missing decoded peaks,
// after initial render and first sync have had a moment to settle.
setTimeout(sweepWaveformBackfill, 4000);

// Service worker: offline shell + cached fonts/SDK + recently played audio.
// Guarded so opening index.html via file:// (local dev) stays error-free.
// Registered by the app's base path, not relative to the address bar: by
// 'load' a share link already reads /sonicvault/track/:id, and a relative
// 'sw.js' would 404 under /track/. At the app root this is the same script
// URL and scope as before, so existing registrations carry on.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', function() {
    var swBase = (getAppBasePath() || '').replace(/\/index\.html$/, '');
    navigator.serviceWorker.register(swBase + '/sw.js', { scope: swBase + '/' }).then(function(reg) {
      reg.addEventListener('updatefound', function() {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function() {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('SonicVault updated - reload for the latest version');
          }
        });
      });
    }).catch(function(e) {
      console.warn('Service worker registration failed:', e);
    });
  });
}
