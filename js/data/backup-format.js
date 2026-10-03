// What a vault export is: the backup file's format and validation, and the
// M3U playlist text for players outside the app.
// Pure: no DOM, no app state, nothing outside js/data.

// ── Vault backup ───────────────────────────────────────────────────────
// The whole vault is one Firestore document with a hard 1MiB ceiling, and a
// write that fails leaves local and remote diverged. Until per-track
// documents land, an exported copy is the only thing that survives a bad
// write, so export/restore is deliberately plain: one JSON file, no service.
var BACKUP_FORMAT = 1;

function backupStamp() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function safeFileName(name) {
  var clean = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'sonicvault';
}

// Only http(s) sources go into a playlist file. Legacy base64 tracks would
// produce a multi-megabyte line that no player will open.
function getExportableTracks(list) {
  return list.filter(function(track) { return /^https?:/i.test(String(track.audioURL || '')); });
}

function buildM3U(list, name) {
  var lines = ['#EXTM3U'];
  if (name) lines.push('#PLAYLIST:' + String(name).replace(/[\r\n]+/g, ' '));
  list.forEach(function(track) {
    var seconds = Math.round(Number(track.duration) || 0) || -1;
    var title = String(track.title || 'Untitled').replace(/[\r\n]+/g, ' ');
    lines.push('#EXTINF:' + seconds + ',' + title);
    lines.push(track.audioURL);
  });
  return lines.join('\n') + '\n';
}

function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'That file is not a SonicVault backup';
  if (data.app && data.app !== 'sonicvault') return 'That backup came from a different app';
  if (!Array.isArray(data.tracks) || !Array.isArray(data.playlists)) return 'That backup is missing its tracks or playlists';
  if (Number(data.format) > BACKUP_FORMAT) return 'That backup was written by a newer version of SonicVault';
  return '';
}
