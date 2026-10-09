// Application layer shared by the CLI and the web server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as capsule from './capsule.js';
import { APP_NAME, APP_TITLE, DEFAULT_KEY_REGEX, VERSION } from './config.js';
import { checkClaude, cachedClaude, publicStatus, refreshClaude } from './claude.js';
import { UserError } from './errors.js';
import { Aborted, estimateCost, extractJson, askLlm, isAbort } from './llm.js';
import { readEvidence, parseSources, resolveSession, withRowTimes } from './evidence.js';
import { FileIndex } from './files.js';
import { STAGES, clip, log, makeMatchScanner, makeReporter, stage, throttle } from './progress.js';
import { buildTimeline } from './timeline.js';
import { CapsuleSearch } from './search.js';
import { redact } from './sessions.js';
import { CapsuleStore, SessionIndex, capsuleDrift, capsuleStaleness, isGeneratable, planTask, unitMeta } from './tasks.js';
import { pageMessages } from './messages.js';
import { UsageTracker, sumMetas } from './usage.js';
import { MAX_LABEL, Overrides, isUserKey } from './units.js';
import { UNASSIGNED } from './sessions.js';
import { OrganizeStore, Organizer } from './organize.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const DEMO_DIR = path.join(ROOT, 'demo');

const SEARCH_MAX_TASKS = 300; // most recent tasks sent to the AI search
const SEARCH_LINE_CHARS = 420;
const SEARCH_OUTPUT_TOKENS = 500;

/** UI strings live in web/strings.<lang>.json (English is the fallback), so translating = adding one file. */
export function loadStrings(lang = 'en') {
  const out = {};
  for (const code of ['en', lang]) {
    try {
      Object.assign(out, JSON.parse(fs.readFileSync(path.join(WEB_DIR, `strings.${code}.json`), 'utf8')));
    } catch {
      /* missing translation file: keep the English strings */
    }
  }
  return out;
}

/** The UI languages on disk (web/strings.<code>.json with a `lang_name`): the whitelist for `?lang=`. -> [{code, name}] */
export function listLangs() {
  const out = [];
  for (const f of fs.readdirSync(WEB_DIR)) {
    const m = f.match(/^strings\.([a-z]{2,3})\.json$/);
    if (!m) continue;
    try {
      out.push({ code: m[1], name: JSON.parse(fs.readFileSync(path.join(WEB_DIR, f), 'utf8')).lang_name || m[1] });
    } catch {
      /* unreadable file: not offered */
    }
  }
  return out.sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.code.localeCompare(b.code)));
}

/** A capsule for this key is already being generated. */
export class Busy extends Error {
  constructor(key) {
    super(`Busy: ${key}`);
    this.name = 'Busy';
  }
}

export { UserError }; // defined in errors.js so llm.js can raise it too; same class, same instanceof

const INJECTED_AI = { available: true, path: null, version: null, via: 'injected', reason: null, tried: [], message: null };

export class App {
  /**
   * @param {object} o
   * @param {string} o.projectsDir where the session jsonl files live
   * @param {string} o.cacheDir where capsules are cached
   * @param {(prompt: string) => Promise<[string, object]>} [o.ask] LLM function (injectable for tests)
   * @param {string|null} [o.usageFile] where the cumulative token counter is persisted
   */
  constructor({ projectsDir, cacheDir, keyRegex = DEFAULT_KEY_REGEX, ask = null, lang = 'en', demo = false, model = 'sonnet', votes = 3, usageFile = null, keyConfig = null, overridesFile = undefined }) {
    this.projectsDir = projectsDir;
    this.keyRegex = keyRegex;
    this.keyConfig = keyConfig; // {patterns, source, ignoreBranches}: what the key detection was configured with (info + doctor)
    // the user's corrections (rename, merge, move, split, hide) live next to the capsule cache, never inside the Claude folders
    this.overrides = new Overrides(overridesFile === undefined ? path.join(cacheDir, '.index', 'overrides.json') : overridesFile);
    this.lang = lang;
    this.demo = demo;
    this.model = model;
    this.votes = votes;
    this.index = new SessionIndex(projectsDir, keyRegex, { overrides: this.overrides, genericBranches: keyConfig ? keyConfig.ignoreBranches : null });
    this.store = new CapsuleStore(cacheDir);
    this.capsuleSearch = new CapsuleSearch(this.store);
    this.fileIndex = new FileIndex(this.index, this.store, path.join(cacheDir, '.index', 'files.json')); // not a capsule: all() only reads <key>.json
    this.strings = loadStrings(lang);
    this.usage = new UsageTracker(usageFile);
    this.rawAsk = ask;
    this.busy = new Set();
    // "Organize with AI": proposals for the sessions without a task key (nothing is applied until the user accepts one)
    this.organizer = new Organizer({
      index: this.index, overrides: this.overrides, store: new OrganizeStore(path.join(cacheDir, '.index', 'organize.json')),
      ask: (prompt, opts) => this.ask(prompt, opts), model: () => this.model, language: () => this.strings.llm_language || 'English', keyRegex: this.keyRegex,
    });
  }

