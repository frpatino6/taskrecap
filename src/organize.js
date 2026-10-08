// "Organize with AI": proposals for the sessions that have no task key. Nothing here runs without the user's confirmation, and
// nothing the model says is applied by itself: every answer becomes a PROPOSAL (a title, a group of sessions that are the same
// piece of work, or the cut of a long session), checked strictly, shown with its evidence and applied only when the user accepts.
// Accepting writes ordinary corrections (see units.js) marked `source: 'ai'`, so Undo and the user's own corrections keep working.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadRichTurns, shortPath } from './capsule.js';
import { UserError } from './errors.js';
import { estimateCost, extractJson } from './llm.js';
import { messageList } from './messages.js';
import { STAGES, clip, log, makeReporter, stage } from './progress.js';
import { redact } from './sessions.js';
import { MAX_LABEL, cutTitle, meaningfulText, stripTags } from './units.js';
import { sumMetas } from './usage.js';

export const PROMPT_VERSION = 'organize-1';
export const STORE_VERSION = 1;
export const SPLIT_MIN_MESSAGES = 14; // a session needs this many real messages to be offered for cutting
export const MAX_SHOWN_TURNS = 40; // messages of a long session that the model gets to see
export const MAX_BATCH_CHARS = 36000; // one call reads at most this much (about 9K tokens)
export const MAX_BATCH_SESSIONS = 40;
export const MAX_SESSIONS = 160; // per run: the most recent ones
export const TITLE_CHARS = 80;
const BASE_OUTPUT_TOKENS = 400;
const OUTPUT_TOKENS_PER_SESSION = 140;
const MAX_GROUPS = 30;
const MAX_SPLITS = 20;
const CONFIDENCE = ['high', 'medium', 'low'];

