// Scan sessions, group them into tasks, and cache generated capsules on disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KEY_REGEX } from './config.js';
import {
  GENERIC_BRANCHES, KEY_MIN_MENTIONS, detectKey, findKeys, localDay, parseSession, projectName, promptDays, promptKeyCounts, redact,
} from './sessions.js';
import { messageList } from './messages.js';
import * as capsule from './capsule.js';
import { isNoise } from './segment.js';
import { buildUnits, cutTitle, emptyState, hasContent, isGeneratableKey, isKeylessKey, meaningfulText, relatedUnits, sessionTitle, stripTags, unitId } from './units.js';

/**
 * When the user's own messages were written, in epoch ms (automatic ones such as "[Request interrupted" are left out):
 * all of them, and for each key they cite the messages that cite it. Feeds the "outdated capsule" check, which is free.
 */
export function promptTimes(s, keyRegex) {
  const all = [];
  const byKey = {};
  for (const p of s.prompts) {
    const ms = Date.parse(p.ts);
    if (!p.ts || Number.isNaN(ms) || isNoise(p.text)) continue;
    all.push(ms);
    for (const k of new Set(findKeys(p.text, keyRegex))) (byKey[k] || (byKey[k] = [])).push(ms);
  }
  return { all, byKey };
}

/** Light summary of one session file (the heavy prompt list is dropped after detection). */
export function summarizeSession(file, keyRegex, generic = GENERIC_BRANCHES) {
  const s = parseSession(file);
  const [key, method] = detectKey(s, keyRegex, generic);
  const prompts = s.prompts;
  const branches = s.branches.mostCommon().map(([b]) => b).filter((b) => !generic.has(b));
  const mentions = Object.fromEntries(promptKeyCounts(s, keyRegex));
  const { days, keyDays } = promptDays(s, keyRegex);
  // days with prompts of the session, and, for each secondary key it cites often enough, the days of the prompts citing it
  const mentionDays = Object.fromEntries(Object.entries(keyDays).filter(([k]) => (mentions[k] || 0) >= KEY_MIN_MENTIONS));
  const times = promptTimes(s, keyRegex);
  const mentionTimes = Object.fromEntries(Object.entries(times.byKey).filter(([k]) => (mentions[k] || 0) >= KEY_MIN_MENTIONS));
  return {
    id: s.id, path: file, project: projectName(s), key, method,
    first_ts: s.first_ts, last_ts: s.last_ts, n_prompts: prompts.length, size: s.size,
    branch: branches[0] || '', title: s.title,
    unit_title: sessionTitle(s), has_content: hasContent(s), // the name of a session unit, and whether it is more than noise
    snippet: prompts.length ? redact(stripTags(prompts[0].text)).slice(0, 140) : '', // editor tags are not part of what the user said
    mentions, days, mention_days: mentionDays, prompt_ts: times.all, mention_ts: mentionTimes,
  };
}

/**
 * Is the capsule of `key` out of date? Counts the user's messages written AFTER `generatedAt` in the sessions of the task
 * (for a session the task only shares with others, only the messages that cite the key). Free: no AI, no file reading,
 * because the message times are already in the session summaries. A capsule without a usable date is never guessed at.
 * `sessions` are the sessions of the unit as it reads them (see SessionIndex.unitViews): for a session, a group of the user's or a
 * part of a session every message counts; the part only has the messages of its own range.
 * -> {known, new_messages, new_sessions, by_session: {sessionId: n}}
 */
export function capsuleStaleness(sessions, key, generatedAt) {
  const out = { known: false, new_messages: 0, new_sessions: 0, by_session: {} };
  const since = Date.parse(generatedAt);
  if (!generatedAt || Number.isNaN(since)) return out;
  out.known = true;
  for (const s of sessions) {
    const mine = s.key === key ? s.prompt_ts : (s.mentions[key] || 0) >= KEY_MIN_MENTIONS ? (s.mention_ts || {})[key] : null;
    if (!mine || !mine.length) continue;
    const fresh = mine.filter((t) => t > since).length;
    if (!fresh) continue;
    out.by_session[s.id] = fresh;
    out.new_messages += fresh;
    if (fresh === mine.length) out.new_sessions += 1; // every message of the task in this session is newer than the capsule
  }
  return out;
}

/**
 * Days with prompts of task `key`: [{day, n, project}] oldest first. A session counts fully for its main key; for any other
 * key it cites it only counts the prompts that cite it. A session mixing tasks therefore marks both, so dates are approximate.
 */
