"use strict";
// ---------- timeline ----------
const localDay = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() - offsetDays); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
/** The days the timeline is filtered to: a preset counts back from today, "custom" uses the two date boxes. */
function vzRange() {
  if (VZ.period === "custom") return { from: VZ.from, to: VZ.to };
  const n = Number(VZ.period);
  return n > 0 ? { from: localDay(n - 1), to: "" } : { from: "", to: "" };
}
function tlQuery() {
  const q = new URLSearchParams();
  if (VZ.repo) q.set("repo", VZ.repo);
  const range = vzRange();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  if (VZ.noCapsule) q.set("capsule", "none");
  if (HITS) q.set("keys", [...HITS.keys()].join("\n")); else q.set("limit", String(VZ.limit));
  return q.toString();
}

async function loadTimeline() {
  const seq = ++tlSeq;
  try {
    const r = await api("/api/timeline?" + tlQuery());
    if (seq !== tlSeq) return; // a newer request is already running
    TL = r;
    fillRepoSelect(r.all_repos);
    renderTimeline();
  } catch (e) { $("timeline").innerHTML = html`<p class="err" role="alert">${e.message}</p>`; }
}

function fillRepoSelect(repos) {
  const sel = $("vz-repo"), sig = repos.join("\n");
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = html`<option value="">${S.tl_repo_all}</option>${repos.map((r) => html`<option value="${r}">${r}</option>`)}`;
    sel.dataset.sig = sig;
  }
  sel.value = repos.includes(VZ.repo) ? VZ.repo : "";
}

