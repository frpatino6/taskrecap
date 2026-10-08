// Progress events for AI actions. The pipeline reports what it is really doing; the server streams the events
// to the page. Events carry a `code` + `vars` (the sentence lives in web/strings.<lang>.json), never English text.
/** Checklist shown by the page for each action, in pipeline order. */
export const STAGES = {
  generate: ['scan', 'redact', 'votes', 'merge', 'evidence', 'write', 'validate', 'save'],
  search: ['catalog', 'ask', 'rank'],
  organize: ['org_scan', 'org_ask', 'org_validate', 'org_save'],
};

const noop = () => {};

/** status: running | done | skipped | error | cancelled. `code`/`vars` describe the outcome (a strings key + values). */
export function stage(emit, id, status, code = null, vars = {}) {
  (emit || noop)({ type: 'stage', id, status, code, vars });
}

export function log(emit, code, vars = {}, level = 'info') {
  (emit || noop)({ type: 'log', code, vars, level });
}

/**
 * Wraps a sink so every event gets a timestamp and the running usage of the action (tokens / cost so far).
 * `reporter.fail(status)` marks the stages still running (an error or a cancel interrupted them).
 */
export function makeReporter(sink, usageFn = null) {
  const running = new Set();
  const emit = (event) => {
    if (event.type === 'stage') {
      if (event.status === 'running') running.add(event.id);
      else running.delete(event.id);
    }
    if (sink) sink({ ...event, ts: new Date().toISOString(), usage: usageFn ? usageFn() : null });
  };
  emit.fail = (status = 'error') => {
    for (const id of [...running]) emit({ type: 'stage', id, status });
  };
  return emit;
}

export const clip = (text, n = 140) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Emits at most one event every `ms` milliseconds (the streamed answer arrives in many tiny pieces). */
export function throttle(fn, ms = 300) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

const unescape = (raw) => {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
};

const SECTIONS = { dead_ends: 'dead_end', left_out: 'left_out', pending: 'pending' };
const FIELD_RX = /"(objective|result|decision|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Finds the capsule items Claude has finished writing in the answer streamed so far (the JSON is incomplete).
 * Call it with the whole text each time; it returns only the NEW findings: [{kind, text}].
 * kind: objective | timeline | decision | dead_end | left_out | pending. These are drafts: citations are checked later.
 */
export function makeFindingsScanner() {
  let seen = 0;
  return (text) => {
    const all = [...String(text || '').matchAll(FIELD_RX)];
    const out = [];
    for (const m of all.slice(seen)) {
      const field = m[1];
      let kind = null;
      if (field === 'objective') kind = 'objective';
      else if (field === 'result') kind = 'timeline';
      else if (field === 'decision') kind = 'decision';
      else {
        let best = -1;
        for (const name of Object.keys(SECTIONS)) {
          const at = text.lastIndexOf(`"${name}"`, m.index);
          if (at > best) {
            best = at;
            kind = SECTIONS[name];
          }
        }
        if (best < 0) kind = null;
      }
      const value = unescape(m[2]).trim();
      if (kind && value) out.push({ kind, text: value });
    }
    seen = all.length;
    return out;
  };
}

const MATCH_RX = /"key"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** Same idea for the AI search answer: new {key, reason} pairs Claude has finished writing. */
export function makeMatchScanner() {
  let seen = 0;
  return (text) => {
    const all = [...String(text || '').matchAll(MATCH_RX)];
    const out = all.slice(seen).map((m) => ({ key: unescape(m[1]), reason: unescape(m[2]) }));
    seen = all.length;
    return out;
  };
}