const hhmm = (ts) => (ts ? String(ts).slice(11, 16) : '--:--');
const oneLine = (text, max) => clip(redact(stripTags(text)), max);
const cleanText = (v, max) => redact(String(v == null ? '' : v)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---------- what the model gets to read: a small, redacted skeleton per session (never a whole transcript) ----------
const digests = new Map(); // file version -> digest (oldest evicted first)
const DIGEST_MAX = 64;

/**
 * The skeleton of one session. `short` is the id the model uses for it. Only meaningful messages are shown, as
 * `t<N> hh:mm | text` where N is the message number the evidence panel uses; the first three, the last one, and for a long
 * session an even sample of the whole of it (so a change of topic shows up). Texts are redacted; edited files are short paths.
 */
export function sessionDigest(s, short, keyRegex) {
  const st = fs.statSync(s.path);
  const id = `${s.path}:${st.mtimeMs}:${st.size}:${short}:${keyRegex}`;
  const hit = digests.get(id);
  if (hit) return hit;
  const turns = loadRichTurns(s.path, keyRegex);
  const real = [];
  turns.forEach((t, i) => { if (!t.noise && meaningfulText(t.text)) real.push(i); });
  const long = real.length >= SPLIT_MIN_MESSAGES;
  const pick = new Set([...real.slice(0, 3), ...real.slice(-1)]);
  if (long) {
    const n = Math.min(MAX_SHOWN_TURNS, real.length);
    for (let k = 0; k < n; k++) pick.add(real[Math.floor((k * (real.length - 1)) / Math.max(1, n - 1))]);
  }
  const shown = [...pick].sort((a, b) => a - b);
  const files = [];
  for (const t of turns) for (const f of t.files) { const sp = redact(shortPath(f, t.cwd)); if (!files.includes(sp)) files.push(sp); }
  const when = `${(s.first_ts || '').slice(0, 10)} ${hhmm(s.first_ts)}-${hhmm(s.last_ts)}`;
  const lines = [`SESSION ${short} | repo=${s.project || '-'} | branch=${s.branch || '-'} | ${when} | messages=${real.length}${long ? ' (long)' : ''}`];
  if (files.length) lines.push(`files: ${files.slice(0, 6).join(', ')}`);
  for (const i of shown) lines.push(`t${i} ${hhmm(turns[i].ts)} | ${oneLine(turns[i].text, long ? 110 : 170)}`);
  const d = { id: s.id, short, repo: s.project, text: lines.join('\n'), shown: new Set(shown), turns: turns.length, real: real.length, realIdx: real, long, last_ts: s.last_ts || '' };
  digests.set(id, d);
  while (digests.size > DIGEST_MAX) digests.delete(digests.keys().next().value);
  return d;
}

/** Consecutive sessions (oldest first) in batches of at most MAX_BATCH_CHARS. -> [[digest]] */
export function makeBatches(list) {
  const sorted = [...list].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const item of sorted) {
    const len = item.digest.text.length + 2;
    if (cur.length && (chars + len > MAX_BATCH_CHARS || cur.length >= MAX_BATCH_SESSIONS)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(item);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const SCHEMA_FULL = `{"titles":[{"session":"<id>","title":"..."}],
"groups":[{"sessions":["<id>","<id>"],"title":"...","reason":"one sentence","confidence":"high|medium|low","evidence":[{"session":"<id>","turn":0}]}],
"splits":[{"session":"<id>","reason":"one sentence","parts":[{"start":0,"end":9,"title":"...","evidence":[{"session":"<id>","turn":0}]}]}]}`;

export function buildPrompt(batch, { titlesOnly = false, language = 'English' } = {}) {
  const body = batch.map((b) => b.digest.text).join('\n\n');
  const head =
    'You help a developer tidy their Claude Code history. Below are sessions that have no task code. One block per session: a header, ' +
    'the files it edited, and some of the user\'s messages as `t<N> time | text` (N is the message number).\n';
  const rules = titlesOnly
    ? `Give each session a clear title (at most 70 characters) saying what the work was. Write it in ${language}.\n` +
      'Use ONLY the session ids that appear below. Reply ONLY with JSON: {"titles":[{"session":"<id>","title":"..."}]}\n\n'
    : `Do three things, and ONLY when the messages give explicit evidence. Write titles and reasons in ${language}.\n` +
      '1. "titles": a clear title (at most 70 characters) for each session, saying what the work was.\n' +
      '2. "groups": sessions that are the SAME piece of work (same feature, bug, ticket, file or goal). The evidence must be message numbers ' +
      'shown below, in at least TWO of the group\'s sessions, that show it. The same repo, the same folder or being close in time is NOT enough. ' +
      'If in doubt, do NOT group.\n' +
      '3. "splits": only for a session marked (long) that clearly switches between different pieces of work. Give 2 or more NON-overlapping ' +
      'inclusive ranges of message numbers (start, end), a title per range and at least one evidence message number INSIDE each range.\n' +
      'Use ONLY session ids and message numbers that appear below; never invent any. Fewer, safer proposals are better: an empty list is a good answer.\n' +
      `Reply ONLY with JSON in this shape:\n${SCHEMA_FULL}\n\n`;
  return head + rules + body;
}

// ---------- checking what the model said ----------
const idOf = (type, sessions, parts = []) => crypto.createHash('sha1')
  .update(`${type}|${[...sessions].sort().join(',')}|${parts.map((p) => `${p.start}-${p.end}`).join(',')}`).digest('hex').slice(0, 12);

const asInt = (v) => (typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v == null ? '' : v)) ? Number(v) : NaN);

/**
 * Strict validation of a model answer. `byShort`: Map(short id -> digest). Everything the model got wrong is dropped, never
 * repaired: unknown sessions or message numbers, groups without evidence in at least two sessions, cuts with overlapping ranges
 * or ranges without evidence, titles that are empty. Nothing is invented. -> {proposals: [...], dropped: n}
 */
export function validateAnswer(obj, byShort, { titlesOnly = false, renamed = new Set(), current = new Map() } = {}) {
  const out = [];
  let dropped = 0;
  const get = (v) => byShort.get(String(v == null ? '' : v).trim().toLowerCase()) || null;
  const evidenceFor = (list, allowed, range = null) => {
    const ev = [];
    for (const e of Array.isArray(list) ? list : []) {
      const d = get(e && e.session);
      const turn = asInt(e && e.turn);
      if (!d || !allowed.has(d.short) || !Number.isInteger(turn) || !d.shown.has(turn)) continue; // only messages the model was shown
      if (range && (turn < range[0] || turn > range[1])) continue;
      if (!ev.some((x) => x.session === d.short && x.turn === turn)) ev.push({ session: d.short, turn });
    }
    return ev;
  };
  const answer = obj && typeof obj === 'object' ? obj : {};

  const inSplit = new Set();
  const splits = [];
  if (!titlesOnly) {
    for (const sp of (Array.isArray(answer.splits) ? answer.splits : []).slice(0, MAX_SPLITS * 2)) {
      const d = get(sp && sp.session);
      if (!d || !d.long || inSplit.has(d.short)) { dropped += 1; continue; }
      const parts = [];
      for (const p of Array.isArray(sp.parts) ? sp.parts : []) {
        const start = asInt(p && p.start), end = asInt(p && p.end);
        const title = cleanText(p && p.title, TITLE_CHARS);
        if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < d.turns) || title.length < 3) continue;
        if (!d.realIdx.some((i) => i >= start && i <= end)) continue; // a range with no real message is nothing
        const evidence = evidenceFor(p.evidence, new Set([d.short]), [start, end]);
        if (!evidence.length) continue; // no evidence INSIDE the range: not proposed
        parts.push({ start, end, title, evidence });
      }
      parts.sort((a, b) => a.start - b.start);
      let clash = false;
      for (let i = 1; i < parts.length; i++) if (parts[i].start <= parts[i - 1].end) clash = true;
      if (clash || parts.length < 2) { dropped += 1; continue; } // overlapping ranges are rejected as a whole
      inSplit.add(d.short);
      splits.push({
        id: idOf('split', [d.id], parts), type: 'split', title: '', sessions: [d.id], shorts: [d.short],
        reason: cleanText(sp.reason, 240), confidence: 'medium', parts, evidence: parts.flatMap((p) => p.evidence),
      });
      if (splits.length >= MAX_SPLITS) break;
    }
  }

  const grouped = new Set();
  const groups = [];
  if (!titlesOnly) {
    for (const g of (Array.isArray(answer.groups) ? answer.groups : []).slice(0, MAX_GROUPS * 2)) {
      const title = cleanText(g && g.title, TITLE_CHARS);
      const members = [];
      for (const v of Array.isArray(g && g.sessions) ? g.sessions : []) {
        const d = get(v);
        if (d && !members.some((m) => m.short === d.short) && !inSplit.has(d.short) && !grouped.has(d.short)) members.push(d);
      }
      const ev = evidenceFor(g && g.evidence, new Set(members.map((m) => m.short)));
      const backed = members.filter((m) => ev.some((e) => e.session === m.short)); // a member without evidence does not join
      if (backed.length < 2 || title.length < 3) { dropped += 1; continue; }
      const confidence = CONFIDENCE.includes(String(g.confidence)) ? String(g.confidence) : 'low';
      for (const m of backed) grouped.add(m.short);
      groups.push({
        id: idOf('group', backed.map((m) => m.id)), type: 'group', title, sessions: backed.map((m) => m.id), shorts: backed.map((m) => m.short),
        reason: cleanText(g.reason, 240), confidence, evidence: ev.filter((e) => backed.some((m) => m.short === e.session)),
      });
      if (groups.length >= MAX_GROUPS) break;
    }
  }

  const titled = new Set();
  const titles = [];
  for (const t of Array.isArray(answer.titles) ? answer.titles : []) {
    const d = get(t && t.session);
    const title = cutTitle(cleanText(t && t.title, 200), TITLE_CHARS);
    if (!d || titled.has(d.short) || title.length < 3 || renamed.has(d.short)) { dropped += 1; continue; } // never over a name the user chose
    if (norm(title) === norm(current.get(d.short))) continue; // nothing better than the free title: no proposal
    titled.add(d.short);
    titles.push({ id: idOf('title', [d.id]), type: 'title', title, sessions: [d.id], shorts: [d.short], reason: '', confidence: 'medium', evidence: [] });
  }
  out.push(...groups, ...splits, ...titles);
  return { proposals: out, dropped };
}

