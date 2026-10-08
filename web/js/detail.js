"use strict";
// ---------- detail ----------
let CAP_KEY = ""; // the capsule being rendered: lets the evidence panel check a citation against it
const cites = (cs) => (cs && cs.length ? ` <span class="cites">${cs.map((c) => `<button class="cite" type="button" data-session="${esc(c.session)}" data-turn="${esc(c.turn)}" data-key="${esc(CAP_KEY)}" title="${esc(S.evidence_open_hint)}" aria-label="${esc(fmt(S.evidence_open_label, { session: c.session, turn: c.turn }))}">${esc(c.session)}:${esc(c.turn)}</button>`).join(" ")}</span>` : "");
const list = (items, render, cls) => (items && items.length ? `<ul class="items ${cls || ""}">${items.map((i) => `<li>${render(i)}</li>`).join("")}</ul>` : `<p>${esc(S.none)}</p>`);
const commitLi = (c) => `<code>${esc(c.hash)}</code> <code>${esc(c.branch)}</code> ${esc(c.msg)}` + (c.pushed ? ` <span class="chip active">${esc(S.pushed)}</span>` : "") + (c.undone ? ` <span class="chip warn">${esc(S.undone)}</span>` : "");

const pad2 = (n) => String(n).padStart(2, "0");
/** 'MM-DD HH:MM' (24 h) in the browser's own timezone from an ISO timestamp; null when the row has no usable time. */
function whenLabel(ts) {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime()) ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : null;
}
/** The first cell of a timeline row: date and time of its first cited message, or just the stored date when no time is known. */
function whenCell(row) {
  const label = whenLabel(row.ts);
  return label ? `<span title="${esc(S.timeline_time_hint)}">${esc(label)}</span>` : esc(row.date);
}

function capsuleHtml(res) {
  CAP_KEY = res.key || "";
  const c = res.capsule || {};
  const files = res.files || [], fin = files.filter((f) => f.status === "final"), rev = files.filter((f) => f.status === "reverted");
  const cm = res.commits || { confirmed: [], possible: [] };
  const tl = (c.timeline || []).length ? `<div class="tablewrap"><table class="tl2"><thead><tr><th>${esc(S.date_time)}</th><th>${esc(S.repo)}</th><th>${esc(S.result)}</th><th>${esc(S.evidence)}</th></tr></thead><tbody>` +
    c.timeline.map((t) => `<tr><td>${whenCell(t)}</td><td>${esc(t.repo)}</td><td>${esc(t.result)}</td><td>${cites(t.cites)}</td></tr>`).join("") + `</tbody></table></div>` : `<p>${esc(S.none)}</p>`;
  const dec = (c.decisions || []).length ? c.decisions.map((d) => `<div class="decision"><strong>${esc(d.decision)}${d.uncertain ? ` <span class="chip warn">${esc(S.uncertain)}</span>` : ""}</strong><span>${esc(d.why || S.no_reason)}${cites(d.cites)}</span></div>`).join("") : `<p>${esc(S.none)}</p>`;
  const fileBtn = (f) => `<button class="filelink" type="button" data-file="${esc(f.short)}">${esc(f.short)}</button>`;
  const filesHtml = `<p class="note" style="margin-top:0">${esc(S.files_hint)}</p>` +
    `<details open><summary>${esc(S.files_final)} (${fin.length})</summary>${list(fin, (f) => `${fileBtn(f)} (${esc(f.edits)}×)`)}</details>` +
    (rev.length ? `<details><summary>${esc(S.files_reverted)} (${rev.length})</summary>${list(rev, fileBtn)}</details>` : "") +
    `<div class="filebox" id="filebox" aria-live="polite"></div>`;
  const commitsHtml = (cm.confirmed.length ? list(cm.confirmed, commitLi) : `<p>${esc(S.none)}</p>`) +
    (cm.possible.length ? `<details><summary>${esc(S.commits_possible)} (${cm.possible.length})</summary>${list(cm.possible, commitLi)}</details>` : "");
  const sec = (title, body) => `<section class="block"><h2>${esc(title)}</h2>${body}</section>`;
  return sec(S.timeline, tl) + sec(S.decisions, dec) + sec(S.files, filesHtml) + sec(S.commits, commitsHtml) +
    sec(S.dead_ends, `<div class="plain">${list(c.dead_ends, (i) => esc(i.text) + cites(i.cites), "dead")}</div>`) +
    sec(S.left_out, `<div class="plain">${list(c.left_out, (i) => esc(i.text) + cites(i.cites))}</div>`) +
    sec(S.pending, `<div class="plain">${list(c.pending, (i) => esc(i.text) + cites(i.cites), "todo")}</div>`) +
    sec(S.briefing, `<div class="briefing" id="briefing">${esc(c.briefing || "")}</div>`);
}