  /**
   * Every LLM call goes through here, so each one is counted in the usage counter.
   * opts: {signal} stops the call (Aborted); {onText} streams the answer while Claude writes it.
   */
  async ask(prompt, opts = {}) {
    const fn = this.rawAsk || ((p, o) => askLlm(p, { model: this.model, ...o }));
    const [text, meta] = await fn(prompt, opts);
    this.usage.record(meta);
    return [text, meta || {}];
  }

  // --- reading (free, local) ---
  info() {
    return {
      name: APP_NAME, title: APP_TITLE, version: VERSION, demo: this.demo, lang: this.lang,
      key_regex: this.keyRegex, model: this.model, votes: this.votes,
      key_patterns: this.keyConfig ? this.keyConfig.patterns : [this.keyRegex], key_source: this.keyConfig ? this.keyConfig.source : 'default',
      ignore_branches: this.keyConfig ? this.keyConfig.ignoreBranches : [],
    };
  }

  /**
   * Can the AI actions run? Claude Code found and starting (cached 60 s, one shared probe at a time). Awaits the check:
   * for the CLI and `doctor`. Free browsing never depends on it. An injected `ask` (tests, embedding) counts as available.
   * -> {available, path, version, via, reason, tried, message}
   */
  async aiStatus() {
    if (this.rawAsk) return INJECTED_AI;
    return publicStatus(await checkClaude());
  }

  /**
   * The page's view of it: NEVER waits for a check. Returns the last answer (stale or not) at once and refreshes in the
   * background; before the first answer it is `{available: null, checking: true}` and the page asks again a moment later.
   */
  aiStatusCached() {
    if (this.rawAsk) return INJECTED_AI;
    const known = cachedClaude();
    if (!known || !known.fresh) refreshClaude(); // shared with a probe that is already running
    return known ? publicStatus(known.value) : { available: null, checking: true, path: null, version: null, via: null, reason: null, tried: [], message: null };
  }

  /** "Check again": a real re-check (shared with a running one, at most one new probe every couple of seconds). */
  async recheckAi() {
    if (this.rawAsk) return INJECTED_AI;
    return publicStatus(await checkClaude({ force: true }));
  }

  /** Strings for a UI language the user picked in the page; anything not in the whitelist gets the server's own language. */
  stringsFor(code) {
    return typeof code === 'string' && listLangs().some((l) => l.code === code) ? loadStrings(code) : this.strings;
  }

  usageSnapshot() {
    return this.usage.snapshot();
  }

