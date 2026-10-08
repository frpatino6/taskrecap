"use strict";
// ---------- work units: names, groups and the corrections menu (free, local; every change can be undone) ----------
let HIDDEN = { units: [], sessions: [] };
let EMPTY_OPEN = false; // the folded "Sessions without content" group keeps its state between renders

/** What a unit is called on the page: its name, or (a session with no title yet) "Short session in <repo> · <date>". */
function unitTitle(t) {
  if (t.label) return t.label;
  if (t.kind === "key" || t.kind === "branch") return t.key;
  if (t.kind === "user") return S.unit_fallback_group;
  const repo = (t.projects && t.projects[0]) || t.project || "";
  const when = t.first_ts ? day(t.first_ts) : t.first ? day(t.first + "T12:00:00") : "";
  return fmt(S.unit_fallback_session, { repo, date: when });
}

/** Chips that say where a unit comes from: guessed (one session) or made by the user. */
function unitChips(t) {
  if (t.kind === "session") return `<span class="chip unsorted" title="${esc(S.unit_unsorted_tip)}">${esc(S.chip_unsorted)}</span>`;
  if (t.kind === "user") return `<span class="chip grouped" title="${esc(S.unit_group_tip)}">${esc(S.chip_group)}</span>`;
  return "";
}

/** "Related: ..." on a card: a hint only (same repo, within 2 hours). It never changes the grouping. */
function relatedLine(t) {
  const r = t.related || [];
  if (!r.length) return "";
  return `<span class="related" title="${esc(S.related_tip)}">${esc(S.related)}: ${esc(r.map((x) => x.label).join(" · "))}</span>`;
}

// ---------- the floating menu ----------
let MENU = null;
function closeMenu(restore = true) {
  const m = $("unitmenu");
  if (!m || m.hidden) return;
  m.hidden = true;
  m.innerHTML = "";
  if (restore && MENU && MENU.btn && MENU.btn.isConnected) MENU.btn.focus();
  if (MENU && MENU.btn) MENU.btn.setAttribute("aria-expanded", "false");
  MENU = null;
}

/** items: [{label, run, danger?, disabled?}] */
function showMenu(btn, items) {
  closeMenu(false);
  const m = $("unitmenu");
  m.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" class="${it.danger ? "danger" : ""}" data-i="${i}"${it.disabled ? " disabled" : ""}>${esc(it.label)}</button>`).join("");
  m.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  m.style.top = Math.max(8, r.bottom + h + 12 > innerHeight ? r.top - h - 6 : r.bottom + 6) + "px";
  MENU = { btn, items };
  const first = m.querySelector("button:not([disabled])");
  if (first) first.focus();
}

document.addEventListener("click", (e) => {
  const m = $("unitmenu");
  if (!m || m.hidden) return;
  const item = e.target.closest("#unitmenu button[data-i]");
  if (item && MENU) {
    const it = MENU.items[Number(item.dataset.i)];
    closeMenu(false);
    if (it && !it.disabled) it.run();
    return;
  }
  if (!e.target.closest(".cardmenu, .lanemenu, .sessmenu, .detailmenu")) closeMenu(false);
});
document.addEventListener("keydown", (e) => {
  const m = $("unitmenu");
  if (!m || m.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
  if (e.key === "Tab") { closeMenu(false); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const btns = [...m.querySelectorAll("button:not([disabled])")];
  const at = btns.indexOf(document.activeElement);
  btns[(at + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length].focus();
});

// ---------- dialogs (no window.prompt / confirm: they block the page and cannot be styled or tested) ----------
/** body: trusted HTML built with esc(); onConfirm(panel) may throw: the message is shown and the dialog stays open. */
function openDialog({ title, body, confirm, danger = false, onConfirm }) {
  const root = $("unitdlg"), panel = root.querySelector(".udpanel"), prev = document.activeElement;
  panel.innerHTML = html`<h2 id="ud-title">${title}</h2><div class="udbody">${raw(body)}</div><p class="err" id="ud-err" role="alert" hidden></p>
    <div class="row"><button class="cta${danger ? " danger" : ""}" id="ud-ok" type="button">${confirm}</button><button class="cta ghost" id="ud-cancel" type="button">${S.cancel}</button></div>`;
  root.hidden = false;
  const close = () => {
    root.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    if (prev && prev.isConnected && prev.focus) prev.focus();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); $("ud-ok").click(); return; }
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll("input, select, button:not([disabled])")];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  $("ud-cancel").addEventListener("click", close);
  $("ud-backdrop").onclick = close;
  $("ud-ok").addEventListener("click", async () => {
    const ok = $("ud-ok"), err = $("ud-err");
    ok.disabled = true;
    err.hidden = true;
    try { await onConfirm(panel); close(); }
    catch (e) { err.textContent = e.message; err.hidden = false; ok.disabled = false; }
  });
  const firstField = panel.querySelector("input, select");
  (firstField || $("ud-ok")).focus();
  if (firstField && firstField.select) firstField.select();
}

// ---------- the "Changed. Undo" notice ----------
let toastTimer = null;
function toast(message, undo) {
  const el = $("toast");
  el.innerHTML = html`<span>${message}</span>${undo ? html`<button type="button" class="linkbtn" id="toast-undo">${S.undo}</button>` : ""}`;
  el.hidden = false;
  const b = $("toast-undo");
  if (b) b.addEventListener("click", () => undoChange(undo.batch));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 14000);
}

