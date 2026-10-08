// Work units: what the home page lists. A unit is a task key, a branch, ONE session that has neither (a "session unit"),
// or a group the user made by hand ("user unit"). Everything here is free: no AI, no tokens.
//   key:<KEY>  branch:<name>  session:<id8>  user:<uuid>
// The user's corrections (rename, merge, move, split, hide) are stored as an append-only list of operations; the current
// state is always the fold of the operations that were not undone, so an undo is just "ignore that operation".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import { isNoise } from './segment.js';
import { KEY_MIN_MENTIONS, UNASSIGNED, redact } from './sessions.js';

export const MIN_WORDS = 4; // a message with fewer meaningful words carries no task ("hola", "resume", "/code-review")
export const TITLE_MAX = 80;
export const CONTENT_SCAN = 12; // how many of a session's first messages are looked at to decide it has content
export const RELATED_GAP_MS = 2 * 60 * 60 * 1000;
export const MAX_LABEL = 120;
export const OVERRIDES_VERSION = 1;
const MAX_OPS = 5000;

// ---------- what counts as a real message ----------
const TAG_BLOCK = /<(ide_[a-z_]+|system-reminder|local-command-[a-z]+|command-[a-z]+|task-notification|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ANY_TAG = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?\/?>/gi;
const COMMAND = /^\/[a-z][\w:-]*(?:\s+|$)/i;
const GREETING = /^(?:hola|hi|hello|hey|buenas|buenos d[ií]as|buenas tardes|buenas noches|good (?:morning|afternoon|evening)|thanks|thank you|gracias|ok|okay)\b/i;

/** Number of words with at least one letter ("a1b2" counts, "12 34" does not). */
export function wordCount(text) {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).filter((w) => /\p{L}/u.test(w)).length;
}

/**
 * The part of a user message that says what the work is, or '' when there is none: editor tags (<ide_opened_file>...),
 * slash commands, greetings, "resume" and anything shorter than MIN_WORDS words are not tasks.
 */
export function meaningfulText(raw) {
  let t = String(raw || '').replace(TAG_BLOCK, ' ').replace(ANY_TAG, ' ').replace(/\s+/g, ' ').trim();
  if (!t || isNoise(t)) return '';
  if (COMMAND.test(t)) t = t.replace(COMMAND, '').trim(); // "/code-review high": the arguments alone are not enough
  if (!t) return '';
  if (GREETING.test(t) && t.length <= 40) return '';
  return wordCount(t) >= MIN_WORDS ? t : '';
}

/** `text` on one line, at most `max` characters, cut at a word when possible and closed with an ellipsis. */
export function cutTitle(text, max = TITLE_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space >= Math.floor(max / 2)) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

/** Title of a session unit: Claude Code's own title, else the first meaningful message (redacted, <= 80 chars), else null. */
export function sessionTitle(s) {
  const own = redact(String(s.title || '')).replace(/\s+/g, ' ').trim();
  if (own) return cutTitle(own);
  for (const p of (s.prompts || []).slice(0, 30)) {
    const m = meaningfulText(p.text);
    if (m) return cutTitle(redact(m));
  }
  return null;
}

/** Does the session have any real content? (its own title, or a meaningful message among the first CONTENT_SCAN) */
export function hasContent(s) {
  if (String(s.title || '').trim()) return true;
  return (s.prompts || []).slice(0, CONTENT_SCAN).some((p) => meaningfulText(p.text));
}

// ---------- the user's corrections ----------
export const emptyState = () => ({
  labels: new Map(), merges: new Map(), moves: new Map(), hiddenUnits: new Set(), hiddenSessions: new Set(),
});

const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length < 400;

/** Fold the operations that were not undone into the current corrections. Unknown or malformed operations are skipped. */
export function foldOps(ops) {
  const st = emptyState();
  for (const op of ops || []) {
    if (!op || op.undone) continue;
    try {
      if (op.type === 'rename' && isStr(op.unit)) {
        const label = String(op.label || '').trim().slice(0, MAX_LABEL);
        if (label) st.labels.set(op.unit, label); else st.labels.delete(op.unit);
      } else if (op.type === 'merge' && isStr(op.unit) && Array.isArray(op.members)) {
        const m = st.merges.get(op.unit) || { members: [], label: null };
        for (const k of op.members) if (isStr(k) && k !== op.unit && !m.members.includes(k)) m.members.push(k);
        if (op.label) m.label = String(op.label).trim().slice(0, MAX_LABEL);
        st.merges.set(op.unit, m);
      } else if (op.type === 'split' && isStr(op.unit)) {
        st.merges.delete(op.unit);
        st.labels.delete(op.unit);
        st.hiddenUnits.delete(op.unit);
        for (const [sid, to] of [...st.moves]) if (to === op.unit) st.moves.delete(sid);
      } else if (op.type === 'move' && isStr(op.session) && isStr(op.to)) {
        st.moves.set(op.session, op.to);
      } else if (op.type === 'hide' && (isStr(op.unit) || isStr(op.session))) {
        const set = isStr(op.unit) ? st.hiddenUnits : st.hiddenSessions;
        const id = isStr(op.unit) ? op.unit : op.session;
        if (op.hidden === false) set.delete(id); else set.add(id);
      }
    } catch {
      /* a malformed operation never breaks the rest */
    }
  }
  return st;
}