  /**
   * `activity` (days with prompts, only the timeline needs it) is left out unless asked for. A task with a capsule also
   * carries `outdated`, `new_messages` (how many of its messages were written after the capsule, free, see capsuleStaleness) and
   * `capsule_changed` (the sessions of the unit are not the ones the capsule was written from: a merge, a move, a split).
   * Units the user hid are left out unless `includeHidden`. A session with no real content cannot have a capsule.
   */
  listTasks({ activity = false, includeHidden = false } = {}) {
    const caps = new Map(this.store.all().map((c) => [c.key, c]));
    const tasks = this.index.tasks({ includeHidden });
    for (const t of tasks) {
      const cap = caps.get(t.key);
      t.has_capsule = Boolean(cap);
      t.objective = (cap && cap.capsule && cap.capsule.objective) || '';
      t.generatable = isGeneratable(t.key) && !t.noise;
      if (cap) {
        const views = this.index.unitViews(t.key);
        const st = capsuleStaleness(views, t.key, cap.generated_at);
        const drift = capsuleDrift(cap, views, st);
        t.new_messages = st.new_messages;
        t.capsule_changed = Boolean(drift && drift.changed);
        t.outdated = st.new_messages > 0 || t.capsule_changed;
        t.capsule_at = st.known ? cap.generated_at : null;
      }
      if (!activity) delete t.activity;
    }
    return tasks;
  }

  /** `key:ABC-123` / `branch:x` (the stable ids of units) and `ABC-123` / `x` (the keys the pages use) name the same unit. -> the unit key */
  resolveUnitKey(ref) {
    const k = String(ref == null ? '' : ref);
    const units = this.index.unitMap().units;
    if (units.has(k)) return k;
    const m = k.match(/^(?:key|branch):(.+)$/s);
    return m && units.has(m[1]) ? m[1] : k;
  }

  /** The home timeline (free, local): see buildTimeline for the options. */
  timeline(opts = {}) {
    return buildTimeline(this.listTasks({ activity: true }), opts);
  }

  /**
   * Everything the task page needs. `sessions` are the sessions of the task with, for each, whether the key is its own task
   * (`main`), whether it also holds other tasks (`mixed`) and how many of its messages are newer than the capsule.
   * `stale` is null without a capsule; `markable` says the key can be found in the text of messages (a branch name cannot).
   */
  taskDetail(ref) {
    const key = this.resolveUnitKey(ref);
    const cap = this.store.load(key);
    const views = cap ? this.index.unitViews(key) : [];
    const stale = cap ? capsuleStaleness(views, key, cap.generated_at) : null;
    const drift = cap ? capsuleDrift(cap, views, stale) : null;
    const sessions = this.index.taskSessions(key).map(([s]) => {
      const { path: _p, mentions, prompt_ts: _t, mention_ts: _mt, ...rest } = s;
      return {
        ...rest, main: s.key === key, mixed: s.key !== key || Object.keys(mentions).some((k) => k !== key),
        task_mentions: mentions[key] || 0, new_messages: stale ? stale.by_session[s.id] || 0 : 0,
      };
    });
    sessions.sort((a, b) => ((a.first_ts || '') < (b.first_ts || '') ? -1 : (a.first_ts || '') > (b.first_ts || '') ? 1 : 0));
    const task = this.listTasks({ includeHidden: true }).find((t) => t.key === key) || null;
    if (!task && !sessions.length && !cap) return null;
    return {
      task, sessions, capsule: this.withRowTimes(cap), markable: this.isMarkable(key),
      stale: stale ? {
        known: stale.known, generated_at: stale.known ? cap.generated_at : null, new_messages: stale.new_messages, new_sessions: stale.new_sessions,
        changed: Boolean(drift && drift.changed), added: drift ? drift.added : 0, removed: drift ? drift.removed : 0,
        reused_from: cap.reused_from ? { key: cap.reused_from.key, label: cap.reused_from.label || cap.reused_from.key } : null,
      } : null,
      previous: cap || !task ? [] : this.previousCapsules(key),
    };
  }