// ---------- talking to the server ----------
const postUnits = (action, body) => api("/api/units/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const onUnitPage = (key) => location.hash === "#/task/" + encodeURIComponent(key);

/** After any correction: reload the list and the hidden items, say what happened (with Undo) and redraw the current page. */
async function afterChange(res, message, { go } = {}) {
  TASKS = (await api("/api/tasks")).tasks;
  await refreshHidden();
  toast(message, res && res.undo);
  const here = location.hash.match(/^#\/task\/(.+)$/);
  if ((go === undefined || go === null) && here && !unitByKey(decodeURIComponent(here[1]))) go = ""; // the unit we are looking at no longer exists (an undo, a split): back to the list
  if (go !== undefined && go !== null) {
    const hash = go === "" ? "" : "#/task/" + encodeURIComponent(go);
    if (location.hash === hash || (hash === "" && !location.hash)) { await route(); return; }
    location.hash = hash; // the hashchange handler redraws
    return;
  }
  await route();
}

async function undoChange(batch) {
  try {
    const res = await postUnits("undo", { batch });
    await afterChange(res, S.undone_msg);
  } catch (e) { toast(e.message, null); }
}

const unitByKey = (key) => TASKS.find((t) => t.key === key) || HIDDEN.units.find((t) => t.key === key) || null;
const nameOf = (key) => { const t = unitByKey(key); return t ? unitTitle(t) : key; };

// ---------- the corrections ----------
function renameDialog(key) {
  const t = unitByKey(key);
  openDialog({
    title: S.rename_title, confirm: S.rename_confirm,
    body: `<label class="udfield" for="ud-name">${esc(S.rename_label)}</label><input id="ud-name" type="text" maxlength="120" value="${esc(t && t.label ? t.label : "")}" placeholder="${esc(t ? unitTitle(t) : "")}"><p class="note">${esc(S.rename_hint)}</p>`,
    onConfirm: async (p) => { const res = await postUnits("rename", { key, label: p.querySelector("#ud-name").value }); await afterChange(res, S.renamed_msg); },
  });
}

function mergeDialog(key) {
  const me = unitByKey(key);
  const others = TASKS.filter((t) => t.key !== key && !(me && me.kind === "user" && t.kind === "user"));
  if (!others.length) { toast(S.merge_none, null); return; }
  const label = (t) => `${unitTitle(t)} (${S["kind_" + t.kind] || t.kind})`;
  openDialog({
    title: fmt(S.merge_title, { name: nameOf(key) }), confirm: S.merge_confirm,
    body: `<label class="udfield" for="ud-target">${esc(S.merge_pick)}</label><select id="ud-target">${others.map((t) => `<option value="${esc(t.key)}">${esc(label(t))}</option>`).join("")}</select>` +
      `<label class="udfield" for="ud-name">${esc(S.merge_name)}</label><input id="ud-name" type="text" maxlength="120"><p class="note">${esc(S.merge_note)}</p>`,
    onConfirm: async (p) => {
      const target = p.querySelector("#ud-target").value;
      const res = await postUnits("merge", { keys: [key, target], label: p.querySelector("#ud-name").value });
      await afterChange(res, S.merged_msg, { go: onUnitPage(key) || onUnitPage(target) ? res.unit : undefined });
    },
  });
}

/** Move one session to another unit or to a new group. `from` = the unit it is read under now. */
function moveDialog(sessionId, from) {
  const others = TASKS.filter((t) => t.key !== from);
  openDialog({
    title: S.move_title, confirm: S.move_confirm,
    body: `<label class="udfield" for="ud-target">${esc(S.move_pick)}</label><select id="ud-target"><option value="new">${esc(S.move_new)}</option>` +
      others.map((t) => `<option value="${esc(t.key)}">${esc(unitTitle(t))} (${esc(S["kind_" + t.kind] || t.kind)})</option>`).join("") + `</select>` +
      `<label class="udfield" id="ud-name-l" for="ud-name">${esc(S.move_name)}</label><input id="ud-name" type="text" maxlength="120"><p class="note">${esc(S.move_note)}</p>`,
    onConfirm: async (p) => {
      const to = p.querySelector("#ud-target").value;
      const res = await postUnits("move", { session: sessionId, to, label: p.querySelector("#ud-name").value });
      const stay = onUnitPage(from) ? (TASKS.find((t) => t.key === from) && (TASKS.find((t) => t.key === from).sessions > 1) ? undefined : res.unit) : undefined;
      await afterChange(res, S.moved_msg, { go: stay });
    },
  });
  const sel = $("ud-target"), nameField = $("ud-name"), nameLabel = $("ud-name-l");
  const sync = () => { const show = sel.value === "new"; nameField.hidden = !show; nameLabel.hidden = !show; };
  sel.addEventListener("change", sync);
  sync();
}

function hideDialog(key, hidden) {
  if (!hidden) { postUnits("hide", { key, hidden: false }).then((r) => afterChange(r, S.unhidden_msg)).catch((e) => toast(e.message, null)); return; }
  openDialog({
    title: fmt(S.hide_title, { name: nameOf(key) }), confirm: S.hide_confirm, danger: true,
    body: `<p>${esc(S.hide_text)}</p>`,
    onConfirm: async () => { const res = await postUnits("hide", { key }); await afterChange(res, S.hidden_msg, { go: onUnitPage(key) ? "" : undefined }); },
  });
}

function splitDialog(key) {
  openDialog({
    title: fmt(S.split_title, { name: nameOf(key) }), confirm: S.split_confirm, danger: true,
    body: `<p>${esc(S.split_text)}</p>`,
    onConfirm: async () => { const res = await postUnits("split", { key }); await afterChange(res, S.split_msg, { go: onUnitPage(key) ? "" : undefined }); },
  });
}

function hideSessionDialog(sessionId, from) {
  openDialog({
    title: S.hide_session_title, confirm: S.hide_confirm, danger: true,
    body: `<p>${esc(S.hide_session_text)}</p>`,
    onConfirm: async () => {
      const res = await postUnits("hide", { session: sessionId });
      const left = (TASKS.find((t) => t.key === from) || {}).sessions;
      await afterChange(res, S.hidden_msg, { go: onUnitPage(from) && left <= 1 ? "" : undefined });
    },
  });
}

async function undoItem() {
  let last = null;
  try { last = (await api("/api/units/history")).last; } catch (e) { /* menu still opens, Undo stays off */ }
  return { label: last ? fmt(S.menu_undo, { what: S["change_" + last.type] || last.type }) : S.menu_undo_none, run: () => last && undoChange(last.batch), disabled: !last };
}

/** The ⋯ menu of a unit (card, timeline lane or the page of the unit). */
async function openUnitMenu(btn, key) {
  const t = unitByKey(key);
  if (!t) return;
  const items = [{ label: S.menu_rename, run: () => renameDialog(key) }, { label: S.menu_merge, run: () => mergeDialog(key) }];
  if (t.sessions === 1 && (t.session_ids || []).length === 1) items.push({ label: S.menu_move, run: () => moveDialog(t.session_ids[0], key) });
  if (t.can_split) items.push({ label: S.menu_split, run: () => splitDialog(key), danger: true });
  const isHidden = HIDDEN.units.some((h) => h.key === key);
  items.push(isHidden ? { label: S.menu_unhide, run: () => hideDialog(key, false) } : { label: S.menu_hide, run: () => hideDialog(key, true), danger: true });
  items.push(await undoItem());
  showMenu(btn, items);
}

/** The ⋯ menu of one session row in the page of a unit. */
async function openSessionMenu(btn) {
  const id = btn.dataset.sess, from = btn.dataset.from;
  showMenu(btn, [
    { label: S.menu_move_session, run: () => moveDialog(id, from) },
    { label: S.menu_hide_session, run: () => hideSessionDialog(id, from), danger: true },
    await undoItem(),
  ]);
}

// ---------- the folded group of sessions without content, and the hidden items ----------
function emptyRow(t) {
  const title = t.snippet ? t.snippet.slice(0, 70) : S.empty_row_fallback;
  return html`<div class="emptyrow"><button type="button" class="emptyopen" data-key="${t.key}"><span class="et">${title}</span>
    <span class="chip repo">${(t.projects && t.projects[0]) || ""}</span><span class="chip">${day(t.first_ts)}</span></button>
    <button type="button" class="cardmenu" data-menu="${t.key}" aria-haspopup="menu" aria-expanded="false" aria-label="${fmt(S.menu_label, { name: title })}">⋯</button></div>`;
}

function renderEmptyGroup(units) {
  const box = $("emptygroup");
  box.hidden = !units.length;
  if (!units.length) { box.innerHTML = ""; return; }
  box.innerHTML = html`<details id="emptydet"${EMPTY_OPEN ? raw(" open") : ""}><summary>${fmt(S.empty_group_title, { n: units.length })}</summary>
    <p class="note">${S.empty_group_note}</p><div class="emptylist">${units.map(emptyRow)}</div></details>`;
  $("emptydet").addEventListener("toggle", () => { EMPTY_OPEN = $("emptydet").open; });
  bindUnitButtons(box);
}

async function refreshHidden() {
  try { HIDDEN = await api("/api/units/hidden"); } catch (e) { HIDDEN = { units: [], sessions: [] }; }
  const box = $("hiddenbox"), n = HIDDEN.units.length + HIDDEN.sessions.length;
  box.hidden = !n;
  if (!n) { box.innerHTML = ""; return; }
  const open = box.querySelector("details") && box.querySelector("details").open;
  box.innerHTML = html`<details${open ? raw(" open") : ""}><summary>${fmt(S.hidden_title, { n })}</summary><div class="emptylist">
    ${HIDDEN.units.map((t) => html`<div class="emptyrow"><span class="et">${unitTitle(t)}</span><span class="chip">${S["kind_" + t.kind] || t.kind}</span><button type="button" class="cta ghost sm" data-unhide-unit="${t.key}">${S.unhide}</button></div>`)}
    ${HIDDEN.sessions.map((s) => html`<div class="emptyrow"><span class="et">${(s.title || "").slice(0, 70) || s.id8}</span><span class="chip repo">${s.project}</span><span class="chip">${day(s.first_ts)}</span><button type="button" class="cta ghost sm" data-unhide-session="${s.id}">${S.unhide}</button></div>`)}
    </div></details>`;
  box.querySelectorAll("[data-unhide-unit]").forEach((b) => b.addEventListener("click", () => hideDialog(b.dataset.unhideUnit, false)));
  box.querySelectorAll("[data-unhide-session]").forEach((b) => b.addEventListener("click", () => postUnits("hide", { session: b.dataset.unhideSession, hidden: false }).then((r) => afterChange(r, S.unhidden_msg)).catch((e) => toast(e.message, null))));
}

/** Buttons that open a unit and the ⋯ menus inside `root`. */
function bindUnitButtons(root) {
  root.querySelectorAll(".emptyopen").forEach((b) => b.addEventListener("click", () => { location.hash = "#/task/" + encodeURIComponent(b.dataset.key); }));
  root.querySelectorAll(".cardmenu[data-menu]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openUnitMenu(b, b.dataset.menu); }));
}
