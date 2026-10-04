/* takes:theme */
/*
 * theme.js: the light and dark switch.
 * The page starts in the look last chosen on this computer; with no choice yet it follows the
 * computer's own light or dark setting. The choice is kept in localStorage under "tk-theme", and a
 * browser that refuses storage simply forgets it at the end of the visit.
 * The colors themselves live in src/theme.css, keyed on the data-theme attribute of <html>.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var KEY = 'tk-theme';

  /** Which look to start in: a saved choice wins, else the computer's setting. Pure. */
  function pickTheme(saved, prefersLight) {
    if (saved === 'light' || saved === 'dark') return saved;
    return prefersLight ? 'light' : 'dark';
  }

  function otherTheme(theme) {
    return theme === 'light' ? 'dark' : 'light';
  }

  /** What the button does next, in words, for screen readers and the hover tip. Pure. */
  function labelFor(theme) {
    return theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }

  function readSaved() {
    try { return root.localStorage.getItem(KEY); } catch (err) { return null; }
  }

  function save(theme) {
    try { root.localStorage.setItem(KEY, theme); } catch (err) { /* storage refused: the choice lasts for this visit */ }
  }

  function apply(doc, button, theme) {
    doc.documentElement.setAttribute('data-theme', theme);
    if (button) {
      button.setAttribute('aria-label', labelFor(theme));
      button.setAttribute('title', labelFor(theme));
    }
  }

  function init(doc) {
    var button = doc.getElementById('tk-theme-btn');
    var prefersLight = false;
    try { prefersLight = !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches); } catch (err) { prefersLight = false; }
    apply(doc, button, pickTheme(readSaved(), prefersLight));
    if (!button) return;
    button.addEventListener('click', function () {
      var next = otherTheme(doc.documentElement.getAttribute('data-theme'));
      apply(doc, button, next);
      save(next);
    });
  }

  var api = { KEY: KEY, pickTheme: pickTheme, otherTheme: otherTheme, labelFor: labelFor, init: init };

  if (Takes) Takes.theme = api;

  // The script sits at the end of the body, so the button is already in the page.
  if (root.document && root.document.documentElement) init(root.document);

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