const dayLabel = (d, withYear) => new Date(d + "T12:00:00").toLocaleDateString(undefined, withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
const promptsText = (n) => (n === 1 ? S.tl_prompt : fmt(S.tl_prompts, { n }));
const activeDaysText = (n) => (n === 1 ? S.tl_active_day : fmt(S.tl_active_days, { n }));
const laneKey = (l) => unitTitle(l);
const laneRepos = (l) => (l.projects.length > 1 ? `${l.project} +${l.projects.length - 1}` : l.project);
const capsuleText = (l) => (l.generatable ? (l.has_capsule ? S.chip_capsule + (l.outdated ? " · " + fmt(S.stale_tip, { n: l.new_messages }) : "") : S.chip_no_capsule) : "");

function laneSummary(l) {
  return [laneKey(l), laneRepos(l), dayLabel(l.first, true) + (l.last !== l.first ? " – " + dayLabel(l.last, true) : ""), promptsText(l.prompts) + " · " + activeDaysText(l.active_days), capsuleText(l)].filter(Boolean).join(", ");
}

function renderTimeline() {
  const tl = TL, el = $("timeline");
  const yearOf = (d) => d.slice(0, 4), multiYear = yearOf(tl.range.from) !== yearOf(tl.range.to);
  const named = tl.repos.filter((r) => r.slot >= 0), others = tl.repos.filter((r) => r.slot < 0);
  const legend = `<ul class="vz-legend" aria-label="${esc(S.tl_legend)}">` +
    named.map((r) => `<li><span class="vz-sw s${r.slot}" aria-hidden="true"></span>${esc(r.name)}</li>`).join("") +
    (others.length ? `<li title="${esc(others.map((r) => r.name).join(", "))}"><span class="vz-sw s-other" aria-hidden="true"></span>${esc(S.tl_legend_other)} (${others.length})</li>` : "") + "</ul>";
  const head = `<div class="vz-head"><h2 id="vz-title">${esc(S.tl_title)}</h2><p>${esc(S.tl_hint)}</p>${tl.repos.length ? legend : ""}</div>`;
  if (!tl.lanes.length) {
    const filtered = VZ.repo || VZ.period !== "all" || VZ.noCapsule;
    el.innerHTML = head + html`<p class="vz-empty" role="status">${S.tl_empty}${filtered ? html` <button type="button" class="cta ghost sm" id="vz-empty-reset">${S.tl_empty_reset}</button>` : ""}</p>`;
    return;
  }
  const grid = (ticks) => ticks.map((t) => `<i class="vz-gl" style="left:${t.x}%"></i>`).join("");
  const lane = (l) => {
    const marks = l.marks.map((m, i) => {
      const prev = l.marks[i - 1];
      const nudge = prev && prev.day === m.day ? 6 : 0; // two repos on the same day sit side by side
      return `<button type="button" class="vz-mark${m.slot >= 0 ? " s" + m.slot : " s-other"}" tabindex="-1" aria-label="${esc(fmt(S.tl_mark_label, { key: laneKey(l), repo: m.project, day: dayLabel(m.day, true), prompts: promptsText(m.n) }))}" data-key="${esc(l.key)}" data-day="${esc(m.day)}" data-n="${m.n}" data-repo="${esc(m.project)}" style="left:calc(${m.x}% + ${nudge}px);width:${m.size}px;height:${m.size}px"></button>`;
    }).join("");
    return `<div class="vz-row vz-lane">
      <div class="vz-labelwrap"><button type="button" class="vz-label${l.unsorted ? " unsorted" : ""}" data-key="${esc(l.key)}" data-tip="lane" aria-label="${esc(fmt(S.tl_open, { key: laneSummary(l) }))}">
        <span class="vz-key">${esc(laneKey(l))}${l.has_capsule ? '<i aria-hidden="true">✓</i>' : ""}${l.has_capsule && l.outdated ? `<i class="vz-stale" aria-hidden="true" title="${esc(fmt(S.stale_tip, { n: l.new_messages }))}">↻</i>` : ""}</span><span class="vz-sub">${l.unsorted ? esc(S.chip_unsorted) + " · " : ""}${esc(laneRepos(l))}${(l.related || []).length ? " · " + esc(S.related) + ": " + esc(l.related.map((r) => r.label).join(" · ")) : ""}</span></button>
        <button type="button" class="lanemenu" data-menu="${esc(l.key)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(fmt(S.menu_label, { name: laneKey(l) }))}">⋯</button></div>
      <div class="vz-track">${grid(tl.ticks)}<i class="vz-line" style="left:${l.line.x1}%;width:${Math.max(0, l.line.x2 - l.line.x1)}%"></i>${marks}</div></div>`;
  };
  // labels are centred on their day, except at the two ends where they would spill outside the chart
  const ticks = tl.ticks.map((t) => `<span class="vz-tick" style="left:${t.x}%${t.x < 5 ? ";transform:translateX(-15%)" : t.x > 95 ? ";transform:translateX(-85%)" : ""}">${esc(dayLabel(t.day, multiYear))}</span>`).join("");
  const table = `<div class="sr"><table><caption>${esc(S.tl_table_caption)}. ${esc(fmt(S.tl_axis, { from: dayLabel(tl.range.from, true), to: dayLabel(tl.range.to, true) }))}</caption>
    <thead><tr><th>${esc(S.tl_col_task)}</th><th>${esc(S.tl_col_repos)}</th><th>${esc(S.tl_col_dates)}</th><th>${esc(S.tl_col_days)}</th><th>${esc(S.tl_col_prompts)}</th><th>${esc(S.tl_col_capsule)}</th></tr></thead><tbody>` +
    tl.lanes.map((l) => `<tr><td>${esc(laneKey(l))}</td><td>${esc(l.projects.join(", "))}</td><td>${esc(dayLabel(l.first, true) + " – " + dayLabel(l.last, true))}</td><td>${l.active_days}</td><td>${l.prompts}</td><td>${esc(l.generatable ? (l.has_capsule ? (l.outdated ? S.tl_outdated : S.tl_yes) : S.tl_no) : "")}</td></tr>`).join("") + "</tbody></table></div>";
  const more = tl.hidden > 0 ? `<button type="button" class="cta ghost sm" id="vz-more">${esc(fmt(S.tl_more, { n: Math.min(12, tl.hidden) }))}</button>` : "";
  el.innerHTML = head + `<div class="vz-scroll"><div class="vz-chart">
    <div class="vz-row" aria-hidden="true"><span class="vz-axis-pad"></span><div class="vz-ticks">${ticks}</div></div>${tl.lanes.map(lane).join("")}</div></div>
    <div class="vz-foot"><span>${esc(fmt(S.tl_showing, { shown: tl.task_shown, total: tl.task_total }))}${tl.empty_total ? " · " + esc(fmt(S.tl_empty_folded, { n: tl.empty_total })) : ""}${tl.undated ? " · " + esc(fmt(S.tl_undated, { n: tl.undated })) : ""}</span>${more}</div>
    <p class="note" style="margin:10px 18px 0">${esc(S.tl_note)}</p>` + table;
}

// tooltips: hover (mouse) and focus (keyboard) on lane labels, hover on dots; a click on either opens the task
const tip = () => $("vz-tip");
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + "px";
  t.style.top = Math.max(8, y + h + 24 > innerHeight ? y - h - 14 : y + 18) + "px";
}
const hideTip = () => { tip().hidden = true; };