export function taskActivity(key, sessions) {
  const cells = new Map();
  for (const s of sessions) {
    const days = s.key === key ? s.days : (s.mention_days && s.mention_days[key]) || {};
    for (const [day, n] of Object.entries(days || {})) {
      const id = `${day}\u0000${s.project}`;
      const cell = cells.get(id) || { day, n: 0, project: s.project };
      cell.n += n;
      cells.set(id, cell);
    }
  }
  return [...cells.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}

/**
 * The messages first..last of a session as a unit of their own: the same summary fields as summarizeSession, computed from
 * those messages only. null when they hold no real message (nothing worth listing). Free: reads the cached message list.
 */
export function rangeSummary(s, first, last, keyRegex) {
  const rows = messageList(s.path, keyRegex).filter((m) => m.turn >= first && m.turn <= last && !m.noise);
  if (!rows.length) return null;
  const meaningful = rows.map((m) => meaningfulText(m.text)).find(Boolean) || '';
  if (!meaningful) return null;
  const days = {};
  for (const m of rows) {
    const d = localDay(m.ts);
    if (d) days[d] = (days[d] || 0) + 1;
  }
  const stamps = rows.map((m) => m.ts).filter(Boolean).sort();
  return {
    ...s, key: s.key, first_ts: stamps[0] || s.first_ts, last_ts: stamps[stamps.length - 1] || s.last_ts, n_prompts: rows.length,
    unit_title: cutTitle(redact(meaningful)), has_content: true, snippet: redact(stripTags(rows[0].text)).slice(0, 140),
    mentions: {}, days, mention_days: {}, prompt_ts: rows.map((m) => m.ms).filter((ms) => ms != null), mention_ts: {},
  };
}

/** All sessions under `projectsDir`, parsed once per file version (path + mtime + size). */
export class SessionIndex {
  /** `overrides`: the user's corrections (see units.js); `genericBranches`: extra branch names that mean "no task". */
  constructor(projectsDir, keyRegex = DEFAULT_KEY_REGEX, { overrides = null, genericBranches = null } = {}) {
    this.projectsDir = projectsDir;
    this.keyRegex = keyRegex;
    this.overrides = overrides;
    this.generic = genericBranches && genericBranches.length ? new Set([...GENERIC_BRANCHES, ...genericBranches]) : GENERIC_BRANCHES;
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
        hit = { sig, summary: summarizeSession(p, this.keyRegex, this.generic) };
        this.cache.set(p, hit);
      }
      if (hit.summary.n_prompts > 0) out.push(hit.summary); // empty sessions are noise
    }
    return out;
  }

  /**
   * Units and the sessions in each, after the user's corrections: {units: Map(key -> unit), hiddenSessions}. See buildUnits.
   * Built once per state of the sessions and corrections (session summaries are the same objects until a file changes).
   */
  unitMap() {
    const sessions = this.sessions();
    const rev = this.overrides ? this.overrides.revision : 0;
    const memo = this.memo;
    if (memo && memo.rev === rev && memo.overrides === this.overrides && memo.sessions.length === sessions.length && memo.sessions.every((s, i) => s === sessions[i])) return memo.value;
    const value = buildUnits(sessions, this.overrides ? this.overrides.state() : emptyState(), {
      keyRegex: this.keyRegex,
      rangeView: (s, a, b) => rangeSummary(s, a, b, this.keyRegex),
      turnCount: (s) => messageList(s.path, this.keyRegex).length,
    });
    this.memo = { sessions, rev, overrides: this.overrides, value };
    return value;
  }

  /** The sessions of unit `key` as the unit reads them (a part of a session carries only its own messages). */
  unitViews(key) {
    return this.taskSessions(key).map(([s]) => s);
  }

  /** Changes whenever the user's corrections change (persisted cache signatures include it). */
  overridesSignature() {
    return this.overrides ? this.overrides.signature() : '';
  }

  /** Sessions that belong to unit `key` (a task key, a branch, one session or a group of the user's). -> [[session view, mode]] */
  taskSessions(key) {
    const u = this.unitMap().units.get(key);
    return u ? u.members : [];
  }

  /**
   * One entry per work unit, newest activity first. Units the user hid are left out unless `includeHidden`.
   * `noise` marks a session with no real content (the page folds those into one group); `related` is a hint, never a grouping.
   */
  tasks({ includeHidden = false } = {}) {
    const { units } = this.unitMap();
    const out = [];
    for (const u of units.values()) {
      if (u.hidden && !includeHidden) continue;
      const ss = u.members.map(([v]) => v);
      const activity = taskActivity(u.key, ss);
      ss.sort((a, b) => ((a.first_ts || '') < (b.first_ts || '') ? -1 : (a.first_ts || '') > (b.first_ts || '') ? 1 : 0));
      const firsts = ss.map((v) => v.first_ts).filter(Boolean);
      const lasts = ss.map((v) => v.last_ts).filter(Boolean);
      const projects = [...new Set(ss.map((v) => v.project))].sort();
      const title = u.source === 'session' ? u.sessionTitle : null;
      const merged = u.mergedFrom.length ? u.mergedFrom.slice(0, 2).join(' + ') + (u.mergedFrom.length > 2 ? ` +${u.mergedFrom.length - 2}` : '') : null;
      out.push({
        key: u.key, id: u.id, kind: u.source, source: u.source, sessions: ss.length, projects,
        label: u.label || (u.source === 'key' || u.source === 'branch' ? u.key : u.source === 'user' ? u.defaultLabel || merged : title),
        noise: u.noise,
        renamed: u.renamed, hidden: u.hidden, noise: u.noise, unsorted: u.source === 'session', mergedFrom: u.mergedFrom, can_split: u.source === 'user',
        ai: u.ai, range: u.range,
        first_ts: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null,
        last_ts: lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
        snippet: title || ss[0].snippet, prompts: ss.reduce((a, v) => a + v.n_prompts, 0), activity,
        session_ids: u.range ? [] : ss.map((v) => v.id), // a message range cannot be "moved" as a session: the rest of the session is somewhere else
      });
    }
    out.sort((a, b) => ((b.last_ts || '') < (a.last_ts || '') ? -1 : (b.last_ts || '') > (a.last_ts || '') ? 1 : 0));
    const items = [];
    for (const t of out) {
      if (t.source !== 'session' || t.noise) continue;
      const view = units.get(t.key).members[0][0];
      const times = [...(view.prompt_ts || [])].sort((a, b) => a - b);
      const neutral = t.label || `${t.projects[0] || ''} · ${(t.first_ts || '').slice(0, 10)}`;
      items.push({ key: t.key, label: cutTitle(neutral, 60), project: t.projects[0] || '', times });
    }
    const related = relatedUnits(items);
    for (const t of out) t.related = related.get(t.key) || [];
    return out;
  }
}

