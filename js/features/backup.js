// Vault export and restore, and the M3U export buttons on the Import page.

function buildVaultBackup() {
  return {
    app: 'sonicvault',
    format: BACKUP_FORMAT,
    exported: new Date().toISOString(),
    counts: { tracks: tracks.length, playlists: playlists.length },
    tracks: tracks,
    playlists: playlists,
    settings: appSettings || {}
  };
}

function downloadBlob(filename, mime, text) {
  var blob = new Blob([text], { type: mime });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke late: revoking synchronously can cancel the download in Safari.
  setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
}

function exportVault() {
  if (!tracks.length && !playlists.length) { showToast('Nothing in the vault to export yet'); return; }
  var text = JSON.stringify(buildVaultBackup(), null, 2);
  downloadBlob('sonicvault-' + backupStamp() + '.json', 'application/json', text);
  showToast('Exported ' + tracks.length + ' tracks (' + formatFileSize(text.length) + ')');
}

function exportPlaylistM3U(id) {
  var pl = getPlaylistById(id);
  if (!pl) return;
  var items = getExportableTracks(getPlaylistTracks(pl));
  if (!items.length) { showToast('No streamable tracks in "' + pl.name + '" yet'); return; }
  downloadBlob(safeFileName(pl.name) + '.m3u8', 'audio/x-mpegurl', buildM3U(items, pl.name));
  showToast('Exported ' + items.length + ' tracks as M3U');
}

function exportVaultM3U() {
  var items = getExportableTracks(tracks.slice());
  if (!items.length) { showToast('No streamable tracks to export yet'); return; }
  downloadBlob('sonicvault-' + backupStamp() + '.m3u8', 'audio/x-mpegurl', buildM3U(items, 'SonicVault'));
  showToast('Exported ' + items.length + ' tracks as M3U');
}

function applyBackup(data) {
  window.tracks = data.tracks;
  window.playlists = data.playlists;
  window.appSettings = (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings))
    ? data.settings : {};
  tracks = window.tracks;
  playlists = window.playlists;
  appSettings = window.appSettings;
  invalidateFilterCache();
  persistTracks();
  save('playlists', playlists);
  save('settings', appSettings);
  window.refreshAll();
  showToast('Restored ' + tracks.length + ' tracks from the backup');
}

function restoreVault(files) {
  var file = files && files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onerror = function() { showToast('Could not read that file'); };
  reader.onload = function() {
    var data = null;
    try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
    var problem = validateBackup(data);
    if (problem) { showToast(problem); return; }
    var when = data.exported ? String(data.exported).slice(0, 16).replace('T', ' ') : 'unknown date';
    var ok = confirm(
      'Restore this backup?\n\n'
      + 'Backup: ' + data.tracks.length + ' tracks, ' + data.playlists.length + ' playlists (' + when + ')\n'
      + 'This vault: ' + tracks.length + ' tracks, ' + playlists.length + ' playlists\n\n'
      + 'The backup replaces everything here, on every signed-in device.'
    );
    if (ok) applyBackup(data);
  };
  reader.readAsText(file);
}

function renderBackupPanel() {
  var summary = document.getElementById('backup-summary');
  if (summary) {
    summary.textContent = (tracks.length || playlists.length)
      ? tracks.length + (tracks.length === 1 ? ' track' : ' tracks') + ' and '
        + playlists.length + (playlists.length === 1 ? ' playlist' : ' playlists') + ' ready to export.'
      : 'Nothing in the vault to export yet.';
  }
  var row = document.getElementById('backup-m3u-row');
  if (!row) return;
  var buttons = [];
  if (getExportableTracks(tracks).length) {
    buttons.push('<button class="filter-chip" onclick="exportVaultM3U()">Whole vault</button>');
  }
  playlists.forEach(function(pl) {
    buttons.push('<button class="filter-chip" onclick="exportPlaylistM3U(' + jsq(pl.id) + ')">' + esc(pl.name) + '</button>');
  });
  row.innerHTML = buttons.length
    ? buttons.join('')
    : '<span class="section-sub">Nothing streamable to export yet.</span>';
}
