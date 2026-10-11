"use strict";
// ---------- evidence panel: the original messages behind a citation (free, local) ----------
let evOpener = null, evSeq = 0, evSession = "", evMade = [];
const evTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function evTurnHtml(t) {
  const res = fileResolver(PROMPT_FILES);
  const user = t.user ? `<div class="evtext md">${renderMarkdown(t.user, res)}</div>` : `<p class="evtext muted">${esc(S.evidence_automatic)}</p>`;
  const reply = t.assistant ? `<span class="evrole">${esc(S.evidence_claude)}</span><div class="evtext md">${renderMarkdown(t.assistant, res)}</div>` : "";
  const cut = t.truncated && (t.truncated.user || t.truncated.assistant) ? `<p class="evextra">${esc(S.evidence_truncated)}</p>` : "";
  const files = (t.files || []).length ? `<div class="evextra">${esc(S.evidence_files)} ${t.files.map((f) => fileLink(res(f) || f.replace(/^(~\/|\.\/)/, ""), `<code>${esc(f)}</code>`, !res(f))).join("")}</div>` : "";
  const cmds = (t.commands || []).length ? `<div class="evextra">${esc(S.evidence_commands)} ${t.commands.map((c) => `<code>${plainHtml(c, res)}</code>`).join("")}</div>` : "";
  return `<article class="evturn ${t.cited ? "cited" : "dim"}" data-cited="${t.cited ? "1" : "0"}"><h3>${esc(fmt(S.evidence_message, { n: t.turn }))}${t.ts ? " · " + esc(evTime(t.ts)) : ""}${t.cited ? " · " + esc(S.evidence_cited) : ""}</h3>` +
    `<span class="evrole">${esc(S.evidence_you)}</span>${user}${reply}${files}${cmds}${cut}</article>`;
}

/** "Files Claude created" list of the session: created first, then edited. Pure (no DOM). */
function evMadeHtml(made) {
  if (!(made || []).length) return "";
  const rows = made.map((f, i) => `<li class="evfile"><span class="evfilemain">${fileLink(f.short, esc(f.short), false)}<span class="evkind">${esc(f.kind === "created" ? S.evidence_made_created : S.evidence_made_edited)}</span></span>` +
    `<span class="evpath muted" title="${esc(f.path)}">${esc(f.path)}</span>` +
    `<span class="evfileact"><button class="cta ghost" type="button" data-act="reveal" data-i="${i}">${esc(S.evidence_made_open)}</button><button class="cta ghost" type="button" data-act="copypath" data-i="${i}">${esc(S.evidence_made_copy)}</button></span></li>`).join("");
  return `<section class="evmade"><h3>${esc(S.evidence_made_title)}</h3><ul>${rows}</ul><p class="note evmadenote" id="ev-made-msg" role="status"></p></section>`;
}