// ---------- persistence: proposals, their state and what was already asked ----------
/** A versioned JSON file written atomically; a damaged one is moved aside. status: pending | accepted | rejected. */
export class OrganizeStore {
  constructor(file = null) {
    this.file = file;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    this.data = { version: STORE_VERSION, runs: {}, proposals: {} };
    if (!this.file) return this.data;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this.data;
    }
    try {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object' || typeof d.runs !== 'object' || typeof d.proposals !== 'object') throw new Error('bad shape');
      if (typeof d.version === 'number' && d.version > STORE_VERSION) throw new Error('written by a newer version');
      this.data = { version: STORE_VERSION, runs: d.runs, proposals: d.proposals };
    } catch {
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* keep going without it */ }
    }
    return this.data;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  hasRun(sig) {
    return Boolean(this.load().runs[sig]);
  }

  recordRun(sig, meta) {
    const runs = this.load().runs;
    runs[sig] = { at: new Date().toISOString(), ...meta };
    const keys = Object.keys(runs);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete runs[k]; // only the recent ones are worth remembering
  }

  /**
   * Store the proposals of a run over `analysed` (a Set of full session ids). Older PENDING proposals about those sessions are
   * replaced; an accepted or rejected one keeps its state (a rejected proposal never comes back).
   */
  upsert(list, analysed) {
    const props = this.load().proposals;
    for (const [id, p] of Object.entries(props)) if (p.status === 'pending' && p.sessions.some((s) => analysed.has(s))) delete props[id];
    const now = new Date().toISOString();
    for (const p of list) if (!props[p.id]) props[p.id] = { ...p, status: 'pending', created_at: now };
    this.save();
  }

  get(id) {
    return this.load().proposals[id] || null;
  }

  all() {
    return Object.values(this.load().proposals);
  }

  setStatus(id, status, extra = {}) {
    const p = this.load().proposals[id];
    if (!p) return;
    Object.assign(p, { status, ...extra });
    this.save();
  }
}

