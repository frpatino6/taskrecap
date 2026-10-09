"use strict";
// ---------- home ----------
function kindLabel(k) { return S["kind_" + k] || k; }

function card(t, extra) {
  extra = extra || {};
  const sess = t.sessions + " " + (t.sessions === 1 ? S.session : S.sessions);
  const dates = t.first_ts ? day(t.first_ts) + (day(t.last_ts) !== day(t.first_ts) ? " – " + day(t.last_ts) : "") : "";
  const title = unitTitle(t);
  const chips = t.projects.slice(0, 3).map((p) => `<span class="chip repo">${esc(p)}</span>`).join("") + unitChips(t) +
    `<span class="chip">${esc(sess)}</span>` + (dates ? `<span class="chip">${esc(dates)}</span>` : "") +
    (t.generatable ? (t.has_capsule ? `<span class="chip done">${esc(S.chip_capsule)}</span>` : `<span class="chip warn">${esc(S.chip_no_capsule)}</span>`) : "") +
    (t.has_capsule && t.outdated ? `<span class="chip warn" title="${esc(fmt(S.stale_tip, { n: t.new_messages }))}">${esc(fmt(S.stale_chip, { n: t.new_messages }))}</span>` : "");
  return `<div class="cardwrap" role="listitem"><button class="card" data-key="${esc(t.key)}" type="button">
    <span class="t">${esc(kindLabel(t.kind))}${t.renamed && t.kind !== "user" ? " · " + esc(t.key) : ""}</span>
    <span class="k${t.kind === "session" || t.kind === "user" ? " kname" : ""}">${esc(title)}</span>
    <span class="s">${esc(t.objective || (t.kind === "session" && t.label ? "" : t.snippet))}</span>
    ${extra.reason ? `<span class="reason">${esc(extra.reason)}</span>` : ""}
    ${extra.hit ? hitHtml(extra.hit) : ""}
    ${relatedLine(t)}
    <span class="meta">${chips}</span></button>
    <button class="cardmenu" type="button" data-menu="${esc(t.key)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(fmt(S.menu_label, { name: title }))}">⋯</button></div>`;
}

let HITS = null; // null = no query; otherwise Map(key -> hit), best match first, from the free, literal search
let SCOPE = null; // what that search could look inside: {capsules, other_tasks}

/** `text` with the [start, end) ranges wrapped in <mark> (everything escaped). */
function highlighted(text, ranges) {
  let out = "", at = 0;
  for (const [a, b] of ranges || []) { out += esc(text.slice(at, a)) + "<mark>" + esc(text.slice(a, b)) + "</mark>"; at = b; }
  return out + esc(text.slice(at));
}

/** WHY a task matched the free search: the section of its capsule and the highlighted words. */
function hitHtml(h) {
  if (h.where === "task") return `<span class="hitwhy">${esc(S.search_hit_task)}</span>`;
  const tr = h.truncated || [false, false];
  return `<span class="hitwhy"><b>${esc(fmt(S.search_found_in, { section: S[h.section] || h.section }))}</b></span>` +
    `<span class="excerpt">${tr[0] ? "…" : ""}${highlighted(h.excerpt, h.highlights)}${tr[1] ? "…" : ""}</span>`;
}

function scopeText(c) {
  if (!c) return "";
  if (!c.capsules) return S.search_scope_none;
  return c.other_tasks ? fmt(S.search_scope, { capsules: c.capsules, others: c.other_tasks }) : fmt(S.search_scope_all, { capsules: c.capsules });
}

function bindCards(root) {
  root.querySelectorAll(".card").forEach((b) => b.addEventListener("click", () => { location.hash = "#/task/" + encodeURIComponent(b.dataset.key); }));
  bindUnitButtons(root);
}

// ---------- home: cards or timeline ----------
let VIEW = "timeline"; // remembered between visits
try { if (localStorage.getItem("tr-view") === "cards") VIEW = "cards"; } catch (e) { /* storage blocked: default view */ }
const VZ = { repo: "", period: "all", from: "", to: "", limit: 12, noCapsule: false }; // timeline filters; the capsule filter also narrows the cards
let TL = null;
let tlSeq = 0;

function setView(v) {
  VIEW = v;
  try { localStorage.setItem("tr-view", v); } catch (e) { /* not remembered, still works */ }
  renderHome();
}

function renderCoverage() {
  const gen = TASKS.filter((t) => t.generatable), ready = gen.filter((t) => t.has_capsule).length;
  const el = $("coverage");
  el.hidden = !gen.length;
  if (!gen.length) return;
  const C = 2 * Math.PI * 10.5;
  $("cv-fg").setAttribute("stroke-dasharray", (C * ready / gen.length).toFixed(1) + " " + C.toFixed(1));
  const old = gen.filter((t) => t.has_capsule && t.outdated).length;
  $("coverage-text").textContent = fmt(S.coverage_text, { ready, total: gen.length }) + (old ? " · " + fmt(S.coverage_outdated, { n: old }) : "");
  el.setAttribute("aria-pressed", String(VZ.noCapsule));
}

function renderHome() {
  const byKey = new Map(TASKS.map((t) => [t.key, t]));
  let list = HITS ? [...HITS.keys()].map((k) => byKey.get(k)).filter(Boolean) : TASKS; // hits are already best first
  if (VZ.noCapsule) list = list.filter((t) => t.generatable && !t.has_capsule);
  const real = list.filter((t) => !t.noise), empty = list.filter((t) => t.noise); // sessions without content are folded into one group
  const timeline = VIEW === "timeline" && TASKS.length > 0;
  $("grid").innerHTML = timeline ? "" : real.map((t) => card(t, HITS ? { hit: HITS.get(t.key) } : null)).join("");
  $("none").textContent = TASKS.length ? S.no_results : S.no_sessions;
  $("nonewrap").hidden = timeline ? !(HITS && !real.length) : real.length > 0;
  $("none-extra").hidden = !(HITS && TASKS.length && !real.length); // free search found nothing: suggest AI search (never run it for the user)
  $("search-scope").textContent = HITS ? scopeText(SCOPE) : "";
  $("search-scope").hidden = !HITS;
  bindCards($("grid"));
  renderEmptyGroup(empty);
  $("viewbar").hidden = !TASKS.length;
  $("view-timeline").setAttribute("aria-pressed", String(timeline));
  $("view-cards").setAttribute("aria-pressed", String(!timeline));
  $("vzfilters").hidden = !timeline;
  $("capfilter").hidden = !VZ.noCapsule;
  $("timeline").hidden = !timeline || !!(HITS && !real.length);
  renderCoverage();
  if (typeof renderOrganize === "function") renderOrganize();
  return timeline && !(HITS && !real.length) ? loadTimeline() : undefined;
}
