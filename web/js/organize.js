"use strict";
// ---------- Organize with AI: proposals for the sessions that have no task key ----------
// Running it is an AI action (estimate, confirmation, live progress, cancel). What it returns are PROPOSALS: nothing changes until
// the user accepts one, and accepting writes the same corrections as doing it by hand, so Undo works. Rejected ones stay rejected.
let ORG = { proposals: [], eligible: 0 };
let ORG_OPEN = false; // the proposals list keeps its state between renders
let orgKeepOpen = false;

async function refreshOrganize() {
  try { ORG = await api("/api/organize/proposals"); } catch (e) { ORG = { proposals: [], eligible: 0 }; }
}

const orgPost = (action, body) => api("/api/organize/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Citation buttons that open the same evidence panel as a capsule citation (session id + message number). */
function orgCites(list) {
  return (list || []).map((e) => `<li><button class="cite" type="button" data-session="${esc(e.session)}" data-turn="${esc(e.turn)}" data-key="" title="${esc(S.evidence_open_hint)}" aria-label="${esc(fmt(S.evidence_open_label, { session: e.session, turn: e.turn }))}">${esc(e.session.slice(0, 8))}:${esc(e.turn)}</button>${e.quote ? ` <span class="orgquote">${esc(e.quote)}</span>` : ""}</li>`).join("");
}

function orgSessionLine(s) {
  const name = s.label || fmt(S.unit_fallback_session, { repo: s.project, date: s.first_ts ? day(s.first_ts) : "" });
  return `<li><span class="orgsess">${esc(name)}</span> <span class="chip repo">${esc(s.project)}</span> <span class="chip">${esc(s.first_ts ? day(s.first_ts) : "")}</span>` +
    ` <button class="linkbtn orgopen" type="button" data-open="session:${esc(s.short)}">${esc(S.org_open_session)}</button></li>`;
}

/** One proposal: what it is, why, the sessions and the evidence, and Accept / Edit title / Reject. */
function proposalHtml(p) {
  const kind = S["org_type_" + p.type] || p.type;
  const conf = `<span class="chip conf-${esc(p.confidence)}">${esc(S["org_conf_" + p.confidence] || p.confidence)}</span>`;
  let head = "", body = "";
  if (p.type === "title") {
    const s = p.sessions[0] || {};
    head = `<p class="orgtitle"><span class="orglabel">${esc(S.org_title_for)}</span> <b class="orgname">${esc(p.title)}</b></p>`;
    body = `<ul class="orgsessions">${orgSessionLine(s)}</ul>` + (s.label ? `<p class="note">${esc(fmt(S.org_current_name, { name: s.label }))}</p>` : "");
  } else if (p.type === "group") {
    head = `<p class="orgtitle"><b class="orgname">${esc(p.title)}</b></p>`;
    body = `<p class="orgwhy"><b>${esc(S.org_why)}</b> ${esc(p.reason)}</p><p class="orglabel">${esc(S.org_group_sessions)}</p><ul class="orgsessions">${p.sessions.map(orgSessionLine).join("")}</ul>` +
      `<p class="orglabel">${esc(S.org_evidence)}</p><ul class="orgevid">${orgCites(p.evidence)}</ul>`;
  } else {
    const s = p.sessions[0] || {};
    head = `<p class="orgtitle"><b class="orgname">${esc(s.label || fmt(S.unit_fallback_session, { repo: s.project, date: s.first_ts ? day(s.first_ts) : "" }))}</b></p>`;
    body = (p.reason ? `<p class="orgwhy"><b>${esc(S.org_why)}</b> ${esc(p.reason)}</p>` : "") + `<p class="orglabel">${esc(S.org_split_parts)}</p>` +
      `<ol class="orgparts">${p.parts.map((x) => `<li><span class="chip">${esc(fmt(S.org_part_range, { a: x.start, b: x.end }))}</span> <b>${esc(x.title)}</b><ul class="orgevid">${orgCites(x.evidence)}</ul></li>`).join("")}</ol>`;
  }
  const editable = p.type !== "split";
  return `<article class="orgprop" data-id="${esc(p.id)}" data-type="${esc(p.type)}"><div class="orgmeta"><span class="chip ai">${esc(kind)}</span>${p.type === "split" ? "" : conf}</div>${head}${body}` +
    (editable ? `<div class="orgedit" hidden><label class="udfield" for="oe-${esc(p.id)}">${esc(S.org_title_label)}</label><input id="oe-${esc(p.id)}" type="text" maxlength="120" value="${esc(p.title)}"></div>` : "") +
    `<div class="row orgbtns"><button class="cta sm orgaccept" type="button">${esc(S.org_accept)}</button>` +
    (editable ? `<button class="cta ghost sm orgedit-btn" type="button">${esc(S.org_edit)}</button>` : "") +
    `<button class="cta ghost sm orgreject" type="button">${esc(S.org_reject)}</button></div><p class="err orgerr" role="alert" hidden></p></article>`;
}

/** The proposals list with its "accept all" bar; used on the home page and inside the dialog of "Name with AI". */
function proposalsListHtml(list, { heading = true } = {}) {
  const high = list.filter((p) => p.confidence === "high").length;
  return `<div class="orghead">${heading ? `<h3>${esc(fmt(S.org_list_title, { n: list.length }))}</h3>` : ""}` +
    (high ? `<button class="cta ghost sm orgall" type="button">${esc(fmt(S.org_accept_all, { n: high }))}</button>` : "") + `</div>` +
    (list.length ? list.map(proposalHtml).join("") : `<p class="note">${esc(S.org_empty)}</p>`);
}

/** Handlers shared by every place that shows proposals (event delegation on `root`). `done(message)` runs after a change. */
function bindProposals(root, done) {
  if (root._orgBound) return;
  root._orgBound = true;
  const fail = (art, e) => { const el = art.querySelector(".orgerr"); el.textContent = e.message; el.hidden = false; art.querySelectorAll("button").forEach((b) => { b.disabled = false; }); };
  root.addEventListener("click", async (e) => {
    const open = e.target.closest(".orgopen");
    if (open) { closeOrgDialog(); location.hash = "#/task/" + encodeURIComponent(open.dataset.open); return; }
    const all = e.target.closest(".orgall");
    if (all) {
      all.disabled = true;
      try { const res = await orgPost("accept-all", { confidence: "high" }); await done(res, fmt(S.org_accepted_all_msg, { n: res.accepted })); } catch (err) { all.disabled = false; toast(err.message, null); }
      return;
    }
    const art = e.target.closest(".orgprop");
    if (!art) return;
    const id = art.dataset.id;
    if (e.target.closest(".orgedit-btn")) {
      const box = art.querySelector(".orgedit"), btn = e.target.closest(".orgedit-btn");
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? S.org_edit : S.org_cancel_edit;
      art.querySelector(".orgaccept").textContent = box.hidden ? S.org_accept : S.org_accept_edited;
      if (!box.hidden) art.querySelector(".orgedit input").focus();
      return;
    }
    const accept = e.target.closest(".orgaccept"), reject = e.target.closest(".orgreject");
    if (!accept && !reject) return;
    art.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      if (accept) {
        const input = art.querySelector(".orgedit input"), edited = input && !art.querySelector(".orgedit").hidden ? input.value : undefined;
        const res = await orgPost("accept", { id, title: edited });
        await done(res, S.org_accepted_msg);
      } else {
        await orgPost("reject", { id });
        await done(null, S.org_rejected_msg);
      }
    } catch (err) { fail(art, err); }
  });
}

