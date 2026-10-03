// String, number and markup-escaping helpers every other script leans on.
// Pure: no DOM, no app state, nothing outside js/data. index.html loads the
// data files before any feature, and the tests load them straight into Node.

function lower(v) { return String(v || '').toLowerCase(); }
function jsq(v) { return JSON.stringify(String(v || '')).replace(/"/g, '&quot;'); }
function jsv(v) { return JSON.stringify(v == null ? '' : v).replace(/"/g, '&quot;'); }

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function trimText(s, max) {
  var text = String(s || '').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  var secs = Math.floor(s);
  var m = Math.floor(secs / 60);
  var sec = secs % 60;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function fmtCompactNumber(n) {
  n = Number(n || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function hashString(str) {
  var hash = 0;
  var text = String(str || '');
  for (var i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function uniqueStrings(list, limit) {
  var seen = {};
  var out = [];
  (list || []).forEach(function(item) {
    var value = String(item || '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    var key = lower(value);
    if (seen[key]) return;
    seen[key] = 1;
    out.push(value);
  });
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

// Hours/minutes formatter for long spans (listening time, catalog runtime),
// where fmtTime's m:ss would read awkwardly.
function fmtLongDuration(totalSeconds) {
  var s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return s + 's';
}

function formatFileSize(bytes) {
  var size = Number(bytes || 0);
  if (!size) return '0 MB';
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(size / 1024) + ' KB';
}