/**
 * Sessions of the unit with their loaded turns -> the input of capsule.generate().
 * Key and branch units: each session is read as before (the key picks its turns, see capsule.planRanges).
 * Units without a task key already know their turns, so each item carries `ranges`:
 *   a single session  -> its usable turns (noise left out); a part the user or the AI cut -> exactly its range;
 *   a group of the user's -> the union of its members: parts by their range, whole sessions by their usable turns.
 */
export function planTask(index, key) {
  const u = index.unitMap().units.get(key);
  const known = Boolean(u) && (u.source === 'session' || u.source === 'user');
  return index.taskSessions(key).map(([s, mode]) => {
    const turns = capsule.loadRichTurns(s.path, index.keyRegex);
    const item = { path: s.path, turns, mode };
    if (known) item.ranges = s.range ? capsule.clampRanges([s.range], turns.length) : capsule.meaningfulRanges(turns);
    return item;
  });
}

export function isGeneratable(key) {
  return isGeneratableKey(key);
}

/** The name of a unit when nothing else is known: its label, else the titles of what it holds. */
export function unitName(u) {
  if (u.label) return u.label;
  if (u.source === 'key' || u.source === 'branch') return u.key;
  if (u.source === 'session') return u.sessionTitle || '';
  if (u.defaultLabel) return u.defaultLabel;
  return u.members.slice(0, 2).map(([v]) => v.unit_title || v.snippet || '').filter(Boolean).join(' + ');
}

/** `session[#a-b]` of every session view of a unit: what a capsule was written from, and what the unit holds now. */
export const basisOf = (views) => views.map((v) => ({ session: v.id, range: v.range ? [v.range[0], v.range[1]] : null }))
  .sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : (a.range ? a.range[0] : -1) - (b.range ? b.range[0] : -1)));
const basisKey = (b) => b.session + (b.range ? `#${b.range[0]}-${b.range[1]}` : '');

/**
 * What a capsule remembers about the unit it was written for (stored in the capsule file): the stable id, where the unit comes from,
 * its name then and the sessions (and message ranges) it held. -> {id, source, label, keyed, basis}
 */
export function unitMeta(index, key) {
  const u = index.unitMap().units.get(key);
  if (!u) return null;
  return {
    id: u.id || unitId(key, u.source), source: u.source, label: unitName(u), keyed: u.source === 'key' || u.source === 'branch',
    basis: basisOf(u.members.map(([v]) => v)),
  };
}

