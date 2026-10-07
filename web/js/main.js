"use strict";
// ---------- routing + boot ----------
let homeScroll = 0, routed = false;
/** Moves keyboard/screen-reader focus to the page heading after a view change, without scrolling. */
function focusMain() {
  const main = $("detail").hidden ? $("home") : $("detail");
  const h = main.querySelector("h1");
  (h || main).focus({ preventScroll: true });
}
async function route() {
  const m = location.hash.match(/^#\/task\/(.+)$/);
  if (m && !$("home").hidden) homeScroll = window.scrollY; // remember where the home page was before leaving it
  $("home").hidden = !!m;
  $("detail").hidden = !m;
  if (m) { window.scrollTo(0, 0); await renderDetail(decodeURIComponent(m[1])); }
  else { await renderHome(); window.scrollTo(0, routed ? homeScroll : 0); } // the timeline is loaded now: the page is tall enough to restore
  if (routed) focusMain(); // not on first load: let the page be read from the top
  routed = true;
}

(function theme() {
  let t = null;
  try { t = localStorage.getItem("wc-theme"); } catch (e) {}
  if (t) document.documentElement.dataset.theme = t;
  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("wc-theme", next); } catch (e) {}
  });
})();

(async function boot() {
  try {
    INFO = await api("/api/info");
    await loadLang();
    applyStatic();
    $("loading").textContent = S.loading;
    TASKS = (await api("/api/tasks")).tasks;
    $("loading").hidden = true;
    bindViewControls();
    $("q").addEventListener("input", onSearchInput);
    $("ai-search").addEventListener("click", startAiSearch);
    $("none-ai").addEventListener("click", startAiSearch); // only asks for an estimate and a confirmation: nothing is spent yet
    $("fq").addEventListener("input", () => { clearTimeout(filesTimer); filesTimer = setTimeout(loadFiles, 150); });
    $("filesearch").addEventListener("toggle", () => { if ($("filesearch").open) loadFiles(); });
    refreshUsage();
    window.addEventListener("hashchange", route);
    $("skip").addEventListener("click", (e) => { e.preventDefault(); focusMain(); });
    route();
  } catch (e) { $("loading").textContent = e.message; }
})();
