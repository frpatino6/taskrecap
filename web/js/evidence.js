"use strict";
// ---------- evidence panel: the original messages behind a citation (free, local) ----------
let evOpener = null, evSeq = 0;
const evTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function evTurnHtml(t) {
  const user = t.user ? `<p class="evtext">${esc(t.user)}</p>` : `<p class="evtext muted">${esc(S.evidence_automatic)}</p>`;
  const reply = t.assistant ? `<span class="evrole">${esc(S.evidence_claude)}</span><p class="evtext">${esc(t.assistant)}</p>` : "";
  const cut = t.truncated && (t.truncated.user || t.truncated.assistant) ? `<p class="evextra">${esc(S.evidence_truncated)}</p>` : "";
  const files = (t.files || []).length ? `<div class="evextra">${esc(S.evidence_files)} ${t.files.map((f) => `<code>${esc(f)}</code>`).join("")}</div>` : "";
  const cmds = (t.commands || []).length ? `<div class="evextra">${esc(S.evidence_commands)} ${t.commands.map((c) => `<code>${esc(c)}</code>`).join("")}</div>` : "";
  return `<article class="evturn ${t.cited ? "cited" : "dim"}" data-cited="${t.cited ? "1" : "0"}"><h3>${esc(fmt(S.evidence_message, { n: t.turn }))}${t.ts ? " · " + esc(evTime(t.ts)) : ""}${t.cited ? " · " + esc(S.evidence_cited) : ""}</h3>` +
    `<span class="evrole">${esc(S.evidence_you)}</span>${user}${reply}${files}${cmds}${cut}</article>`;
}

function evPanelHtml(r) {
  const s = r.session;
  const meta = [[S.evidence_date, day(s.date)], [S.evidence_repo, s.project], [S.evidence_branch, s.branch], [S.evidence_folder, s.cwd], [S.evidence_total, s.turns_total]]
    .filter(([, v]) => v !== "" && v != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  return `<div class="evhead"><h2 id="ev-title">${esc(fmt(S.evidence_title, { session: s.id8, n: r.turn }))}</h2><button class="cta ghost" id="ev-close" type="button">${esc(S.evidence_close)}</button></div>` +
    (r.warning ? `<p class="evwarn" role="alert">${esc(S.evidence_unverified)}</p>` : "") +
    `<dl class="evmeta">${meta}</dl>` +
    (s.resume ? `<div class="evresume"><code id="ev-resume">${esc(s.resume)}</code><button class="cta" id="ev-copy" type="button">${esc(S.evidence_copy_resume)}</button></div><p class="note" style="margin:0 0 6px">${esc(S.evidence_resume_hint)}</p>` : "") +
    `<p class="note" style="margin:14px 0 0">${esc(S.evidence_context)}</p>` + r.turns.map(evTurnHtml).join("");
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

document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button.cite, button.msg");
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

