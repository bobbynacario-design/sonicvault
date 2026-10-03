// Share-link paths. The app is served under a prefix on GitHub Pages
// (/sonicvault/track/:id), so routes are parsed relative to it.
// Pure: no DOM, no app state, nothing outside js/data.

function normalizeRoutePath(path) {
  var clean = String(path || '/').split('?')[0].split('#')[0].replace(/\/+/g, '/');
  if (!clean.startsWith('/')) clean = '/' + clean;
  if (clean.length > 1) clean = clean.replace(/\/+$/, '');
  return clean || '/';
}

function getRoutePrefixFromPath(path) {
  var parts = normalizeRoutePath(path).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  var routeIndex = parts.indexOf('track');
  if (routeIndex === -1) routeIndex = parts.indexOf('playlist');
  if (routeIndex !== -1) return routeIndex ? '/' + parts.slice(0, routeIndex).join('/') : '';
  return parts.length ? '/' + parts.join('/') : '';
}
