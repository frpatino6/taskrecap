"use strict";
let S = {};            // UI strings (served by /api/strings: translate by adding web/strings.<lang>.json)
let INFO = {};
let TASKS = [];

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// html`...` escapes every interpolated value; raw(str) marks already-safe markup, arrays are joined, null/false render as "".
// The result is a Raw object: assign it to innerHTML (or interpolate it into another html`...`) and it is used as is.
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s == null ? "" : s));
const htmlPart = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(htmlPart).join("") : v == null || v === false ? "" : esc(v));
const html = (strs, ...vals) => raw(strs.reduce((out, s, i) => out + s + (i < vals.length ? htmlPart(vals[i]) : ""), ""));
const fmt = (s, vars) => String(s || "").replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : ""));
const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const usd = (n) => { const v = Number(n || 0); return "$" + (v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2)); };
const fmtTokens = (n) => { const v = Number(n || 0); return v >= 1000 ? (v / 1000).toFixed(1) + "K" : String(v); };
const cap1 = (t) => String(t || "").charAt(0).toUpperCase() + String(t || "").slice(1);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(body.error || r.statusText); err.code = body.code; throw err; }
  return body;
}

// ---------- UI language: remembered choice, else the browser's, else the server's ----------
/** `langs` is [{code, name}] from /api/langs. A saved code is used only if it is still offered. */
function pickLang(langs, saved, browser, fallback) {
  const has = (c) => langs.some((l) => l.code === c);
  if (saved && has(saved)) return saved;
  const b = String(browser || "").slice(0, 2).toLowerCase();
  return has(b) ? b : fallback;
}
let LANG = "en";
async function loadLang() {
  let saved = null;
  try { saved = localStorage.getItem("tr-lang"); } catch (e) { /* storage blocked: browser language */ }
  const langs = (await api("/api/langs")).langs;
  LANG = pickLang(langs, saved, navigator.language, INFO.lang);
  document.documentElement.lang = LANG;
  S = await api("/api/strings?lang=" + encodeURIComponent(LANG));
  const sel = $("lang");
  sel.innerHTML = langs.map((l) => html`<option value="${l.code}"${l.code === LANG ? raw(" selected") : ""}>${l.name}</option>`.toString()).join("");
  sel.hidden = langs.length < 2;
  sel.addEventListener("change", () => {
    try { localStorage.setItem("tr-lang", sel.value); } catch (e) { /* not remembered */ }
    location.reload(); // most strings are baked into the rendered page: start again in the new language
  });
}

function applyStatic() {
  $("title").textContent = INFO.title;
  $("skip").textContent = S.skip_link;
  $("tagline").textContent = S.tagline;
  $("banner").textContent = INFO.demo ? S.demo_banner : S.local_banner;
  $("home-title").textContent = S.home_title;
  $("home-lead").textContent = S.home_lead;
  $("q").placeholder = S.search_placeholder;
  $("q").setAttribute("aria-label", S.search_label);
  $("theme").textContent = S.theme;
  $("lang").setAttribute("aria-label", S.lang_label);
  $("mode-free").textContent = S.mode_free + " · " + S.mode_free_hint;
  $("mode-free").title = S.mode_free_hint;
  $("ai-search").textContent = S.ai_search;
  $("search-note").textContent = S.search_note;
  $("filesearch-title").textContent = S.files_find_title;
  $("fq").placeholder = S.files_find_placeholder;
  $("fq").setAttribute("aria-label", S.files_find_label);
  $("none-hint").textContent = S.search_none_hint;
  $("none-ai").textContent = S.search_none_ai;
  $("seg").setAttribute("aria-label", S.view_label);
  $("view-timeline").textContent = S.view_timeline;
  $("view-cards").textContent = S.view_cards;
  $("vz-repo-label").textContent = S.tl_repo;
  $("vz-period-label").textContent = S.tl_period;
  $("vz-period").innerHTML = html`${[["all", S.tl_period_all], ["7", S.tl_period_7], ["30", S.tl_period_30], ["90", S.tl_period_90], ["custom", S.tl_period_custom]]
    .map(([v, l]) => html`<option value="${v}">${l}</option>`)}`;
  $("vz-from-label").textContent = S.tl_from;
  $("vz-to-label").textContent = S.tl_to;
  $("vz-reset").textContent = S.tl_reset;
  $("capfilter-text").textContent = S.coverage_filter_on;
  $("capfilter-clear").textContent = S.coverage_clear;
  $("coverage").title = S.coverage_title;
  $("coverage").setAttribute("aria-label", S.coverage_label);
}

// ---------- AI usage counter (header) ----------
async function refreshUsage() {
  try {
    const u = await api("/api/usage");
    const s = u.session, t = u.total;
    const line1 = s.tokens ? fmtTokens(s.tokens) + " " + S.tokens + " · " + usd(s.usd) : S.usage_none;
    $("usage").innerHTML = html`<span>${S.usage_label} (${S.usage_session}): ${line1}</span><small>${cap1(S.usage_total)}: ${fmtTokens(t.tokens)} ${S.tokens} · ${usd(t.usd)}</small>`;
  } catch (e) { $("usage").textContent = ""; }
}

