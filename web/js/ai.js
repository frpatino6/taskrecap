"use strict";
// ---------- live progress for AI actions ----------
const ICON = { pending: "○", done: "✓", skipped: "–", error: "✕", cancelled: "■" };
const mmss = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

/** The server sends a code + values; the sentence comes from the strings file (so it can be translated). */
function eventText(ev) {
  const tpl = S["ev_" + ev.code];
  if (!tpl) return ev.code || "";
  const v = Object.assign({}, ev.vars);
  if (v.tokens != null) v.tokens = fmtTokens(v.tokens);
  if (v.chars != null) v.chars = Number(v.chars).toLocaleString();
  if (v.reason != null) v.reason = v.reason ? " " + v.reason + "." : "";
  return fmt(tpl, v);
}

/** POST and read the NDJSON progress stream line by line. Rejects on HTTP errors; aborting `signal` stops the server-side work. */
async function streamPost(path, body, signal, onEvent) {
  const r = await fetch(path, { method: "POST", signal, headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(body) });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || r.statusText); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  const flush = (final) => {
    let i;
    while ((i = buf.indexOf("\n")) >= 0 || (final && buf.trim())) {
      const line = i >= 0 ? buf.slice(0, i) : buf;
      buf = i >= 0 ? buf.slice(i + 1) : "";
      if (line.trim()) onEvent(JSON.parse(line));
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    flush(false);
  }
  flush(true);
}

/**
 * Runs an AI action with a live panel: checklist of the real pipeline stages, activity log, elapsed time, running
 * tokens/cost and a Cancel button that really stops the work on the server.
 * o: {box, title, path, body, onMatch(ev, el), onDone(result), onEnd(), onRetry()}
 */
function runAiAction(o) {
  const abort = new AbortController(), t0 = Date.now();
  let over = false, cancelled = false, result = null, failure = null, usageNow = null, callsSeen = 0, writing = 0;
  o.box.innerHTML = html`<div class="panel ai progress fade-in" role="group">
    <div class="pg-head"><span class="spinner" aria-hidden="true"></span><h2 class="pg-title"></h2><span class="pg-time" role="timer" aria-label="${S.progress_elapsed}">0:00</span></div>
    <p class="pg-usage"></p>
    <ol class="pg-stages"></ol>
    <div class="pg-matches" hidden><h3>${S.progress_matches}</h3></div>
    <details open><summary>${S.progress_activity}</summary><ul class="pg-log" role="log" aria-live="polite"></ul></details>
    <p class="sr pg-say" aria-live="polite"></p>
    <div class="pg-end"></div>
    <div class="row"><button class="cta ghost pg-cancel" type="button">${S.progress_cancel}</button></div></div>`;
  const q = (sel) => o.box.querySelector(sel);
  q(".pg-title").textContent = o.title;
  q(".pg-usage").textContent = S.progress_starting;
  const timer = setInterval(() => { q(".pg-time").textContent = mmss(Date.now() - t0); }, 1000);

  const say = (t) => { q(".pg-say").textContent = t; };
  const label = (id) => S["stage_" + id] || id;
  const addLog = (text, level) => {
    const li = document.createElement("li"), tm = document.createElement("time");
    if (level === "warn") li.className = "warn";
    tm.textContent = mmss(Date.now() - t0);
    li.append(tm, document.createTextNode(text));
    const ul = q(".pg-log"); ul.append(li); ul.scrollTop = ul.scrollHeight;
  };
  const showUsage = () => {
    const parts = [usageNow && usageNow.calls ? fmt(S.progress_usage, { tokens: fmtTokens(usageNow.tokens), usd: "~" + usd(usageNow.cost_usd) }) : S.progress_usage_none];
    if (writing) parts.push(fmt(S.progress_writing, { tokens: fmtTokens(writing) }));
    q(".pg-usage").textContent = parts.join(" · ");
  };
  const buildStages = (ids) => {
    q(".pg-stages").innerHTML = html`${ids.map((id) => html`<li data-id="${id}" data-status="pending"><span class="pg-ico" aria-hidden="true">${ICON.pending}</span><span class="pg-label">${label(id)}</span><span class="sr pg-st">${S.st_pending}</span><span class="pg-detail"></span></li>`)}`;
  };
  const setStage = (id, status, detail) => {
    const li = q(`.pg-stages [data-id="${id}"]`);
    if (!li) return;
    li.dataset.status = status;
    li.querySelector(".pg-ico").textContent = ICON[status] || "";
    li.querySelector(".pg-st").textContent = S["st_" + status] || status;
    if (detail) li.querySelector(".pg-detail").textContent = detail;
    say(label(id) + " — " + (detail || S["st_" + status] || status));
  };
  const stop = () => { over = true; clearInterval(timer); q(".pg-head").classList.add("ended"); q(".pg-cancel").hidden = true; };
  const showEnd = (message, withRetry) => {
    q(".pg-end").innerHTML = html`${message}<div class="row" style="margin-top:12px">${withRetry ? html`<button class="cta ai pg-retry" type="button">${S.progress_retry}</button>` : ""}<button class="cta ghost pg-close" type="button">${S.progress_close}</button></div>`;
    q(".pg-close").addEventListener("click", () => { o.box.innerHTML = ""; o.onEnd(); });
    const retry = q(".pg-retry");
    if (retry) retry.addEventListener("click", () => { o.box.innerHTML = ""; o.onEnd(); o.onRetry(); });
  };

  function onEvent(ev) {
    if (ev.usage) {
      usageNow = ev.usage;
      if (ev.usage.calls > callsSeen) { callsSeen = ev.usage.calls; refreshUsage(); } // header counter follows each finished call
    }
    if (ev.type === "start") buildStages(ev.stages || []);
    else if (ev.type === "stage") {
      const text = ev.code ? eventText(ev) : "";
      setStage(ev.id, ev.status, text);
      if (text) addLog(text);
      if (ev.status !== "running") writing = 0;
    } else if (ev.type === "log") addLog(eventText(ev), ev.level);
    else if (ev.type === "progress") writing = ev.approx_tokens || 0;
    else if (ev.type === "match" && o.onMatch) { const el = q(".pg-matches"); el.hidden = false; o.onMatch(ev, el); }
    else if (ev.type === "done") result = ev.result;
    else if (ev.type === "error") failure = ev.message;
    showUsage();
  }

  q(".pg-cancel").addEventListener("click", () => {
    if (over) return;
    cancelled = true;
    q(".pg-cancel").disabled = true;
    q(".pg-cancel").textContent = S.progress_cancelling;
    abort.abort(); // closing the connection makes the server kill the claude processes and save nothing
    stop();
    o.box.querySelectorAll('.pg-stages [data-status="running"]').forEach((li) => setStage(li.dataset.id, "cancelled"));
    showEnd(html`<p class="note" role="status">${S.progress_cancelled}</p>`, true);
    setTimeout(refreshUsage, 600);
  });

  (async () => {
    try {
      await streamPost(o.path, o.body, abort.signal, onEvent);
      if (failure) throw new Error(failure);
      if (result == null) throw new Error(S.progress_closed);
      stop();
      await o.onDone(result);
      o.onEnd();
    } catch (err) {
      if (cancelled) return;
      stop();
      o.box.querySelectorAll('.pg-stages [data-status="running"]').forEach((li) => setStage(li.dataset.id, "error"));
      showEnd(html`<p class="err" role="alert">${S.progress_failed} ${err.message}</p>`, true);
      refreshUsage();
    }
  })();
}

