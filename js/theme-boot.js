// Runs in <head> before the page paints, so the saved theme shows with no flash.
// panel.js keeps this cache in sync with the real setting in chrome.storage.
(function () {
  var mode = "system", palette = "lagoon";
  try {
    var saved = JSON.parse(localStorage.getItem("quizzer:appearance") || "{}");
    if (saved.mode) mode = saved.mode;
    if (saved.palette) palette = saved.palette;
  } catch (e) {}
  var dark = mode === "dark" || (mode === "system" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.setAttribute("data-palette", palette);
  root.setAttribute("data-mode", dark ? "dark" : "light");
})();