const staleOf = (d) => (d.stale && d.stale.known && d.stale.new_messages > 0 ? d.stale : null);
const staleText = (st) => fmt(st.new_messages === 1 ? S.stale_badge_one : S.stale_badge, { n: st.new_messages, date: day(st.generated_at) });

function genPanelHtml(d, hasCap) {
  const can = d.task && d.task.generatable;
  if (!can) return `<div class="note">${esc(S.unassigned_hint)}</div>`;
  const stale = hasCap ? staleOf(d) : null;
  if (stale) { // the capsule is older than some of its messages: say so, and offer the same regenerate flow (estimate + confirm)
    return `<div class="stale" role="status"><span class="chip warn">${esc(staleText(stale))}</span><button class="linkbtn" id="stale-see" type="button">${esc(S.stale_view_new)}</button>` +
      `<button class="cta ai ghost sm" id="gen" type="button">${esc(S.stale_update)}</button><span class="hint">${esc(S.stale_update_hint)}</span></div><div id="genbox" aria-live="polite"></div>`;
  }
  const title = hasCap ? "" : `<h2>${esc(S.no_capsule_title)}</h2><p>${esc(S.no_capsule_text)}</p><p class="note">${esc(S.sessions_no_capsule_hint)} <button class="linkbtn" id="sess-jump" type="button">${esc(S.sessions_jump)}</button></p>`;
  if (hasCap) return `<div class="genslim"><span class="chip ai">${esc(S.ai_badge)}</span><button class="cta ai ghost sm" id="gen" type="button">${esc(S.regenerate)}</button><span class="hint">${esc(S.regenerate_hint)}</span></div><div id="genbox" aria-live="polite"></div>`;
  return `<div class="panel gen ai"><p style="margin:0 0 8px"><span class="chip ai">${esc(S.ai_badge)}</span></p>${title}<div class="row"><button class="cta ai" id="gen" type="button">${esc(S.generate)}</button></div><div id="genbox" aria-live="polite"></div></div>`;
}

async function renderDetail(key, { animate = false } = {}) {
  const el = $("detail");
  el.innerHTML = html`<p class="empty">${S.loading}</p>`;
  let d;
  try { d = await api("/api/tasks/" + encodeURIComponent(key)); } catch (e) {
    el.innerHTML = html`<p class="err" role="alert">${S.error_prefix} ${e.message}</p><button class="cta ghost sm" id="detail-retry" type="button">${S.error_retry}</button>`;
    $("detail-retry").addEventListener("click", () => renderDetail(key, { animate }));
    return;
  }
  const cap = d.capsule, t = d.task || { key, kind: "key", generatable: true, projects: [], snippet: "" };
  const objective = cap ? (cap.capsule || {}).objective : (d.sessions[0] || {}).snippet;
  el.innerHTML = `<button class="back" id="back" type="button">${esc(S.back)}</button>
    <div class="hero"><div><span class="chip repo">${esc(kindLabel(t.kind))}</span><h1 tabindex="-1">${esc(key)}</h1><p class="t">${esc(objective || "")}</p>
      ${cap && cap.generated_at ? `<p class="t" style="font-size:13px">${esc(fmt(S.generated_at, { date: day(cap.generated_at) }))}</p>` : ""}</div>
      ${cap ? `<button class="cta" id="resume" type="button">${esc(S.resume)}</button>` : ""}</div>
    ${genPanelHtml(d, !!cap)}
    ${cap ? capsuleHtml(cap) : ""}
    ${sessionsHtml(d, key)}`;
  if (animate) { el.classList.remove("fade-in"); void el.offsetWidth; el.classList.add("fade-in"); }
  $("back").addEventListener("click", () => { location.hash = ""; });
  const resume = $("resume");
  if (resume) resume.addEventListener("click", () => copyBriefing(resume, (cap.capsule || {}).briefing || ""));
  const gen = $("gen");
  if (gen) gen.addEventListener("click", () => startGenerate(key));
  applyAiGate(); // the generate button and, when Claude Code is missing, the note and "Check again" under it
  el.querySelectorAll(".filelink").forEach((b) => b.addEventListener("click", () => showFileTasks(b.dataset.file, key)));
  bindSessions(d);
}