/**
 * Persistent corrections: a versioned JSON file, written atomically (temp file + rename) and never touched by rescans.
 * A damaged file is moved aside (`.corrupt-<time>`) and the app starts with no corrections instead of failing.
 */
export class Overrides {
  constructor(file = null) {
    this.file = file;
    this.data = null;
    this.corrupt = null; // where a damaged file was moved to
    this.revision = 0;
  }

  load() {
    if (this.data) return this.data;
    this.data = { version: OVERRIDES_VERSION, ops: [] };
    if (!this.file) return this.data;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this.data; // no file yet
    }
    try {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object' || !Array.isArray(d.ops)) throw new Error('bad shape');
      if (typeof d.version === 'number' && d.version > OVERRIDES_VERSION) throw new Error('written by a newer version');
      this.data = { version: OVERRIDES_VERSION, ops: d.ops.filter((o) => o && typeof o === 'object' && typeof o.id === 'string') };
    } catch {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
        this.corrupt = aside;
      } catch {
        /* cannot move it: keep going without corrections; the next save overwrites */
      }
    }
    return this.data;
  }

  ops() {
    return this.load().ops;
  }

  state() {
    return foldOps(this.ops());
  }

  /** Same text on every run while the active corrections do not change: usable inside persisted cache signatures. */
  signature() {
    const active = this.ops().filter((o) => !o.undone).map((o) => [o.type, o.unit, o.session, o.to, o.label, o.hidden, o.members]);
    return crypto.createHash('sha1').update(JSON.stringify(active)).digest('hex').slice(0, 12);
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** Append operations that belong together (one batch = one undo). -> the batch id */
  add(list) {
    const data = this.load();
    if (data.ops.length + list.length > MAX_OPS) throw new UserError('Too many corrections stored. Undo or delete some first.');
    const batch = crypto.randomUUID();
    const ts = new Date().toISOString();
    for (const op of list) data.ops.push({ id: crypto.randomUUID(), batch, ts, ...op });
    this.save();
    this.revision += 1;
    return batch;
  }

  /** Undo a whole batch (by batch id or by the id of one of its operations); no argument = the latest one. -> the undone operations */
  undo(ref = null) {
    const data = this.load();
    const active = data.ops.filter((o) => !o.undone);
    if (!active.length) throw new UserError('Nothing to undo.');
    let batch;
    if (ref) {
      const hit = active.find((o) => o.id === ref || o.batch === ref);
      if (!hit) throw new UserError('That change was already undone or does not exist.');
      batch = hit.batch;
    } else {
      batch = active[active.length - 1].batch;
    }
    const undone = [];
    for (const o of data.ops) if (o.batch === batch && !o.undone) { o.undone = true; undone.push(o); }
    this.save();
    this.revision += 1;
    return undone;
  }

  /** The latest change that can still be undone: {batch, type, ops} | null */
  last() {
    const active = this.ops().filter((o) => !o.undone);
    if (!active.length) return null;
    const batch = active[active.length - 1].batch;
    const ops = active.filter((o) => o.batch === batch);
    const main = ops.find((o) => o.type !== 'move') || ops[0];
    return { batch, type: main.type, count: active.length, ops };
  }
}

// ---------- building the units ----------
/** Shortest id prefix (8 characters, longer only if two sessions collide) of every session. -> Map(sessionId -> short id) */
export function shortIds(sessions) {
  const out = new Map();
  let pending = sessions;
  for (let len = 8; pending.length; len += 4) {
    const counts = new Map();
    for (const s of pending) counts.set(s.id.slice(0, len), (counts.get(s.id.slice(0, len)) || 0) + 1);
    const next = [];
    for (const s of pending) {
      const p = s.id.slice(0, len);
      if (counts.get(p) === 1 || len >= s.id.length) out.set(s.id, p); else next.push(s); // colliding sessions get a longer prefix, together
    }
    pending = next;
  }
  return out;
}

export const isSessionKey = (key) => /^session:/.test(String(key));
export const isUserKey = (key) => /^user:/.test(String(key));
/** Only task keys and branches can have a capsule for now; session and user units are read through their Sessions list. */
export const isGeneratableKey = (key) => !isSessionKey(key) && !isUserKey(key) && key !== UNASSIGNED;

/** The `id` of a unit: key:<KEY>, branch:<name>, session:<id8>, user:<uuid>. */
export const unitId = (key, source) => (source === 'key' ? `key:${key}` : source === 'branch' ? `branch:${key}` : key);

/**
 * sessions: summaries (see summarizeSession). state: foldOps(). -> {units: Map(key -> unit), hiddenSessions: [summary]}
 * unit: {key, id, source, label, renamed, hidden, noise, mergedFrom, members: [[view, 'keyed']]}
 * A session belongs to ONE session unit; to the unit of its key and of every key its messages cite often enough; or to the
 * unit the user moved it to. A "view" of a session is the summary with `key` set to the unit it is read as.
 */