  /**
   * Capsules of units that no longer exist (merged, split, moved away) whose sessions are in unit `key` now: the "capsule from before
   * the change" the page offers to reuse. Nothing is ever deleted; a reused capsule is a copy. -> [{key, label, generated_at, objective, shared, of}]
   */
  previousCapsules(key) {
    const units = this.index.unitMap().units;
    const mine = this.index.unitViews(key).map((v) => ({ session: v.id, range: v.range || null }));
    const meets = (a, b) => a.session === b.session && (!a.range || !b.range || (a.range[0] <= b.range[1] && b.range[0] <= a.range[1]));
    const out = [];
    for (const cap of this.store.all()) {
      if (cap.key === key || units.has(cap.key) || !cap.unit || !Array.isArray(cap.unit.basis)) continue;
      const shared = cap.unit.basis.filter((b) => mine.some((m) => meets(b, m))).length;
      if (!shared) continue;
      out.push({
        key: cap.key, label: cap.unit.label || cap.key, generated_at: cap.generated_at, objective: (cap.capsule && cap.capsule.objective) || '',
        shared, of: cap.unit.basis.length,
      });
    }
    return out.sort((a, b) => b.shared - a.shared || (a.generated_at < b.generated_at ? 1 : -1)).slice(0, 5);
  }

  /**
   * Free: copy the capsule of a unit that changed (`from`, no longer a unit) to the unit that holds its sessions now (`to`, without a
   * capsule). The copy keeps the date and the sessions of the original, so the page shows it as outdated until it is regenerated.
   * The original file stays where it is.
   */
  reuseCapsule(from, to) {
    const dest = this.resolveUnitKey(to);
    this.requireUnit(dest);
    if (this.store.load(dest)) throw new UserError('That unit already has a capsule. Regenerate it instead.');
    const src = this.store.load(String(from || ''));
    if (!src) throw new UserError('That capsule does not exist (any more).');
    if (this.index.unitMap().units.has(src.key)) throw new UserError('That capsule still belongs to a unit that exists.');
    if (!this.previousCapsules(dest).some((p) => p.key === src.key)) throw new UserError('That capsule has no session in common with this unit.');
    const meta = { ...unitMeta(this.index, dest), basis: (src.unit && src.unit.basis) || [] };
    const copy = {
      ...src, key: dest, unit: meta, reused_from: { key: src.key, label: (src.unit && src.unit.label) || src.key, generated_at: src.generated_at },
      markdown: capsule.renderMarkdown(dest, src.capsule || {}, src.files || [], src.commits || { confirmed: [], possible: [] }, src.sources || [], meta),
    };
    return this.store.save(dest, copy, { keepDate: true });
  }

  /** A task key written like a work key (ABC-123) can be looked for in message text; a branch name cannot. */
  isMarkable(key) {
    return isGeneratable(key) && new RegExp(`^(?:${this.keyRegex})$`).test(key);
  }

  /**
   * Free: one page of the user's messages of a session, for the task view. Every text is redacted and clipped.
   * `scope`: all | mine (messages citing the task key) | new (written after the capsule). `session` is an id or its first 8 characters.
   */
  sessionMessages({ key = '', session, scope = 'all', offset, limit }) {
    key = key ? this.resolveUnitKey(key) : '';
    const file = resolveSession(this.index.listFiles(), session);
    const summary = this.index.sessions().find((s) => s.path === file) || null;
    const view = key ? (this.index.taskSessions(key).find(([v]) => v.path === file) || [])[0] : null; // how the unit reads this session
    const cap = key ? this.store.load(key) : null;
    const since = cap ? Date.parse(cap.generated_at) : NaN;
    const page = pageMessages(file, {
      key, markable: Boolean(key) && this.isMarkable(key), main: !summary || !key || (view ? view.key === key : summary.key === key), since, scope, offset, limit, keyRegex: this.keyRegex,
      range: view && view.range ? view.range : null,
    });
    const id = path.basename(file).replace(/\.jsonl$/, '');
    return {
      key, session: { id, id8: id.slice(0, 8), project: summary ? summary.project : '', branch: summary ? summary.branch : '', first_ts: summary ? summary.first_ts : null, last_ts: summary ? summary.last_ts : null },
      mark: Boolean(key) && this.isMarkable(key), generated_at: Number.isFinite(since) ? cap.generated_at : null, ...page,
    };
  }

  /** The stored capsule plus, on each timeline row, the time of its first cited message (free; the stored files are unchanged). */
  withRowTimes(cap) {
    const timeline = cap && cap.capsule && cap.capsule.timeline;
    if (!Array.isArray(timeline) || !timeline.length) return cap;
    return { ...cap, capsule: { ...cap.capsule, timeline: withRowTimes(timeline, this.index.listFiles()) } };
  }