// ---------- sessions: the user's own messages of a task (free, local) ----------
const SESS = { key: "", scope: "all", markable: false, stale: null };
const MSG_PAGE = 40;
const plural = (n, one, many) => fmt(n === 1 ? one : many, { n });
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

/** 'Sep 7, 09:03 – 09:19' for one day, 'Sep 7, 09:03 – Sep 8, 05:28' across days. */
function sessionWhen(s) {
  if (!s.first_ts) return "";
  const a = new Date(s.first_ts), b = s.last_ts ? new Date(s.last_ts) : null;
  if (!b || Number.isNaN(b.getTime()) || b.getTime() === a.getTime()) return evTime(s.first_ts);
  return evTime(s.first_ts) + " – " + (a.toDateString() === b.toDateString() ? clock(s.last_ts) : evTime(s.last_ts));
}

function sessionItem(s, i) {
  const mixed = SESS.markable && s.mixed;
  const chips = `<span class="chip repo">${esc(s.project)}</span>` + (s.branch ? `<span class="chip">${esc(s.branch)}</span>` : "") +
    `<span class="chip">${esc(plural(s.n_prompts, S.sessions_message_one, S.sessions_messages))}</span>` +
    (mixed ? `<span class="chip">${esc(S.sessions_mixed_chip)}</span>` : "") +
    (s.new_messages ? `<span class="chip warn">${esc(fmt(S.sessions_new_chip, { n: s.new_messages }))}</span>` : "");
  return `<div class="sessitem" data-id="${esc(s.id)}" data-mixed="${mixed ? 1 : 0}" data-new="${s.new_messages || 0}">` +
    `<button class="sessrow" type="button" aria-expanded="false" aria-controls="msgs-${i}"><span class="chev" aria-hidden="true">▸</span><code>${esc(s.id.slice(0, 8))}</code><span class="when">${esc(sessionWhen(s))}</span>${chips}</button>` +
    `<div class="msgs" id="msgs-${i}" role="region" aria-label="${esc(fmt(S.sessions_region_label, { session: s.id.slice(0, 8) }))}" hidden></div></div>`;
}

function sessionsHtml(d, key) {
  Object.assign(SESS, { key, scope: "all", markable: !!d.markable, stale: staleOf(d) });
  const anyMixed = SESS.markable && d.sessions.some((s) => s.mixed);
  const scopes = [["all", S.sessions_filter_all]];
  if (anyMixed) scopes.push(["mine", fmt(S.sessions_filter_mine, { key })]);
  if (SESS.stale) scopes.push(["new", fmt(S.sessions_filter_new, { n: SESS.stale.new_messages })]);
  const tools = scopes.length > 1 ? `<div class="sesstools"><div class="seg" id="sessscope" role="group" aria-label="${esc(S.sessions_filter_label)}">` +
    scopes.map(([v, label]) => `<button type="button" data-scope="${v}" aria-pressed="${v === "all"}">${esc(label)}</button>`).join("") + `</div></div>` : "";
  return `<section class="block" id="sessions"><h2 tabindex="-1">${esc(S.sessions_heading)} (${d.sessions.length})</h2>` +
    `<p class="note">${esc(S.sessions_note)}${anyMixed ? " " + esc(fmt(S.sessions_mixed_note, { key })) : ""}</p>${tools}` +
    `<div class="sesslist" id="sesslist">${d.sessions.map(sessionItem).join("") || `<p>${esc(S.none)}</p>`}</div></section>`;
}