async function evMadeAction(btn) {
  const f = evMade[Number(btn.dataset.i)], msg = $("ev-made-msg");
  if (!f || !msg) return;
  const say = (t, bad) => { msg.textContent = t; msg.classList.toggle("err", !!bad); };
  if (btn.dataset.act === "copypath") {
    try { await navigator.clipboard.writeText(f.path); say(S.evidence_made_copied); } catch (e) { say(S.copy_failed, true); }
    return;
  }
  try {
    const r = await api("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: evSession, path: f.path }) });
    if (r.ok) say(r.opened === f.path ? S.evidence_made_opened : S.evidence_made_opened_parent);
    else say(r.error || S.evidence_made_failed, true);
  } catch (err) { say(err.message || S.evidence_made_failed, true); }
}

function evPanelHtml(r) {
  const s = r.session;
  const meta = [[S.evidence_date, day(s.date)], [S.evidence_repo, s.project], [S.evidence_branch, s.branch], [S.evidence_folder, s.cwd], [S.evidence_total, s.turns_total]]
    .filter(([, v]) => v !== "" && v != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  return `<div class="evhead"><h2 id="ev-title">${esc(fmt(S.evidence_title, { session: s.id8, n: r.turn }))}</h2><button class="cta ghost" id="ev-close" type="button">${esc(S.evidence_close)}</button></div>` +
    (r.warning ? `<p class="evwarn" role="alert">${esc(S.evidence_unverified)}</p>` : "") +
    `<dl class="evmeta">${meta}</dl>` +
    (s.resume ? `<div class="evresume"><code id="ev-resume">${esc(s.resume)}</code><button class="cta" id="ev-copy" type="button">${esc(S.evidence_copy_resume)}</button></div><p class="note" style="margin:0 0 6px">${esc(S.evidence_resume_hint)}</p>` : "") +
    `<p class="note" style="margin:14px 0 0">${esc(S.evidence_context)}</p>` + r.turns.map(evTurnHtml).join("") + evMadeHtml(r.session.made);
}

function evCloseHandlers() {
  $("ev-close").addEventListener("click", closeEvidence);
  const copy = $("ev-copy");
  if (copy) copy.addEventListener("click", async () => {
    const old = copy.textContent;
    try { await navigator.clipboard.writeText($("ev-resume").textContent); copy.textContent = S.evidence_copied; }
    catch (e) { copy.textContent = S.copy_failed; const r = document.createRange(); r.selectNodeContents($("ev-resume")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    setTimeout(() => { copy.textContent = old; }, 2400);
  });
}

async function openEvidence(btn) {
  const seq = ++evSeq, panel = $("ev-panel");
  evOpener = btn;
  $("evidence").hidden = false;
  document.documentElement.style.setProperty("--banner-h", $("banner").offsetHeight + "px");
  document.body.classList.add("evopen");
  panel.innerHTML = html`<div class="evhead"><h2 id="ev-title">${S.evidence_loading}</h2><button class="cta ghost" id="ev-close" type="button">${S.evidence_close}</button></div>`;
  evCloseHandlers();
  panel.focus();
  const q = new URLSearchParams({ session: btn.dataset.session, turn: btn.dataset.turn, context: "2" });
  if (btn.dataset.key) q.set("key", btn.dataset.key);
  try {
    const r = await api("/api/evidence?" + q);
    if (seq !== evSeq) return; // a newer click is already showing
    evMade = r.session.made || [];
    evSession = r.session.id;
    panel.innerHTML = evPanelHtml(r);
    evCloseHandlers();
    const cited = panel.querySelector('.evturn[data-cited="1"]');
    if (cited) cited.scrollIntoView({ block: "center" });
    $("ev-close").focus();
  } catch (err) {
    if (seq !== evSeq) return;
    panel.innerHTML = html`<div class="evhead"><h2 id="ev-title">${fmt(S.evidence_title, { session: btn.dataset.session, n: btn.dataset.turn })}</h2><button class="cta ghost" id="ev-close" type="button">${S.evidence_close}</button></div><p class="err" role="alert">${err.message}</p><p class="note">${S.evidence_error_hint}</p>`;
    evCloseHandlers();
    $("ev-close").focus();
  }
}

function closeEvidence() {
  evSeq += 1; // ignore any answer still on its way
  $("evidence").hidden = true;
  document.body.classList.remove("evopen");
  if (evOpener && document.contains(evOpener)) evOpener.focus();
  evOpener = null;
}

/** A file path inside a prompt: close the panel and show that file's tasks in the files section of the task. */
function openPromptFile(btn) {
  closeEvidence();
  const box = $("filebox");
  if (!box) return;
  showFileTasks(btn.dataset.file, SESS.key);
  box.scrollIntoView({ block: "center" });
}

document.addEventListener("click", (e) => {
  const m = e.target.closest && e.target.closest("#ev-panel button[data-act]");
  if (m) { evMadeAction(m); return; }
  const f = e.target.closest && e.target.closest("#ev-panel button.filelink");
  if (f) { openPromptFile(f); return; }
  const b = e.target.closest && e.target.closest("button.cite, button.msg, button.msghit");
  if (b) openEvidence(b);
});
$("ev-backdrop").addEventListener("click", closeEvidence);
document.addEventListener("keydown", (e) => {
  if ($("evidence").hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closeEvidence(); return; }
  if (e.key !== "Tab") return; // keep keyboard focus inside the open panel
  const items = [...$("ev-panel").querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])")];
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === $("ev-panel"))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