  /**
   * NORMAL (free) search: every word you type must appear, literally (any case or accent), in a task's key, repos,
   * first prompt, or in the text of its cached capsule. No AI, no tokens. Best match first.
   * -> null (empty query) | [{key, where: 'task'|'capsule', section, sections, excerpt, highlights, score}]
   */
  search(query) {
    return this.capsuleSearch.search(query, this.listTasks());
  }

  /** What the free search can look inside: tasks with a capsule vs tasks searched only by key, repos and first prompt. */
  searchCoverage() {
    return this.capsuleSearch.coverage(this.index.tasks().filter((t) => !t.noise));
  }

  /**
   * Free file -> tasks lookups. `fileTasks(path)`: tasks that touched one file; `findFiles(q)`: files matching a path
   * fragment. Links from capsules are accurate; links from raw sessions are flagged `approximate`.
   */
  fileTasks(file) {
    const meta = new Map(this.listTasks().map((t) => [t.key, t]));
    const tasks = this.fileIndex.tasksOf(String(file || '')).map((l) => this.withTask(l, meta.get(l.key)));
    return { path: String(file || ''), tasks };
  }

  findFiles(query, limit = 40) {
    const { files, total } = this.fileIndex.find(query, limit);
    return { files: files.map((f) => ({ path: f.path, tasks: f.tasks.map((l) => ({ key: l.key, status: l.status, approximate: l.approximate })) })), total };
  }

  /**
   * Free: the original messages behind a capsule citation {session: id8, turn}. `key` (optional) is the capsule it
   * came from, used to check that the turn lies inside the messages that capsule was written from.
   */
  evidence({ session, turn, context, key = '' }) {
    key = key ? this.resolveUnitKey(key) : '';
    const file = resolveSession(this.index.listFiles(), session);
    const cap = key ? this.store.load(key) : null;
    const ranges = cap ? (parseSources(cap.sources)[String(session).toLowerCase()] || null) : null;
    return readEvidence(file, turn, { context, ranges });
  }

  withTask(link, t) {
    return { ...link, kind: t ? t.kind : 'key', text: t ? t.objective || t.snippet : '', last_ts: t ? t.last_ts : null, has_capsule: t ? t.has_capsule : false };
  }

  // --- the user's corrections (free, local; every change can be undone) ---
  /** Session id (full or its first characters) -> the session summary; a clear error when unknown or ambiguous. */
  resolveSessionId(ref) {
    const text = String(ref || '').trim().toLowerCase();
    if (text.length < 4) throw new UserError('Which session? Send its id.');
    const all = this.index.sessions(); // hidden sessions are in here too: hiding only changes how they are grouped
    const hits = all.filter((s) => s.id.toLowerCase() === text || s.id.toLowerCase().startsWith(text));
    const exact = hits.filter((s) => s.id.toLowerCase() === text);
    const pick = exact.length === 1 ? exact : hits;
    if (!pick.length) throw new UserError('That session does not exist (any more).');
    if (pick.length > 1) throw new UserError('Several sessions start with that id: send more characters.');
    return pick[0];
  }

  /** A unit that exists now (hidden ones included), or a clear error. */
  requireUnit(key, what = 'unit') {
    const u = this.index.unitMap().units.get(String(key || ''));
    if (!u) throw new UserError(`That ${what} does not exist (any more).`);
    return u;
  }

  static cleanLabel(label, { required = false } = {}) {
    const t = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
    if (required && !t) throw new UserError('Type a name first.');
    if (t.length > MAX_LABEL) throw new UserError(`Use at most ${MAX_LABEL} characters for a name.`);
    return t;
  }

  /** What the page shows after a change: the operation that Undo would revert. */
  changeResult(batch) {
    const last = this.overrides.last();
    return { ok: true, batch, undo: last ? { batch: last.batch, type: last.type } : null };
  }

