// Runs before first paint (render-blocking on purpose, ~200 bytes) so the
// saved theme applies without a flash. The server copy of the preference is
// synced after sign-in.
(function () {
  try {
    var t = localStorage.getItem('2way-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: keep dark default */ }
})();