function bindTimeline() {
  const el = $("timeline");
  const laneOf = (key) => (TL ? TL.lanes.find((l) => l.key === key) : null);
  el.addEventListener("click", (e) => {
    if (e.target.closest("#vz-more")) { VZ.limit += 12; loadTimeline(); return; }
    if (e.target.closest("#vz-empty-reset")) { resetVz(); return; }
    const mb = e.target.closest(".lanemenu");
    if (mb) { hideTip(); openUnitMenu(mb, mb.dataset.menu); return; }
    const t = e.target.closest("[data-key]");
    if (t) { hideTip(); location.hash = "#/task/" + encodeURIComponent(t.dataset.key); }
  });
  const onMove = (e) => {
    const m = e.target.closest(".vz-mark");
    if (m) {
      const l = laneOf(m.dataset.key);
      if (!l) return;
      showTip(`<b>${esc(laneKey(l))}</b><span>${esc(m.dataset.repo)}</span><span>${esc(dayLabel(m.dataset.day, true))} · ${esc(promptsText(Number(m.dataset.n)))}</span>${capsuleText(l) ? `<span>${esc(capsuleText(l))}</span>` : ""}`, e.clientX, e.clientY);
      return;
    }
    const b = e.target.closest(".vz-label");
    const l = b && laneOf(b.dataset.key);
    if (l) showTip(`<b>${esc(laneKey(l))}</b><span>${esc(l.projects.join(", "))}</span><span>${esc(dayLabel(l.first, true))}${l.last !== l.first ? " – " + esc(dayLabel(l.last, true)) : ""}</span><span>${esc(promptsText(l.prompts))} · ${esc(activeDaysText(l.active_days))}</span>${capsuleText(l) ? `<span>${esc(capsuleText(l))}</span>` : ""}`, e.clientX, e.clientY);
    else hideTip();
  };
  el.addEventListener("mousemove", onMove);
  el.addEventListener("mouseleave", hideTip);
  // lane label is the tab stop; Left/Right (Home/End) move among that lane's day marks, Enter/Space open the task
  el.addEventListener("keydown", (e) => {
    const lane = e.target.closest(".vz-lane");
    if (!lane || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    const marks = [...lane.querySelectorAll(".vz-mark")];
    if (!marks.length) return;
    const i = marks.indexOf(e.target);
    let next;
    if (i < 0) { if (!e.target.closest(".vz-label") || e.key === "ArrowLeft") return; next = e.key === "End" ? marks.length - 1 : 0; }
    else if (e.key === "ArrowLeft" && i === 0) { lane.querySelector(".vz-label").focus(); e.preventDefault(); return; }
    else next = e.key === "Home" ? 0 : e.key === "End" ? marks.length - 1 : Math.max(0, Math.min(marks.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)));
    e.preventDefault();
    marks[next].focus();
  });
  el.addEventListener("focusin", (e) => {
    const mk = e.target.closest(".vz-mark");
    if (mk) { const r = mk.getBoundingClientRect(); onMove({ target: mk, clientX: r.left, clientY: r.top }); return; }
    const b = e.target.closest(".vz-label");
    const l = b && laneOf(b.dataset.key);
    if (!l) return;
    const r = b.getBoundingClientRect();
    onMove({ target: b, clientX: r.left + 24, clientY: r.top });
  });
  el.addEventListener("focusout", hideTip);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
}

function resetVz() {
  Object.assign(VZ, { repo: "", period: "all", from: "", to: "", limit: 12 });
  $("vz-period").value = "all"; $("vz-custom").hidden = true;
  $("vz-from").value = ""; $("vz-to").value = ""; $("vz-msg").textContent = "";
  loadTimeline();
}

function bindViewControls() {
  $("view-timeline").addEventListener("click", () => setView("timeline"));
  $("view-cards").addEventListener("click", () => setView("cards"));
  const refilter = () => { VZ.limit = 12; loadTimeline(); };
  $("vz-repo").addEventListener("change", () => { VZ.repo = $("vz-repo").value; refilter(); });
  $("vz-period").addEventListener("change", () => {
    VZ.period = $("vz-period").value;
    $("vz-custom").hidden = VZ.period !== "custom";
    $("vz-msg").textContent = "";
    refilter();
  });
  const onDates = () => {
    VZ.from = $("vz-from").value; VZ.to = $("vz-to").value;
    $("vz-msg").textContent = "";
    if (VZ.from && VZ.to && VZ.from > VZ.to) { // reversed: swap the boxes so what you see is what is filtered
      [VZ.from, VZ.to] = [VZ.to, VZ.from];
      $("vz-from").value = VZ.from; $("vz-to").value = VZ.to;
      $("vz-msg").textContent = S.tl_range_swapped;
    }
    refilter();
  };
  $("vz-from").addEventListener("change", onDates);
  $("vz-to").addEventListener("change", onDates);
  $("vz-reset").addEventListener("click", resetVz);
  const toggleCapsule = (on) => { VZ.noCapsule = on; renderHome(); };
  $("coverage").addEventListener("click", () => toggleCapsule(!VZ.noCapsule));
  $("capfilter-clear").addEventListener("click", () => toggleCapsule(false));
  bindTimeline();
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $("q").value.trim();
    if (!q) { HITS = null; SCOPE = null; renderHome(); return; }
    try {
      const r = await api("/api/search?q=" + encodeURIComponent(q));
      if ($("q").value.trim() !== q) return; // a newer query is already running
      HITS = new Map((r.hits || []).map((h) => [h.key, h]));
      SCOPE = r.searched || null;
    } catch (e) { HITS = null; SCOPE = null; }
    renderHome();
  }, 150);
}