/**
 * Has the unit changed since the capsule was written? Compares the sessions (and ranges) the unit holds now with the ones the capsule
 * was written from. A session that has messages newer than the capsule is not "a change", it is new work (counted as new messages).
 * null when the capsule does not know its sessions (written by an older version): nothing is guessed.
 * -> {added, removed, changed} | null
 */
export function capsuleDrift(cap, views, staleness = null) {
  const basis = cap && cap.unit && Array.isArray(cap.unit.basis) ? cap.unit.basis : null;
  if (!basis) return null;
  const was = new Set(basis.map(basisKey));
  const now = basisOf(views);
  const nowKeys = new Set(now.map(basisKey));
  const fresh = staleness ? staleness.by_session : {};
  const removed = [...was].filter((k) => !nowKeys.has(k)).length;
  const added = now.filter((b) => !was.has(basisKey(b)) && !fresh[b.session]).length;
  return { added, removed, changed: added + removed > 0 };
}

const safeName = (key) => key.replace(/[^\p{L}\p{N}_.-]/gu, '_');

/**
 * File name (without extension) of the capsule of a unit.
 *  - task keys and branches keep the name they always had (`SHOP-101`, `feature_search-autocomplete`): capsules written by earlier
 *    versions are found where they are and never renamed;
 *  - every other unit (a session, a group, a part of a session) gets its stable id made safe for any file system plus a short hash of
 *    the id: `session_ab12cd34-5f2a91c0`, `user_<uuid>-...`, `session_ab12cd34_0-7-...`. The hash keeps two ids that clean up to the
 *    same text apart (`:` and `/` and `#` all become `_`), and no name ends in a dot or a space or uses a reserved name (Windows).
 */
export function capsuleStem(key) {
  const slug = safeName(String(key)).replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'unit';
  return `${slug}-${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8)}`;
}

/** Names a capsule of `key` may have, best first: the one older versions wrote (task keys and branches only), then the id-based one. */
export function capsuleStems(key) {
  const k = String(key);
  return /^(?:session|user):/.test(k) ? [capsuleStem(k)] : [safeName(k), capsuleStem(k)];
}

/**
 * Capsules cached as <dir>/<name>.json (+ .md); see capsuleStem for the names. The JSON carries the unit key it belongs to, so a
 * file is only used for the unit it names (two keys that clean up to the same name never overwrite each other).
 * Reading is instant; nothing is regenerated unless asked.
 */
export class CapsuleStore {
  constructor(directory) {
    this.dir = directory;
    this.parsed = new Map(); // file name -> {sig, data}
    this.known = new Map(); // unit key -> file name it was last saved under or seen in (spares re-reading files to find the owner)
    this.revision = 0; // bumped on every save / external change, even when mtime and size happen to stay the same
  }

  readStem(stem) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${stem}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /** The file name (no extension) this unit's capsule lives under: where it already is, else the first free name. */
  stemFor(key) {
    const known = this.known.get(key);
    if (known && fs.existsSync(path.join(this.dir, `${known}.json`))) return known;
    const stems = capsuleStems(key);
    for (const stem of stems) {
      const d = this.readStem(stem);
      if (d && d.key === key) return stem;
    }
    for (const stem of stems) if (!fs.existsSync(path.join(this.dir, `${stem}.json`))) return stem;
    return stems[stems.length - 1];
  }

  filePath(key, ext) {
    return path.join(this.dir, `${this.stemFor(key)}.${ext}`);
  }

  load(key) {
    for (const stem of capsuleStems(key)) {
      const d = this.readStem(stem);
      if (d && d.key === key) return d;
    }
    return null;
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
      if (hit.data && hit.data.key) {
        out.push(hit.data);
        this.known.set(hit.data.key, n.replace(/\.json$/, ''));
      }
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

  /** Writes the capsule. `keepDate` keeps the `generated_at` it already has (a capsule reused for another unit stays as old as it is). */
  save(key, result, { keepDate = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = keepDate && result.generated_at ? result.generated_at : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const stamped = { ...result, key, generated_at: stamp };
    const stem = this.stemFor(key);
    fs.writeFileSync(path.join(this.dir, `${stem}.json`), JSON.stringify(stamped, null, 1));
    fs.writeFileSync(path.join(this.dir, `${stem}.md`), stamped.markdown || '');
    this.known.set(key, stem);
    this.parsed.delete(`${stem}.json`); // next all() re-reads the new version
    return stamped;
  }
}