/** After accepting or rejecting: reload the units (like any other correction), then redraw. */
async function orgChanged(res, message) {
  if (res) { await afterChange(res, message, { go: undefined }); return; }
  await refreshOrganize();
  toast(message, null);
  renderOrganize();
}

// ---------- the home page section ----------
function renderOrganize() {
  const box = $("organize");
  if (!box) return;
  const n = ORG.proposals.length;
  box.hidden = !(ORG.eligible > 0 || n) || (typeof HITS !== "undefined" && HITS !== null); // not between the search box and its results
  if (box.hidden) { box.innerHTML = ""; return; }
  const open = ORG_OPEN;
  box.innerHTML = html`<div class="panel ai organizepanel"><div class="orgbar"><div class="orgbar-text"><h2 id="org-h"><span class="chip ai">${S.ai_badge}</span> ${S.org_title}</h2>
    <p class="hint">${ORG.eligible ? fmt(S.org_intro, { n: ORG.eligible }) : ""}${n ? " " + fmt(S.org_intro_pending, { n }) : ""}</p></div>
    <button class="cta ai sm" id="org-run" type="button">${n ? S.org_run_again : S.org_run}</button></div>
    ${n ? html`<details id="org-details"${open ? raw(" open") : ""}><summary>${fmt(S.org_list_title, { n })}</summary><div id="org-list">${raw(proposalsListHtml(ORG.proposals, { heading: false }))}</div></details>` : ""}</div>`;
  const det = $("org-details");
  if (det) det.addEventListener("toggle", () => { ORG_OPEN = det.open; });
  $("org-run").addEventListener("click", () => startOrganize({}));
  if (typeof syncAiButtons === "function") syncAiButtons();
  bindProposals(box, orgChanged);
}

