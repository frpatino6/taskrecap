// File -> tasks index: which tasks touched a file. Free and local (no AI), persisted so it is not rebuilt every request.
//
// Two sources, never mixed for the same task:
//  - the task's capsule (accurate: final vs reverted, only the turns that belong to the task);
//  - for tasks without a capsule, the files Claude edited in the task's sessions, read straight from the transcripts.
//    This is APPROXIMATE (a session can cover several tasks), so every such link is flagged and says how it was derived.
// Files are keyed by `<repo>/<path inside repo>`, so the same name in two repos never collides (and two clones of one
// repo, or its agent worktrees, count as the same repo). Changes made outside Claude sessions are invisible.
import fs from 'node:fs';
import path from 'node:path';
import { isWorkFile, loadRichTurns, shortPath } from './capsule.js';
import { fold } from './search.js';

const VERSION = 1;
export const BASIS = { capsule: 'capsule', session: 'session', mention: 'mention' };

/**
 * Edits Claude made in one session transcript, read once and persisted per session.
 * -> {edits: [{short, turn, ts}], keyTurns: {KEY: first turn that cites it}}
 */
export function sessionEdits(file, keyRegex) {
  const turns = loadRichTurns(file, keyRegex);
  const edits = [];
  const keyTurns = {};
  turns.forEach((t, i) => {
    for (const k of t.keys) if (!(k in keyTurns)) keyTurns[k] = i;
    for (const f of new Set(t.files)) if (isWorkFile(f)) edits.push({ short: shortPath(f, t.cwd), turn: i, ts: t.ts || '' });
  });
  return { edits, keyTurns };
}

/**
 * Links of one task from its sessions: every edit of a session whose main key is the task; for a session that only
 * cites the task, just the edits from the first prompt that cites it onwards. -> Map(short -> {edits, last})
 */
export function sessionLinks(sessions) {
  const out = new Map();
  for (const { main, data, key } of sessions) {
    const from = main ? 0 : (data.keyTurns[key] ?? Infinity);
    for (const e of data.edits) {
      if (e.turn < from) continue;
      const cur = out.get(e.short) || { edits: 0, last: '', basis: main ? BASIS.session : BASIS.mention };
      cur.edits += 1;
      if (e.ts > cur.last) cur.last = e.ts;
      if (main) cur.basis = BASIS.session; // any whole-session edit outranks "from the first mention"
      out.set(e.short, cur);
    }
  }
  return out;
}

export class FileIndex {
  /**
   * @param {import('./tasks.js').SessionIndex} index
   * @param {import('./tasks.js').CapsuleStore} store
   * @param {string|null} file where the index is persisted (null = memory only)
   */
  constructor(index, store, file = null) {
    this.index = index;
    this.store = store;
    this.file = file;
    this.cur = null; // {sig, files: {short: [{key, status, edits, last, basis, approximate}]}}
    this.sessions = null; // path -> {sig, edits, keyTurns} (persisted: unchanged sessions are never re-read)
    this.parsed = 0; // how many session transcripts were read (for tests / diagnostics)
    this.rev = undefined; // capsule store revision the current index was built at
  }

  sessionSig(p) {
    try {
      const st = fs.statSync(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  load() {
    if (this.sessions) return;
    this.sessions = {};
    this.cur = null;
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.version === VERSION && d.key_regex === String(this.index.keyRegex)) {
        this.sessions = d.sessions || {};
        this.cur = d.sig && d.files ? { sig: d.sig, files: d.files } : null;
      }
    } catch {
      /* no index yet, or unreadable: rebuild */
    }
  }

  /** The index, rebuilt only when a session file or a capsule changed since it was last built. */
  get() {
    this.load();
    const paths = this.index.sessions().map((s) => s.path); // sessions with prompts, already summarised
    const sigs = new Map(paths.map((p) => [p, this.sessionSig(p)]));
    const sig = `${this.store.stableSignature()}#${paths.map((p) => `${p}:${sigs.get(p)}`).join('|')}`; // stable: it is persisted
    const rev = this.store.revision;
    // `rev` also catches a capsule rewritten with the same mtime and size; the first call trusts the persisted index
    if (this.cur && this.cur.sig === sig && (this.rev === undefined || this.rev === rev)) {
      this.rev = rev;
      return this.cur;
    }
    this.rev = rev;

    const data = {};
    for (const p of paths) {
      const prev = this.sessions[p];
      if (!prev || prev.sig !== sigs.get(p)) {
        data[p] = { sig: sigs.get(p), ...sessionEdits(p, this.index.keyRegex) };
        this.parsed += 1;
      } else {
        data[p] = prev;
      }
    }
    this.sessions = data; // sessions that disappeared are dropped here
    this.cur = { sig, files: this.build(data) };
    this.rev = this.store.revision; // build() may have read capsules
    this.save();
    return this.cur;
  }

  build(data) {
    const files = {};
    const add = (short, e) => (files[short] || (files[short] = [])).push(e);
    const caps = new Map(this.store.all().map((c) => [c.key, c]));
    for (const t of this.index.tasks()) {
      const cap = caps.get(t.key);
      if (cap) {
        const seen = new Set();
        for (const f of cap.files || []) {
          if (seen.has(f.short)) continue;
          seen.add(f.short);
          add(f.short, { key: t.key, status: f.status === 'reverted' ? 'reverted' : 'final', edits: f.edits || 0, last: f.last || '', basis: BASIS.capsule, approximate: false });
        }
        continue;
      }
      const sessions = this.index.taskSessions(t.key).map(([s]) => ({ main: s.key === t.key, data: data[s.path], key: t.key })).filter((s) => s.data);
      for (const [short, l] of sessionLinks(sessions)) add(short, { key: t.key, status: 'edited', edits: l.edits, last: l.last, basis: l.basis, approximate: true });
    }
    return files;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, key_regex: String(this.index.keyRegex), sig: this.cur.sig, files: this.cur.files, sessions: this.sessions }));
      fs.renameSync(tmp, this.file);
    } catch {
      /* a read-only cache dir only costs a rebuild next time */
    }
  }

  /** Tasks that touched exactly this file (`<repo>/<path>`): capsule links first, then approximate ones, newest first. */
  tasksOf(short) {
    const list = [...(this.get().files[short] || [])];
    return list.sort((a, b) => (a.approximate - b.approximate) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  }

  /**
   * Files whose path contains every word of `query` (accents and case ignored). Empty query = the files shared by the
   * most tasks. -> {files: [{path, tasks: [...]}], total}
   */
  find(query, limit = 40) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const all = this.get().files;
    const rows = Object.entries(all)
      .filter(([short]) => {
        const f = fold(short);
        return words.every((w) => f.includes(w));
      })
      .map(([short, tasks]) => ({ path: short, tasks }));
    rows.sort((a, b) => (new Set(b.tasks.map((t) => t.key)).size - new Set(a.tasks.map((t) => t.key)).size) || (a.path < b.path ? -1 : 1));
    return { files: rows.slice(0, limit), total: rows.length };
  }
}