  renameUnit(key, label) {
    this.requireUnit(key);
    return this.changeResult(this.overrides.add([{ type: 'rename', unit: String(key), label: App.cleanLabel(label) }]));
  }

  /** Merge units into one group of the user's. Joining a group adds the others to it; two groups cannot be merged (split one first). */
  mergeUnits(keys, label = '') {
    const list = [...new Set((Array.isArray(keys) ? keys : []).map(String))];
    if (list.length < 2) throw new UserError('Pick at least two things to merge.');
    for (const k of list) this.requireUnit(k);
    const groups = list.filter(isUserKey);
    if (groups.length > 1) throw new UserError('Two groups cannot be merged into each other. Split one of them first.');
    const target = groups[0] || `user:${crypto.randomUUID()}`;
    const members = list.filter((k) => k !== target);
    const name = App.cleanLabel(label);
    const batch = this.overrides.add([{ type: 'merge', unit: target, members, ...(name ? { label: name } : {}) }]);
    return { ...this.changeResult(batch), unit: target };
  }

  /** Put one session in another unit (`to` = unit key) or in a brand-new group (`to` = 'new'). */
  moveSession(session, to, label = '') {
    const s = this.resolveSessionId(session);
    if (to === 'new') {
      const unit = `user:${crypto.randomUUID()}`;
      const name = App.cleanLabel(label);
      const batch = this.overrides.add([{ type: 'merge', unit, members: [], ...(name ? { label: name } : {}) }, { type: 'move', session: s.id, to: unit }]);
      return { ...this.changeResult(batch), unit };
    }
    this.requireUnit(to, 'destination');
    return { ...this.changeResult(this.overrides.add([{ type: 'move', session: s.id, to: String(to) }])), unit: String(to) };
  }

  /** Dissolve a group of the user's: its sessions go back to where they belong on their own. */
  splitUnit(key) {
    const u = this.requireUnit(key, 'group');
    if (u.source !== 'user') throw new UserError('Only groups you made can be split. Use "move session" for anything else.');
    return this.changeResult(this.overrides.add([{ type: 'split', unit: u.key }]));
  }

  hideUnit(key, hidden = true) {
    this.requireUnit(key);
    return this.changeResult(this.overrides.add([{ type: 'hide', unit: String(key), hidden: hidden !== false }]));
  }

  hideSession(session, hidden = true) {
    const s = this.resolveSessionId(session);
    return this.changeResult(this.overrides.add([{ type: 'hide', session: s.id, hidden: hidden !== false }]));
  }

  undoChange(ref = null) {
    const undone = this.overrides.undo(ref || null);
    return { ok: true, undone: undone.map((o) => ({ type: o.type, unit: o.unit || null, session: o.session || null })), undo: this.changeResult(null).undo };
  }

  /** What Undo would revert next (null when nothing). */
  changeHistory() {
    const last = this.overrides.last();
    return { last: last ? { batch: last.batch, type: last.type, unit: (last.ops[0] || {}).unit || null } : null, count: last ? last.count : 0, corrupt: Boolean(this.overrides.corrupt) };
  }

  /** The hidden units and sessions, so they can be shown again. */
  hiddenItems() {
    const units = this.index.tasks({ includeHidden: true }).filter((t) => t.hidden).map((t) => ({ key: t.key, label: t.label, kind: t.kind, snippet: t.snippet, sessions: t.sessions }));
    const sessions = this.index.unitMap().hiddenSessions.map((s) => ({
      id: s.id, id8: s.id.slice(0, 8), project: s.project, title: s.unit_title || s.snippet || '', first_ts: s.first_ts, prompts: s.n_prompts,
    }));
    return { units, sessions };
  }

  // --- organizing the sessions without a task key (free to read; running it is an AI action the user confirmed) ---
  /** Pending proposals and how many sessions could be organized. Free. */
  organizeProposals() {
    return this.organizer.view();
  }

  /** What a run would cost (nothing when the same sessions were already analysed). */
  organizeEstimate(opts = {}) {
    return this.organizer.estimate(opts);
  }