const msgHtml = (m, sid) => `<button class="msg${m.mine ? " mine" : ""}${m.new ? " new" : ""}" type="button" data-session="${esc(sid)}" data-turn="${m.turn}" data-key="" aria-label="${esc(fmt(S.sessions_open_message, { n: m.turn }))}">` +
  `<span class="n">#${m.turn}</span><span class="w">${esc(evTime(m.ts))}${m.new ? ` <span class="chip warn" title="${esc(S.sessions_msg_new_label)}">${esc(S.sessions_msg_new)}</span>` : ""}</span>` +
  `<span class="x">${esc(m.text)}${m.cut ? "…" : ""}${m.mine ? ` <span class="sr">${esc(fmt(S.sessions_msg_mine, { key: SESS.key }))}</span>` : ""}</span></button>`;

/** Loads (reset) or appends (more) one page of messages of a session; a newer request for the same session wins. */
async function loadMessages(item, reset) {
  const box = item.querySelector(".msgs"), sid = item.dataset.id, mixed = item.dataset.mixed === "1";
  const token = (box._tok = (box._tok || 0) + 1);
  const offset = reset ? 0 : Number(box.dataset.offset || 0);
  if (reset) { box.dataset.loaded = ""; box.innerHTML = html`<p class="note" role="status">${S.sessions_loading}</p>`; }
  const q = new URLSearchParams({ key: SESS.key, session: sid, scope: SESS.scope, offset: String(offset), limit: String(MSG_PAGE) });
  try {
    const r = await api("/api/messages?" + q);
    if (token !== box._tok) return; // the scope changed or the box was reloaded meanwhile
    const rows = r.messages.map((m) => msgHtml(m, sid)).join("");
    const end = offset + r.messages.length;
    box.dataset.offset = String(end);
    box.dataset.loaded = "1";
    const foot = html`${end < r.total ? html`<button class="cta ghost sm msgmore" type="button">${fmt(S.sessions_more, { n: Math.min(MSG_PAGE, r.total - end) })}</button>` : ""}${r.hidden_noise && r.scope === "all" ? html`<p class="note">${fmt(S.sessions_noise, { n: r.hidden_noise })}</p>` : ""}`;
    if (reset) {
      const empty = r.scope === "mine" ? S.sessions_empty_mine : r.scope === "new" ? S.sessions_empty_new : S.sessions_empty;
      const marking = mixed && r.mark && r.scope === "all";
      box.classList.toggle("marking", marking);
      box.innerHTML = html`${marking ? html`<p class="note">${fmt(S.sessions_marking, { key: SESS.key })}</p>` : ""}${rows ? html`<div class="msglist">${raw(rows)}</div>` : html`<p class="note">${fmt(empty, { key: SESS.key })}</p>`}<div class="msgfoot">${foot}</div>`;
    } else {
      box.querySelector(".msglist").insertAdjacentHTML("beforeend", rows);
      box.querySelector(".msgfoot").innerHTML = foot;
    }
  } catch (err) {
    if (token === box._tok) box.innerHTML = html`<p class="err" role="alert">${S.sessions_error} ${err.message}</p>`;
  }
}

async function toggleSession(item, open) {
  const row = item.querySelector(".sessrow"), box = item.querySelector(".msgs");
  const willOpen = open === undefined ? row.getAttribute("aria-expanded") !== "true" : open;
  row.setAttribute("aria-expanded", String(willOpen));
  box.hidden = !willOpen;
  if (willOpen && !box.dataset.loaded) await loadMessages(item, true);
}

