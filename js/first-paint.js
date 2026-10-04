// First paint. Loaded straight after the sign-in page's markup, before the
// rest of <body> is parsed, so what shows first is decided before anything
// paints: the saved theme (not when shell.js loads, so nothing flashes dark
// first), and whether the sign-in page covers the app -- not on a share
// link, and not for whoever was signed in last time on this device, whose
// vault opens straight from its cache, even offline. js/features/sign-in.js
// takes over from here once Firebase answers.
(function() {
  try {
    if (localStorage.getItem('sv_theme') === 'light') document.body.classList.add('light');
  } catch (e) {}
  var route = new URLSearchParams(location.search).get('sv-route') || location.pathname;
  var share = /(^|\/)(track|playlist)\/[^\/]+/.test(route);
  var owner = false;
  try { owner = localStorage.getItem('sv_owner_hint') === '1'; } catch (e) {}
  if (!share && !owner) {
    document.getElementById('login-overlay').hidden = false;
    document.documentElement.classList.add('sv-locked');
  }
})();
