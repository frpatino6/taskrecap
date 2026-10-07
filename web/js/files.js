"use strict";
// ---------- files -> tasks (free, local) ----------
const gotoTask = (root) => root.querySelectorAll("button.tasklink").forEach((b) => b.addEventListener("click", () => { location.hash = "#/task/" + encodeURIComponent(b.dataset.key); }));
const statusLabel = (st) => S["files_status_" + st] || st;
const clip = (t, n) => (String(t || "").length > n ? String(t).slice(0, n) + "…" : String(t || ""));

/** Accurate (from a capsule) or approximate (from raw sessions), with how it was derived on hover. */
function linkBadge(l) {
  return l.approximate
    ? `<span class="chip warn" title="${esc(S["files_basis_" + l.basis] || "")}">${esc(S.files_badge_approx)}</span>`
    : `<span class="chip done" title="${esc(S.files_basis_capsule)}">${esc(S.files_badge_capsule)}</span>`;
}

function taskRow(l) {
  return `<li><button class="tasklink" type="button" data-key="${esc(l.key)}"><strong>${esc(l.key)}</strong>` +
    `<span class="chip">${esc(statusLabel(l.status))}</span>${l.edits ? `<span class="chip">${esc(l.edits)}×</span>` : ""}${linkBadge(l)}` +
    `<span class="t">${esc(clip(l.text, 140))}</span></button></li>`;
}

async function showFileTasks(file, key) {
  const box = $("filebox");
  box.innerHTML = html`<p class="note">${S.files_loading}</p>`;
  try {
    const r = await api("/api/files/tasks?path=" + encodeURIComponent(file));
    const others = r.tasks.filter((t) => t.key !== key);
    box.innerHTML = html`<div class="panel filepanel fade-in" role="region" aria-label="${fmt(S.files_other_title, { file })}"><h3>${fmt(S.files_other_title, { file })}</h3>${others.length ? html`<ul class="filetasks">${others.map((t) => raw(taskRow(t)))}</ul>` : html`<p>${S.files_none_other}</p>`}<p class="note">${S.files_incomplete_note}</p></div>`;
    gotoTask(box);
  } catch (err) { box.innerHTML = html`<p class="err" role="alert">${S.error_prefix} ${err.message}</p>`; }
}

let filesTimer = null;
async function loadFiles() {
  const q = $("fq").value.trim(), box = $("filelist");
  try {
    const r = await api("/api/files?q=" + encodeURIComponent(q));
    if ($("fq").value.trim() !== q) return; // a newer query is already running
    const head = q ? fmt(S.files_find_results, { shown: r.files.length, total: r.total }) : S.files_find_top;
    box.innerHTML = r.files.length
      ? html`<p class="note" style="margin:10px 0 0">${head}</p><ul class="filerows">${r.files.map((f) => html`<li><code>${f.path}</code>${f.tasks.map((t) => html`<button class="tasklink inline" type="button" data-key="${t.key}" title="${statusLabel(t.status)}">${t.key}${t.approximate ? " ~" : ""}</button>`)}</li>`)}</ul><p class="note">${S.files_incomplete_note}</p>`
      : html`<p class="note" style="margin:10px 0 0">${S.files_find_none}</p>`;
    gotoTask(box);
  } catch (err) { box.innerHTML = html`<p class="err" role="alert">${S.error_prefix} ${err.message}</p>`; }
}