// ---------- AI search (uses tokens: estimate first, confirm, then show real usage) ----------
function renderAiResults(res) {
  const byKey = new Map(TASKS.map((t) => [t.key, t]));
  const items = res.matches.map((m) => ({ t: byKey.get(m.key) || m.task, reason: m.reason })).filter((x) => x.t);
  $("airesults").classList.add("fade-in");
  $("airesults").innerHTML = html`<h2>${fmt(S.ai_results_title, { query: res.query })}</h2><p class="t" style="margin:0 0 12px">${fmt(S.ai_results_usage, { tokens: fmtTokens(res.usage.tokens), usd: "~" + usd(res.usage.cost_usd) })} <button class="back" id="ai-clear" type="button" style="padding:0">${S.ai_clear}</button></p>${items.length ? html`<div class="grid">${items.map((x) => raw(card(x.t, { reason: x.reason })))}</div>` : html`<p class="empty">${S.ai_no_matches}</p>`}`;
  bindCards($("airesults"));
  $("ai-clear").addEventListener("click", () => { $("airesults").innerHTML = ""; });
}

async function startAiSearch() {
  if (!aiOn()) { applyAiGate(); return; } // Claude Code is not (or not yet known to be) there: never start a request
  const q = $("q").value.trim(), box = $("aibox");
  if (!q) { box.innerHTML = html`<p class="err" role="alert">${S.ai_search_empty}</p>`; return; }
  setAiBusy("search", true);
  box.innerHTML = html`<p>${S.estimate_loading}</p>`;
  try {
    const e = await api("/api/ai-search/estimate?q=" + encodeURIComponent(q));
    box.innerHTML = html`<div class="panel ai"><h2><span class="chip ai">${S.ai_badge}</span></h2>
      <p class="hint">${fmt(S.ai_estimate_text, { tokens: fmtTokens(e.input_tokens + e.output_tokens), usd: "~" + usd(e.usd), tasks: e.tasks })}</p>
      <div class="row"><button class="cta ai" id="ai-ok" type="button">${S.confirm_generate}</button><button class="cta ghost" id="ai-no" type="button">${S.cancel}</button></div></div>`;
    $("ai-no").addEventListener("click", () => { box.innerHTML = ""; setAiBusy("search", false); });
    $("ai-ok").addEventListener("click", () => {
      if (!aiOn()) { box.innerHTML = ""; setAiBusy("search", false); applyAiGate(); return; }
      runAiAction({
        box, path: "/api/ai-search", body: { query: q, confirm: true }, title: fmt(S.progress_searching, { query: q }),
        onMatch: (ev, el) => {
          const t = TASKS.find((x) => x.key === ev.key), row = document.createElement("div"), open = document.createElement("button");
          row.className = "pg-match";
          open.type = "button"; open.textContent = ev.key;
          open.addEventListener("click", () => { location.hash = "#/task/" + encodeURIComponent(ev.key); });
          row.append(open, document.createTextNode(ev.reason || (t ? t.snippet : "")));
          el.append(row);
        },
        onDone: (res) => {
          renderAiResults(res);
          box.innerHTML = html`<p class="okmsg" role="status">${fmt(S.progress_done_generate, { tokens: fmtTokens(res.usage.tokens), usd: "~" + usd(res.usage.cost_usd) })}</p>`; // aibox is a polite live region
          refreshUsage();
        },
        onEnd: () => { setAiBusy("search", false); },
        onRetry: startAiSearch,
      });
    });
  } catch (err) {
    box.innerHTML = html`<p class="err" role="alert">${S.error_prefix} ${err.message}</p><div class="row"><button class="cta ai sm" id="ai-retry" type="button">${S.error_retry}</button></div>`;
    $("ai-retry").addEventListener("click", startAiSearch); // the estimate failed: nothing was spent, asking again is safe
    setAiBusy("search", false);
  }
}