  organize(opts = {}, run = {}) {
    return this.organizer.run(opts, run);
  }

  acceptProposal(id, edits = {}) {
    const batch = this.organizer.accept(id, edits);
    return this.changeResult(batch);
  }

  acceptProposals(confidence = 'high') {
    const { batch, accepted } = this.organizer.acceptAll({ confidence });
    return { ...this.changeResult(batch), accepted };
  }

  rejectProposal(id) {
    return this.organizer.reject(id);
  }

  // --- AI actions (spend tokens; callers must have confirmed with the user first) ---
  /** Every unit can get a capsule; the empty placeholder and a session with no real message cannot. */
  checkKey(key) {
    if (key === UNASSIGNED || !isGeneratable(key)) throw new UserError('That is not a unit with a capsule.');
    const u = this.index.unitMap().units.get(key);
    if (u && u.noise) throw new UserError('This session has no real messages yet, so there is nothing to summarize.');
  }

  /** The sessions to read for `key` with their turns; a clear error when there is nothing to send. */
  planFor(key) {
    const plan = planTask(this.index, key);
    if (!plan.length) throw new UserError(`No sessions found for ${key}`);
    if (!plan.some((p) => (p.ranges ? p.ranges.length : p.turns.length))) throw new UserError('This unit has no real messages to summarize.');
    return plan;
  }

  estimate(ref) {
    const key = this.resolveUnitKey(ref);
    this.checkKey(key);
    const plan = this.planFor(key);
    const est = capsule.estimateTask(key, plan, this.votes);
    const size = capsule.planSize(plan);
    return { ...est, sessions: plan.length, turns: size.turns, ranges_known: size.known, model: this.model };
  }

  /**
   * Builds and caches the capsule of `key` (a task key, a branch, a session, a group of the user's or a part of a session).
   * `emit` (optional) receives real progress events; `signal` (optional AbortSignal) cancels it: running `claude -p` processes
   * are killed and nothing is saved. A unit whose messages are already known skips the range-selection votes.
   */
  async generate(ref, { emit = null, signal = null } = {}) {
    const key = this.resolveUnitKey(ref);
    this.checkKey(key);
    if (this.busy.has(key)) throw new Busy(key);
    this.busy.add(key);
    const metas = [];
    const report = makeReporter(emit, () => sumMetas(metas));
    try {
      report({ type: 'start', action: 'generate', key, stages: STAGES.generate });
      const ask = async (prompt, o = {}) => {
        const res = await this.ask(prompt, { ...o, signal });
        metas.push(res[1]);
        return res;
      };
      stage(report, 'scan', 'running');
      const plan = this.planFor(key);
      const unit = unitMeta(this.index, key);
      stage(report, 'scan', 'done', 'scan_done', { sessions: plan.length, turns: plan.reduce((n, p) => n + p.turns.length, 0) });
      const result = await capsule.generate(key, plan, ask, { votes: this.votes, language: this.strings.llm_language || 'English', emit: report, signal, unit });
      result.unit = unit; // what the capsule was written for: lets the page tell later that the unit changed
      const used = sumMetas(metas);
      result.info.llm_calls = used.calls;
      result.info.cost_usd = used.cost_usd;
      result.info.input_tokens = used.input_tokens;
      result.info.output_tokens = used.output_tokens;
      result.info.tokens = used.tokens;
      if (signal && signal.aborted) throw new Aborted(); // cancelled while the last step ran: save nothing
      stage(report, 'save', 'running');
      const saved = this.store.save(key, result);
      stage(report, 'save', 'done', 'save_done', { file: path.basename(this.store.filePath(key, 'json')) });
      return saved;
    } catch (e) {
      report.fail(isAbort(e) ? 'cancelled' : 'error');
      throw e;
    } finally {
      this.busy.delete(key);
    }
  }

