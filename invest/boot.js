/* Тема й режим «сховати суми» ставляться до першого малювання сторінки, щоб не блимало. */
(function () {
  var root = document.documentElement;
  var pref = null;
  try { pref = localStorage.getItem('portfel.theme'); } catch (e) { /* приватний режим */ }
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = pref === 'light' || pref === 'dark' ? pref : (dark ? 'dark' : 'light');
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-pref', pref === 'light' || pref === 'dark' ? pref : 'auto');
  try { if (localStorage.getItem('portfel.privacy') === '1') root.classList.add('privacy'); } catch (e) { /* без збереження */ }
})();
