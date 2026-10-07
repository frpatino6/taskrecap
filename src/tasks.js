// Scan sessions, group them into tasks, and cache generated capsules on disk.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KEY_REGEX } from './config.js';
import {
  GENERIC_BRANCHES, KEY_MIN_MENTIONS, UNASSIGNED, detectKey, parseSession, projectName, promptKeyCounts, redact,
} from './sessions.js';
import * as capsule from './capsule.js';

/** Light summary of one session file (the heavy prompt list is dropped after detection). */
export function summarizeSession(file, keyRegex) {
  const s = parseSession(file);
  const [key, method] = detectKey(s, keyRegex);
  const prompts = s.prompts;
  const branches = s.branches.mostCommon().map(([b]) => b).filter((b) => !GENERIC_BRANCHES.has(b));
  return {
    id: s.id, path: file, project: projectName(s), key, method,
    first_ts: s.first_ts, last_ts: s.last_ts, n_prompts: prompts.length, size: s.size,
    branch: branches[0] || '', title: s.title,
    snippet: prompts.length ? redact(prompts[0].text).replace(/\n/g, ' ').slice(0, 140) : '',
    mentions: Object.fromEntries(promptKeyCounts(s, keyRegex)),
  };
}

/** All sessions under `projectsDir`, parsed once per file version (path + mtime + size). */
export class SessionIndex {
  constructor(projectsDir, keyRegex = DEFAULT_KEY_REGEX) {
    this.projectsDir = projectsDir;
    this.keyRegex = keyRegex;
    this.cache = new Map();
  }

  listFiles() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path.join(this.projectsDir, d.name);
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const n of names) out.push(path.join(dir, n));
    }
    return out.sort();
  }

  sessions() {
    const out = [];
    for (const p of this.listFiles()) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const sig = `${st.mtimeMs}:${st.size}`;
      let hit = this.cache.get(p);
      if (!hit || hit.sig !== sig) {
        hit = { sig, summary: summarizeSession(p, this.keyRegex) };
        this.cache.set(p, hit);
      }
      if (hit.summary.n_prompts > 0) out.push(hit.summary); // empty sessions are noise
    }
    return out;
  }

  /** Sessions that belong to `key`: it is their main key, or their prompts cite it often enough. -> [[session, mode]] */
  taskSessions(key) {
    const out = [];
    for (const s of this.sessions()) {
      if (s.key === key || (s.mentions[key] || 0) >= KEY_MIN_MENTIONS) out.push([s, 'keyed']);
    }
    return out;
  }

  /** One entry per task key, newest activity first; 'unassigned' always last. */
  tasks(keyRegex = null) {
    const full = new RegExp(`^(?:${keyRegex || this.keyRegex})$`); // fullmatch, without touching the shared global regex
    const keys = new Map();
    for (const s of this.sessions()) {
      const names = new Set([s.key, ...Object.entries(s.mentions).filter(([, n]) => n >= KEY_MIN_MENTIONS).map(([k]) => k)]);
      for (const k of names) {
        if (!keys.has(k)) keys.set(k, []);
        keys.get(k).push(s);
      }
    }
    const out = [];
    for (const [k, ss] of keys) {
      ss.sort((a, b) => ((a.first_ts || '') < (b.first_ts || '') ? -1 : (a.first_ts || '') > (b.first_ts || '') ? 1 : 0));
      const kind = k === UNASSIGNED ? UNASSIGNED : (full.test(k) ? 'key' : 'branch');
      const firsts = ss.map((s) => s.first_ts).filter(Boolean);
      const lasts = ss.map((s) => s.last_ts).filter(Boolean);
      out.push({
        key: k, kind, sessions: ss.length,
        projects: [...new Set(ss.map((s) => s.project))].sort(),
        first_ts: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null,
        last_ts: lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
        snippet: ss[0].snippet, prompts: ss.reduce((a, s) => a + s.n_prompts, 0),
      });
    }
    out.sort((a, b) => ((b.last_ts || '') < (a.last_ts || '') ? -1 : (b.last_ts || '') > (a.last_ts || '') ? 1 : 0));
    out.sort((a, b) => (a.kind === UNASSIGNED) - (b.kind === UNASSIGNED)); // stable: 'unassigned' goes last
    return out;
  }
}

/** Sessions of the task with their loaded turns -> the input of capsule.generate(). */
export function planTask(index, key) {
  return index.taskSessions(key).map(([s, mode]) => ({
    path: s.path, turns: capsule.loadRichTurns(s.path, index.keyRegex), mode,
  }));
}

export function isGeneratable(key) {
  return key !== UNASSIGNED;
}

const safeName = (key) => key.replace(/[^\p{L}\p{N}_.-]/gu, '_');

/** Capsules cached as <dir>/<key>.json (+ .md). Reading is instant; nothing is regenerated unless asked. */
export class CapsuleStore {
  constructor(directory) {
    this.dir = directory;
    this.parsed = new Map(); // file name -> {sig, data}
    this.revision = 0; // bumped on every save / external change, even when mtime and size happen to stay the same
  }

  filePath(key, ext) {
    return path.join(this.dir, `${safeName(key)}.${ext}`);
  }

  load(key) {
    try {
      return JSON.parse(fs.readFileSync(this.filePath(key, 'json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Every cached capsule: [{key, ...result}] (small: one file per task). Files are parsed once per version
   * (name + mtime + size), so listing tasks only costs a directory scan; save() drops its entry right away.
   */
  all() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      this.parsed.clear();
      return [];
    }
    const seen = new Set(names);
    for (const n of [...this.parsed.keys()]) {
      if (!seen.has(n)) { // deleted capsule
        this.parsed.delete(n);
        this.revision += 1;
      }
    }
    const out = [];
    for (const n of names) {
      const file = path.join(this.dir, n);
      let sig;
      try {
        const st = fs.statSync(file);
        sig = `${st.mtimeMs}:${st.size}`;
      } catch {
        continue;
      }
      let hit = this.parsed.get(n);
      if (!hit || hit.sig !== sig) {
        let data = null;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          /* skip unreadable file */
        }
        hit = { sig, data };
        this.parsed.set(n, hit);
        this.revision += 1;
      }
      if (hit.data && hit.data.key) out.push(hit.data);
    }
    return out;
  }

  keys() {
    return new Set(this.all().map((d) => d.key));
  }

  /** Names + mtime + size of the cached capsules: the same on every run while nothing changed, so it can be persisted. */
  stableSignature() {
    this.all();
    return [...this.parsed].map(([n, h]) => `${n}:${h.sig}`).sort().join('|');
  }

  /**
   * Changes whenever a capsule is added, rewritten or deleted in this process, so derived indexes (search) know when to
   * rebuild. Cheap: it reuses all(), which only re-reads a capsule whose file changed.
   */
  signature() {
    const stable = this.stableSignature();
    return `${this.revision}|${stable}`;
  }

  save(key, result) {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamped = { ...result, generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
    fs.writeFileSync(this.filePath(key, 'json'), JSON.stringify(stamped, null, 1));
    fs.writeFileSync(this.filePath(key, 'md'), stamped.markdown || '');
    this.parsed.delete(path.basename(this.filePath(key, 'json'))); // next all() re-reads the new version
    return stamped;
  }
}