  /** One line per recent task: what the AI search reads. Redacted, capped. */
  searchCatalog() {
    const caps = new Map(this.store.all().map((c) => [c.key, c.capsule || {}]));
    return this.index.tasks().filter((t) => !t.noise).slice(0, SEARCH_MAX_TASKS).map((t) => {
      const c = caps.get(t.key);
      const what = c && c.objective ? c.objective : t.snippet;
      const decisions = c && c.decisions ? c.decisions.slice(0, 3).map((d) => d.decision).join('; ') : '';
      const line = `${t.key} | ${t.kind} | repos: ${t.projects.join(',')} | ${(t.last_ts || '').slice(0, 10)} | ${what}` + (decisions ? ` | decisions: ${decisions}` : '');
      return { key: t.key, line: redact(line).replace(/\s+/g, ' ').slice(0, SEARCH_LINE_CHARS) };
    });
  }

  estimateSearch(query) {
    const q = String(query || '').trim();
    if (!q) throw new UserError('Type what you are looking for first.');
    const catalog = this.searchCatalog();
    if (!catalog.length) throw new UserError('There are no tasks to search yet.');
    return { ...estimateCost(1, buildSearchPrompt(q, catalog).length, SEARCH_OUTPUT_TOKENS), tasks: catalog.length, model: this.model };
  }

  /**
   * AI-assisted semantic search: asks Claude which tasks match the meaning of `query`.
   * `emit` / `signal` work as in generate(); matches are reported as soon as Claude has written them.
   */
  async aiSearch(query, { emit = null, signal = null } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new UserError('Type what you are looking for first.');
    const metas = [];
    const report = makeReporter(emit, () => sumMetas(metas));
    try {
      report({ type: 'start', action: 'search', query: q, stages: STAGES.search });
      stage(report, 'catalog', 'running');
      const catalog = this.searchCatalog();
      if (!catalog.length) throw new UserError('There are no tasks to search yet.');
      const known = new Map(this.listTasks().map((t) => [t.key, t]));
      stage(report, 'catalog', 'done', 'catalog_done', { tasks: catalog.length });

      stage(report, 'ask', 'running');
      log(report, 'ask_start', { query: clip(q, 80), tasks: catalog.length });
      const found = new Set();
      const scan = makeMatchScanner();
      const tick = throttle((text) => report({ type: 'progress', id: 'ask', approx_tokens: Math.ceil(text.length / 4) }));
      const onText = (text) => {
        for (const m of scan(text)) {
          if (!known.has(m.key) || found.has(m.key)) continue;
          found.add(m.key);
          report({ type: 'match', key: m.key, reason: clip(m.reason, 240) });
        }
        tick(text);
      };
      const [text, meta] = await this.ask(buildSearchPrompt(q, catalog), { signal, onText: emit ? onText : null });
      metas.push(meta);
      stage(report, 'ask', 'done', 'ask_done', { tokens: sumMetas([meta]).tokens });

      stage(report, 'rank', 'running');
      const raw = extractJson(text).matches || [];
      const matches = [];
      for (const m of raw) {
        if (m && known.has(m.key) && !matches.some((x) => x.key === m.key)) {
          matches.push({ key: m.key, reason: String(m.reason || '').slice(0, 240), task: known.get(m.key) });
          if (!found.has(m.key)) report({ type: 'match', key: m.key, reason: clip(m.reason, 240) });
        }
      }
      stage(report, 'rank', 'done', 'rank_done', { matches: matches.length, dropped: raw.length - matches.length });
      return { query: q, matches, usage: sumMetas(metas) };
    } catch (e) {
      report.fail(isAbort(e) ? 'cancelled' : 'error');
      throw e;
    }
  }
}

export function buildSearchPrompt(query, catalog) {
  return (
    'You help a developer find work they did earlier. Below is a list of tasks, one per line: ' +
    'key | kind | repos | last activity | what it was about.\n' +
    `The developer is looking for: "${redact(query)}"\n` +
    'Pick the tasks (at most 8) whose MEANING matches, best first. Use ONLY keys from the list; never invent one. ' +
    'If nothing fits, return an empty list.\n' +
    'Reply ONLY with JSON: {"matches":[{"key":"...","reason":"one short sentence"}]}\n\nTASKS:\n' +
    catalog.map((c) => c.line).join('\n')
  );
}