/** Changes which messages are listed. 'new' shows only the sessions that have new messages, opened; the others keep their state. */
function setSessionScope(scope) {
  SESS.scope = scope;
  document.querySelectorAll("#sessscope button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scope === scope)));
  document.querySelectorAll("#sesslist .sessitem").forEach((item) => {
    const hide = scope === "new" && !Number(item.dataset.new);
    item.hidden = hide;
    const open = item.querySelector(".sessrow").getAttribute("aria-expanded") === "true";
    if (hide) return;
    if (scope === "new" && !open) toggleSession(item, true);
    else if (open) loadMessages(item, true);
  });
}

function bindSessions(d) {
  const list = $("sesslist");
  if (list) list.addEventListener("click", (e) => {
    const more = e.target.closest(".msgmore");
    if (more) { loadMessages(more.closest(".sessitem"), false); return; }
    const row = e.target.closest(".sessrow");
    if (row) toggleSession(row.closest(".sessitem"));
  });
  const scope = $("sessscope");
  if (scope) scope.addEventListener("click", (e) => { const b = e.target.closest("button[data-scope]"); if (b) setSessionScope(b.dataset.scope); });
  const reveal = () => { const h = $("sessions"); h.scrollIntoView({ block: "start" }); h.querySelector("h2").focus({ preventScroll: true }); };
  const see = $("stale-see");
  if (see) see.addEventListener("click", () => { setSessionScope("new"); reveal(); });
  const jump = $("sess-jump");
  if (jump) jump.addEventListener("click", () => { const first = document.querySelector("#sesslist .sessitem"); reveal(); if (first) toggleSession(first, true); });
}

async function copyBriefing(btn, text) {
  const old = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = S.copied; btn.classList.add("ok"); }
  catch (e) { btn.textContent = S.copy_failed; const b = $("briefing"); if (b) { const r = document.createRange(); r.selectNodeContents(b); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }
  setTimeout(() => { btn.textContent = old; btn.classList.remove("ok"); }, 2600);
}

async function startGenerate(key) {
  if (!aiOn()) { applyAiGate(); return; } // Claude Code is not (or not yet known to be) there: never start a request
  const box = $("genbox");
  setAiBusy("gen", true);
  box.innerHTML = html`<p>${S.estimate_loading}</p>`;
  try {
    const e = await api("/api/estimate?key=" + encodeURIComponent(key));
    box.innerHTML = html`<p style="margin-top:12px">${fmt(S.estimate_text, { tokens: fmtTokens(e.input_tokens + e.output_tokens), usd: "~" + usd(e.usd), seconds: e.seconds, calls: e.calls, sessions: e.sessions })}</p>
      <div class="row"><button class="cta ai" id="ok" type="button">${S.confirm_generate}</button><button class="cta ghost" id="no" type="button">${S.cancel}</button></div>`;
    $("no").addEventListener("click", () => { box.innerHTML = ""; setAiBusy("gen", false); });
    $("ok").addEventListener("click", () => {
      if (!aiOn()) { box.innerHTML = ""; setAiBusy("gen", false); applyAiGate(); return; }
      runAiAction({
        box, path: "/api/generate", body: { key, confirm: true }, title: fmt(S.progress_generating, { key }),
        onDone: async (res) => {
          if (location.hash === "#/task/" + encodeURIComponent(key)) { // still looking at this task: show the new capsule
            await renderDetail(key, { animate: true });
            const b = $("genbox");
            if (b) b.innerHTML = html`<p class="okmsg" role="status">${fmt(S.progress_done_generate, { tokens: fmtTokens((res.info || {}).tokens), usd: usd((res.info || {}).cost_usd) })}</p>`;
          }
          TASKS = (await api("/api/tasks")).tasks;
          refreshUsage();
        },
        onEnd: () => { setAiBusy("gen", false); },
        onRetry: () => startGenerate(key),
      });
    });
  } catch (err) {
    box.innerHTML = html`<p class="err" role="alert">${S.error_prefix} ${err.message}</p><div class="row"><button class="cta ai sm" id="gen-retry" type="button">${S.error_retry}</button></div>`;
    $("gen-retry").addEventListener("click", () => startGenerate(key)); // the estimate failed: nothing was spent, asking again is safe
    setAiBusy("gen", false);
  }
}