export function buildUnits(sessions, state, { keyRegex }) {
  const full = new RegExp(`^(?:${keyRegex})$`);
  const ids = shortIds(sessions);
  const base = new Map(); // key -> {source, entries: Map(sessionId -> {s, mode})}
  const hiddenSessions = [];
  const put = (map, key, source, s, mode) => {
    if (!map.has(key)) map.set(key, { source, entries: new Map() });
    map.get(key).entries.set(s.id, { s, mode });
  };
  const autoPlace = (s) => {
    if (s.key === UNASSIGNED) { put(base, `session:${ids.get(s.id)}`, 'session', s, 'main'); return; }
    const cited = Object.entries(s.mentions || {}).filter(([, n]) => n >= KEY_MIN_MENTIONS).map(([k]) => k);
    for (const k of new Set([s.key, ...cited])) put(base, k, full.test(k) ? 'key' : 'branch', s, k === s.key ? 'main' : 'mention');
  };

  const byId = new Map();
  for (const s of sessions) {
    if (state.hiddenSessions.has(s.id)) { hiddenSessions.push(s); continue; }
    byId.set(s.id, s);
    if (!state.moves.has(s.id)) autoPlace(s);
  }
  const userKeys = new Set(state.merges.keys());
  const pendingToUser = [];
  for (const [sid, to] of state.moves) { // sessions the user moved: into a unit that exists, a group, or back where they were
    const s = byId.get(sid);
    if (!s) continue;
    if (userKeys.has(to)) pendingToUser.push([s, to]);
    else if (base.has(to)) base.get(to).entries.set(s.id, { s, mode: 'forced' });
    else autoPlace(s); // the target is gone (its sessions moved or were hidden): the session returns to its own unit
  }

  const users = new Map();
  const mergedAway = new Set();
  for (const [ukey, m] of state.merges) {
    const entries = new Map();
    const from = [];
    for (const mk of m.members) {
      const b = base.get(mk);
      if (!b) continue;
      mergedAway.add(mk);
      from.push(mk);
      for (const [sid, e] of b.entries) entries.set(sid, { s: e.s, mode: 'forced' });
    }
    users.set(ukey, { source: 'user', entries, from, label: m.label });
  }
  for (const [s, to] of pendingToUser) users.get(to).entries.set(s.id, { s, mode: 'forced' });

  const units = new Map();
  const add = (key, source, entries, extra) => {
    if (!entries.size) return;
    const members = [...entries.values()].map((e) => [e.mode === 'mention' ? e.s : (e.s.key === key ? e.s : { ...e.s, key }), 'keyed']);
    const label = state.labels.get(key) || null;
    units.set(key, {
      key, id: unitId(key, source), source, hidden: state.hiddenUnits.has(key), members, renamed: Boolean(label),
      label, mergedFrom: [], noise: false, ...extra,
    });
  };
  for (const [key, b] of base) {
    if (mergedAway.has(key)) continue;
    const extra = {};
    if (b.source === 'session') {
      const s = [...b.entries.values()][0].s;
      extra.sessionTitle = s.unit_title || null;
      extra.noise = !s.has_content;
    }
    add(key, b.source, b.entries, extra);
  }
  for (const [key, u] of users) add(key, 'user', u.entries, { mergedFrom: u.from, defaultLabel: u.label || null });
  return { units, hiddenSessions };
}

// ---------- "Related": a pure hint, never a grouping ----------
/**
 * Two session units are related when they are in the same repo and a message of one was written within RELATED_GAP_MS of a
 * message of the other. At most `limit` per unit, nearest first. Never merges anything.
 * items: [{key, label, project, times: [epoch ms, sorted]}] -> Map(key -> [{key, label, gap_ms}])
 */
export function relatedUnits(items, { gap = RELATED_GAP_MS, limit = 2 } = {}) {
  const out = new Map();
  const byProject = new Map();
  for (const it of items) {
    if (!it.times.length) continue;
    if (!byProject.has(it.project)) byProject.set(it.project, []);
    byProject.get(it.project).push(it);
  }
  const nearest = (a, b) => {
    let i = 0, j = 0, best = Infinity;
    while (i < a.length && j < b.length) {
      best = Math.min(best, Math.abs(a[i] - b[j]));
      if (best === 0) return 0;
      if (a[i] < b[j]) i += 1; else j += 1;
    }
    return best;
  };
  const push = (from, to, d) => {
    if (!out.has(from.key)) out.set(from.key, []);
    out.get(from.key).push({ key: to.key, label: to.label, gap_ms: d });
  };
  for (const group of byProject.values()) {
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const d = nearest(group[x].times, group[y].times);
        if (d <= gap) { push(group[x], group[y], d); push(group[y], group[x], d); }
      }
    }
  }
  for (const [k, list] of out) out.set(k, list.sort((a, b) => a.gap_ms - b.gap_ms).slice(0, limit));
  return out;
}