// ---------- the service ----------
const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

export class Organizer {
  /**
   * @param {object} o
   * @param {object} o.index SessionIndex  @param {object} o.overrides Overrides  @param {OrganizeStore} o.store
   * @param {(prompt: string, opts: object) => Promise<[string, object]>} o.ask counted LLM call
   * @param {() => string} o.model  @param {() => string} o.language  @param {string} o.keyRegex
   */
  constructor({ index, overrides, store, ask, model, language, keyRegex }) {
    Object.assign(this, { index, overrides, store, ask, model, language, keyRegex });
    this.busy = false;
  }

  /** Session units that are their own unit and have content: what can be organized. -> [{key, short, s, unit, digest, first}] */
  eligible({ sessions = null } = {}) {
    const want = Array.isArray(sessions) && sessions.length ? new Set(sessions.map((x) => String(x).toLowerCase())) : null;
    const out = [];
    for (const u of this.index.unitMap().units.values()) {
      if (u.source !== 'session' || u.noise || u.hidden || !/^session:[^#]+$/.test(u.key)) continue;
      const s = u.members[0][0];
      const short = u.key.slice('session:'.length);
      if (want && ![...want].some((w) => s.id.toLowerCase().startsWith(w) || w === short.toLowerCase())) continue;
      out.push({ key: u.key, short, s, unit: u, first: s.first_ts || '' });
    }
    out.sort((a, b) => (a.first < b.first ? 1 : a.first > b.first ? -1 : 0)); // the most recent first, then cap
    const capped = out.slice(0, MAX_SESSIONS);
    for (const e of capped) e.digest = sessionDigest(e.s, e.short, this.keyRegex);
    return capped;
  }

  /** The same text while the sessions are the same: a run over unchanged sessions is never asked twice. */
  signature(list, titlesOnly) {
    const fp = list.map((e) => `${e.short}:${e.digest.turns}:${e.digest.last_ts}:${e.unit.renamed && !e.unit.ai ? 'r' : ''}`).sort().join('|');
    return sha(`${PROMPT_VERSION}|${this.model()}|${titlesOnly ? 't' : 'f'}|${fp}`);
  }

  plan({ sessions = null, titlesOnly = false } = {}) {
    const list = this.eligible({ sessions });
    if (!list.length) throw new UserError('There are no unsorted sessions with content to organize.');
    return { list, titlesOnly, batches: makeBatches(list), sig: this.signature(list, titlesOnly) };
  }

  /** Free: what a run would cost. `cached` = the same sessions were already analysed: nothing would be spent. */
  estimate({ sessions = null, titlesOnly = false, force = false } = {}) {
    const p = this.plan({ sessions, titlesOnly });
    const cached = !force && this.store.hasRun(p.sig);
    const chars = p.batches.reduce((n, b) => n + buildPrompt(b, { titlesOnly: p.titlesOnly, language: this.language() }).length, 0);
    const out = estimateCost(p.batches.length, chars, p.batches.length * BASE_OUTPUT_TOKENS + p.list.length * OUTPUT_TOKENS_PER_SESSION);
    const base = { sessions: p.list.length, batches: p.batches.length, titles_only: p.titlesOnly, model: this.model(), pending: this.pendingCount() };
    if (cached) return { ...base, cached: true, calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, seconds: 0, usd_if_again: out.usd };
    return { ...base, cached: false, ...out };
  }

  async run({ sessions = null, titlesOnly = false, force = false } = {}, { emit = null, signal = null } = {}) {
    if (this.busy) throw new UserError('Organizing is already running.');
    this.busy = true;
    const metas = [];
    const report = makeReporter(emit, () => sumMetas(metas));
    try {
      report({ type: 'start', action: 'organize', stages: STAGES.organize });
      stage(report, 'org_scan', 'running');
      const p = this.plan({ sessions, titlesOnly });
      stage(report, 'org_scan', 'done', 'organize_scan_done', { sessions: p.list.length, batches: p.batches.length });
      if (!force && this.store.hasRun(p.sig)) { // same sessions as a run that already finished: no second call
        for (const id of ['org_ask', 'org_validate', 'org_save']) stage(report, id, 'skipped');
        log(report, 'organize_cached', {});
        return { cached: true, proposals: this.view().proposals, usage: sumMetas(metas), dropped: 0 };
      }
      const byShort = new Map(p.list.map((e) => [e.short.toLowerCase(), e.digest]));
      const renamed = new Set(p.list.filter((e) => e.unit.renamed && !e.unit.ai).map((e) => e.short.toLowerCase()));
      const current = new Map(p.list.map((e) => [e.short.toLowerCase(), e.unit.sessionTitle || '']));
      const proposals = [];
      let dropped = 0;
      let readable = 0;
      stage(report, 'org_ask', 'running');
      for (let i = 0; i < p.batches.length; i++) {
        log(report, 'organize_batch', { n: i + 1, total: p.batches.length, sessions: p.batches[i].length });
        const [text, meta] = await this.ask(buildPrompt(p.batches[i], { titlesOnly, language: this.language() }), { signal });
        metas.push(meta);
        let obj = null;
        try { obj = extractJson(text); } catch { log(report, 'organize_batch_bad', { n: i + 1 }, 'warn'); continue; }
        readable += 1;
        const part = validateAnswer(obj, new Map(p.batches[i].map((e) => [e.short.toLowerCase(), e.digest])), { titlesOnly, renamed, current });
        proposals.push(...part.proposals);
        dropped += part.dropped;
        if (signal && signal.aborted) break;
      }
      stage(report, 'org_ask', 'done', 'organize_ask_done', { tokens: sumMetas(metas).tokens });
      if (!readable) throw new Error('The AI answer could not be read. Nothing was changed: try again.');
      stage(report, 'org_validate', 'running');
      const unique = [...new Map(proposals.map((x) => [x.id, x])).values()];
      stage(report, 'org_validate', 'done', 'organize_validate_done', { kept: unique.length, dropped });
      for (const pr of unique) log(report, 'organize_proposal', { kind: pr.type, title: clip(pr.title || pr.reason || '', 100) });
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      stage(report, 'org_save', 'running');
      this.store.upsert(unique, new Set(p.list.map((e) => e.s.id)));
      this.store.recordRun(p.sig, { sessions: p.list.length, proposals: unique.length, titles_only: titlesOnly, model: this.model(), ...pickUsage(sumMetas(metas)) });
      this.store.save();
      stage(report, 'org_save', 'done', 'organize_save_done', { proposals: unique.length });
      return { cached: false, proposals: this.view().proposals, usage: sumMetas(metas), dropped };
    } catch (e) {
      report.fail(e && e.name === 'AbortError' ? 'cancelled' : 'error');
      throw e;
    } finally {
      this.busy = false;
    }
  }

  // ----- reading proposals (free) -----
  /** Current status: an accepted proposal whose changes were undone is pending again. */
  statusOf(p) {
    if (p.status !== 'accepted') return p.status;
    return this.overrides.ops().some((o) => o.batch === p.batch && !o.undone) ? 'accepted' : 'pending';
  }

  /** Does a proposal still apply? Its sessions must still be units of their own that were not hidden or moved. */
  applies(p, units = this.index.unitMap().units) {
    return p.sessions.every((id) => {
      const u = [...units.values()].find((x) => x.source === 'session' && !x.hidden && /^session:[^#]+$/.test(x.key) && x.members[0][0].id === id);
      return Boolean(u);
    });
  }

  unitKey(sessionId, units = this.index.unitMap().units) {
    for (const u of units.values()) if (u.source === 'session' && /^session:[^#]+$/.test(u.key) && u.members[0][0].id === sessionId) return u.key;
    return null;
  }

  pendingCount() {
    return this.pending().length;
  }

  pending() {
    const units = this.index.unitMap().units;
    return this.store.all().filter((p) => this.statusOf(p) === 'pending' && this.applies(p, units));
  }

  /** The proposals for the page: what to show for each, with the user's messages the evidence points at. */
  view() {
    const units = this.index.unitMap().units;
    const files = new Map(this.index.sessions().map((s) => [s.id, s]));
    const proposals = this.pending().map((p) => {
      const sessions = p.sessions.map((id) => {
        const s = files.get(id);
        const u = [...units.values()].find((x) => x.members[0] && x.members[0][0].id === id && /^session:[^#]+$/.test(x.key));
        return { id, short: u ? u.key.slice('session:'.length) : id.slice(0, 8), label: u ? (u.label || u.sessionTitle || '') : '', project: s ? s.project : '', first_ts: s ? s.first_ts : null, last_ts: s ? s.last_ts : null };
      });
      const quote = (e) => {
        const sid = p.sessions[p.shorts.indexOf(e.session)];
        const s = files.get(sid);
        if (!s) return { ...e, quote: '' };
        try { const m = messageList(s.path, this.keyRegex).find((x) => x.turn === e.turn); return { ...e, quote: m ? clip(m.text, 140) : '' }; } catch { return { ...e, quote: '' }; }
      };
      return {
        id: p.id, type: p.type, title: p.title, reason: p.reason, confidence: p.confidence, sessions,
        parts: (p.parts || []).map((x) => ({ start: x.start, end: x.end, title: x.title, evidence: x.evidence.map(quote) })),
        evidence: p.evidence.map(quote), created_at: p.created_at,
      };
    });
    const order = { group: 0, split: 1, title: 2 };
    proposals.sort((a, b) => order[a.type] - order[b.type] || CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence));
    return { proposals, eligible: this.eligibleCount() };
  }

  eligibleCount() {
    let n = 0;
    for (const u of this.index.unitMap().units.values()) if (u.source === 'session' && !u.noise && !u.hidden && /^session:[^#]+$/.test(u.key)) n += 1;
    return n;
  }

  // ----- applying (through the same corrections as everything the user does by hand) -----
  /** The operations that accepting `p` writes. `edits.title` replaces the title of a title or group proposal. */
  opsFor(p, edits = {}, units = this.index.unitMap().units) {
    const title = cleanText(edits.title != null ? edits.title : p.title, MAX_LABEL);
    if (p.type === 'title') {
      if (title.length < 1) throw new UserError('Type a name first.');
      const unit = this.unitKey(p.sessions[0], units);
      return [{ type: 'rename', unit, label: title, source: 'ai', proposal: p.id }];
    }
    if (p.type === 'group') {
      if (title.length < 1) throw new UserError('Type a name first.');
      const members = p.sessions.map((id) => this.unitKey(id, units));
      return [{ type: 'merge', unit: `user:${crypto.randomUUID()}`, members, label: title, source: 'ai', proposal: p.id }];
    }
    if (p.type === 'split') {
      return [{ type: 'cut', session: p.sessions[0], parts: p.parts.map((x) => ({ start: x.start, end: x.end, label: cleanText(x.title, MAX_LABEL) })), source: 'ai', proposal: p.id }];
    }
    throw new UserError('Unknown proposal.');
  }

  accept(id, edits = {}) {
    const p = this.store.get(String(id || ''));
    if (!p || this.statusOf(p) === 'rejected' || this.statusOf(p) === 'accepted') throw new UserError('That proposal is not available (any more).');
    const units = this.index.unitMap().units;
    if (!this.applies(p, units)) throw new UserError('That proposal no longer applies: its sessions changed. Run "Organize with AI" again.');
    const batch = this.overrides.add(this.opsFor(p, edits, units));
    this.store.setStatus(p.id, 'accepted', { batch });
    return batch;
  }

  /** Accept every pending proposal of at least `confidence` (titles are medium, cuts are medium, groups say their own) as ONE change: one Undo reverts them all. */
  acceptAll({ confidence = 'high' } = {}) {
    const floor = CONFIDENCE.indexOf(CONFIDENCE.includes(confidence) ? confidence : 'high');
    const units = this.index.unitMap().units;
    const chosen = this.pending().filter((p) => CONFIDENCE.indexOf(p.confidence) <= floor);
    if (!chosen.length) throw new UserError('There is nothing to accept at that confidence.');
    const ops = chosen.flatMap((p) => this.opsFor(p, {}, units));
    const batch = this.overrides.add(ops);
    for (const p of chosen) this.store.setStatus(p.id, 'accepted', { batch });
    return { batch, accepted: chosen.length };
  }

  reject(id) {
    const p = this.store.get(String(id || ''));
    if (!p) throw new UserError('That proposal does not exist (any more).');
    this.store.setStatus(p.id, 'rejected');
    return { ok: true };
  }
}

function pickUsage(u) {
  return { calls: u.calls, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: u.cost_usd };
}
