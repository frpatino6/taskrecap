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

// ---------- Claude Code missing? AI actions are switched off, with the way to fix it (free mode never depends on it) ----------
// ONE place decides whether an AI button is clickable: disabled = an action is running OR Claude Code is not available.
// Handlers only say "my action started / ended" (setAiBusy); the gate only says "Claude Code is / is not there" (INFO.ai).
const aiState = () => (!INFO.ai || INFO.ai.available === true ? "on" : INFO.ai.available === false ? "off" : "checking");
const aiOn = () => aiState() === "on";
const AI_BUTTONS = { search: ["ai-search", "none-ai"], gen: ["gen"] }; // action -> the buttons that start it
const aiBusy = new Set();
function syncAiButtons() {
  const state = aiState();
  for (const [action, ids] of Object.entries(AI_BUTTONS)) {
    for (const id of ids) {
      const b = $(id);
      if (!b) continue;
      b.disabled = aiBusy.has(action) || state !== "on";
      if (state === "off") b.title = S.ai_off_tooltip; else if (state === "checking") b.title = S.ai_checking_tooltip; else b.removeAttribute("title");
    }
  }
}
/** An AI action started (on = true) or ended (false). Ending re-enables its buttons only if Claude Code is available. */
function setAiBusy(action, on) {
  if (on) aiBusy.add(action); else aiBusy.delete(action);
  syncAiButtons();
}
function aiOffHtml() {
  const a = INFO.ai || {};
  const why = a.reason === "not-working" ? S.ai_off_not_working : a.reason === "override-not-found" ? S.ai_off_bad_override : a.reason === "unknown" ? S.ai_off_unknown : S.ai_off_not_found;
  const tried = (a.tried || []).length > 1 ? html`<p class="hint">${fmt(S.ai_off_tried, { places: a.tried.slice(0, 6).join(", ") })}</p>` : "";
  return html`<div class="panel ai-off" role="status"><h2>${S.ai_off_title}</h2><p>${why}</p>${tried}<h3>${S.ai_off_steps_title}</h3>
    <ul><li>${S.ai_off_step_install}</li><li>${S.ai_off_step_path}</li><li>${S.ai_off_step_doctor}</li></ul>
    <div class="row"><button class="cta ghost sm ai-recheck" type="button">${S.ai_off_recheck}</button><span class="hint ai-recheck-msg" role="status" aria-live="polite"></span></div></div>`;
}
/** Wires the "Check again" buttons inside `box`: asks the server to look for Claude Code again (POST: it starts a real check); when it is there, the page refreshes. */
function bindAiRecheck(box) {
  box.querySelectorAll(".ai-recheck").forEach((btn) => btn.addEventListener("click", async () => {
    const msg = box.querySelector(".ai-recheck-msg");
    btn.disabled = true;
    if (msg) msg.textContent = S.ai_off_checking;
    try { INFO.ai = await api("/api/ai/recheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch (e) { if (msg) msg.textContent = e.message; btn.disabled = false; return; }
    if (aiOn()) { applyAiGate(); if (typeof route === "function") route(); return; }
    if (msg) msg.textContent = S.ai_off_still;
    btn.disabled = false;
  }));
}
/** Apply the Claude Code status to the page: the AI buttons, the explanation note on the home page, the one in the capsule view. */
function applyAiGate() {
  const off = aiState() === "off";
  syncAiButtons();
  const note = $("ai-note");
  if (note) {
    note.innerHTML = off ? aiOffHtml() : "";
    if (off) bindAiRecheck(note);
  }
  const box = $("genbox"); // capsule view: the same note, but never over an estimate or a running action
  if (box && $("gen")) {
    const shown = String(box.innerHTML || "").includes("ai-off");
    if (off && !String(box.innerHTML || "").trim()) { box.innerHTML = aiOffHtml(); bindAiRecheck(box); }
    else if (!off && shown) box.innerHTML = "";
  }
}
/** The server did not know yet whether Claude Code is there (it answered `checking`): ask again until it does. */
let aiPoll = null;
function pollAiStatus() {
  if (aiPoll || aiState() !== "checking") return;
  let tries = 0;
  aiPoll = setInterval(async () => {
    tries += 1;
    try { INFO.ai = await api("/api/ai"); } catch (e) { /* the next try asks again */ }
    if (aiState() !== "checking" || tries >= 30) {
      clearInterval(aiPoll);
      aiPoll = null;
      if (aiState() === "checking") INFO.ai = { available: false, reason: "unknown", tried: [] }; // gave up waiting: the buttons stay off, "Check again" is there
      applyAiGate();
    }
  }, 600);
}