// ---------- the dialog: estimate -> confirmation -> live progress -> result ----------
function openOrgDialog() {
  const root = $("orgdlg"), panel = root.querySelector(".udpanel");
  panel.innerHTML = html`<h2 id="org-dlg-title"></h2><div id="org-dlg-body"></div>`;
  root.hidden = false;
  root._prev = document.activeElement;
  panel.focus();
  return { title: panel.querySelector("#org-dlg-title"), box: panel.querySelector("#org-dlg-body") };
}

function closeOrgDialog() {
  const root = $("orgdlg");
  if (!root || root.hidden) return;
  root.hidden = true;
  root.querySelector(".udpanel").innerHTML = "";
  if (root._prev && root._prev.isConnected && root._prev.focus) root._prev.focus();
}

document.addEventListener("keydown", (e) => {
  const root = $("orgdlg");
  if (e.key === "Escape" && root && !root.hidden && $("evidence").hidden && !root.querySelector(".pg-cancel:not([hidden])")) { e.preventDefault(); setAiBusy("organize", false); closeOrgDialog(); }
});

/** Starts "Organize with AI" (every unsorted session) or, with {sessions, titlesOnly}, "Name with AI" for one session. */
async function startOrganize(opts) {
  opts = opts || {};
  if (!aiOn()) { applyAiGate(); toast(S.org_needs_ai, null); return; }
  const titlesOnly = Boolean(opts.titlesOnly);
  setAiBusy("organize", true);
  const dlg = openOrgDialog();
  dlg.title.textContent = titlesOnly ? S.org_name_estimate : S.org_estimate_title;
  dlg.box.innerHTML = html`<p>${S.estimate_loading}</p>`;
  const query = (force) => { const q = new URLSearchParams(); if (opts.sessions) q.set("sessions", opts.sessions.join(",")); if (titlesOnly) q.set("titles", "1"); if (force) q.set("force", "1"); return q; };
  const close = () => { setAiBusy("organize", false); closeOrgDialog(); }; // re-enable the button first: focus cannot return to a disabled one
  try {
    const e = await api("/api/organize/estimate?" + query(false));
    if (e.cached) {
      dlg.box.innerHTML = html`<p>${S.org_cached_text}</p><div class="row"><button class="cta" id="org-show" type="button">${S.org_show_proposals}</button><button class="cta ai ghost" id="org-again" type="button">${fmt(S.org_ask_again, { usd: "~" + usd(e.usd_if_again || 0) })}</button><button class="cta ghost" id="org-no" type="button">${S.org_close}</button></div>`;
      $("org-no").addEventListener("click", close);
      $("org-show").addEventListener("click", () => { close(); showProposalsHome(); });
      $("org-again").addEventListener("click", async () => { const f = await api("/api/organize/estimate?" + query(true)); confirmRun(f, true); });
      return;
    }
    confirmRun(e, false);
  } catch (err) {
    dlg.box.innerHTML = html`<p class="err" role="alert">${S.error_prefix} ${err.message}</p><div class="row"><button class="cta ai sm" id="org-retry" type="button">${S.error_retry}</button><button class="cta ghost sm" id="org-no" type="button">${S.org_close}</button></div>`;
    $("org-retry").addEventListener("click", () => { close(); startOrganize(opts); });
    $("org-no").addEventListener("click", close);
  }

  function confirmRun(e, force) {
    const text = titlesOnly ? S.org_estimate_titles : S.org_estimate_text;
    dlg.box.innerHTML = html`<div class="panel ai"><h2><span class="chip ai">${S.ai_badge}</span></h2><p class="hint">${fmt(text, { tokens: fmtTokens(e.input_tokens + e.output_tokens), usd: "~" + usd(e.usd), calls: e.calls, sessions: e.sessions })}</p>
      <div class="row"><button class="cta ai" id="org-ok" type="button">${S.org_confirm}</button><button class="cta ghost" id="org-no" type="button">${S.cancel}</button></div></div>`;
    $("org-no").addEventListener("click", close);
    $("org-ok").addEventListener("click", () => {
      if (!aiOn()) { close(); applyAiGate(); return; }
      orgKeepOpen = false;
      runAiAction({
        box: dlg.box, path: "/api/organize", body: { confirm: true, sessions: opts.sessions || undefined, titlesOnly, force }, title: titlesOnly ? S.org_progress_name : S.org_progress_title,
        onDone: async (res) => {
          await refreshOrganize();
          refreshUsage();
          const used = fmt("{tokens}", { tokens: fmtTokens(res.usage.tokens) }), cost = "~" + usd(res.usage.cost_usd);
          if (titlesOnly) { // show the proposed name right here, with Accept / Edit / Reject
            const mine = ORG.proposals.filter((p) => p.type === "title" && p.sessions.some((s) => (opts.sessions || []).includes(s.id)));
            orgKeepOpen = true;
            dlg.box.innerHTML = html`<p class="okmsg" role="status">${mine.length ? fmt(S.org_done, { n: mine.length, tokens: used, usd: cost }) : fmt(S.org_done_name_none, { tokens: used, usd: cost })}</p>
              ${mine.length ? raw(proposalsListHtml(mine)) : ""}<div class="row"><button class="cta ghost sm" id="org-close" type="button">${S.org_close}</button></div>`;
            $("org-close").addEventListener("click", () => { orgKeepOpen = false; close(); renderOrganize(); });
            bindProposals(dlg.box, async (r, m) => { orgKeepOpen = false; close(); await orgChanged(r, m); });
            return;
          }
          renderOrganize();
          toast(ORG.proposals.length ? fmt(S.org_done, { n: ORG.proposals.length, tokens: used, usd: cost }) : fmt(S.org_done_none, { tokens: used, usd: cost }), null);
          showProposalsHome();
        },
        onEnd: () => { setAiBusy("organize", false); if (!orgKeepOpen) closeOrgDialog(); },
        onRetry: () => startOrganize(opts),
      });
    });
  }
}

/** Opens the proposals list on the home page and brings it into view. */
function showProposalsHome() {
  ORG_OPEN = true;
  if (location.hash) { location.hash = ""; return; } // the hashchange handler redraws the home page
  renderOrganize();
  const det = $("org-details");
  if (det) { det.scrollIntoView({ block: "start" }); const s = det.querySelector("summary"); if (s) s.focus({ preventScroll: true }); }
}
