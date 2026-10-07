// Application layer shared by the CLI and the web server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as capsule from './capsule.js';
import { APP_NAME, APP_TITLE, DEFAULT_KEY_REGEX, VERSION } from './config.js';
import { Aborted, estimateCost, extractJson, askLlm, isAbort } from './llm.js';
import { readEvidence, parseSources, resolveSession } from './evidence.js';
import { FileIndex } from './files.js';
import { STAGES, clip, log, makeMatchScanner, makeReporter, stage, throttle } from './progress.js';
import { CapsuleSearch } from './search.js';
import { UNASSIGNED, redact } from './sessions.js';
import { CapsuleStore, SessionIndex, isGeneratable, planTask } from './tasks.js';
import { UsageTracker, sumMetas } from './usage.js';

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

/** A capsule for this key is already being generated. */
export class Busy extends Error {
  constructor(key) {
    super(`Busy: ${key}`);
    this.name = 'Busy';
  }
}

/** Bad input from the user (maps to HTTP 400). */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

export class App {
  /**
   * @param {object} o
   * @param {string} o.projectsDir where the session jsonl files live
   * @param {string} o.cacheDir where capsules are cached
   * @param {(prompt: string) => Promise<[string, object]>} [o.ask] LLM function (injectable for tests)
   * @param {string|null} [o.usageFile] where the cumulative token counter is persisted
   */
  constructor({ projectsDir, cacheDir, keyRegex = DEFAULT_KEY_REGEX, ask = null, lang = 'en', demo = false, model = 'sonnet', votes = 3, usageFile = null }) {
    this.projectsDir = projectsDir;
    this.keyRegex = keyRegex;
    this.lang = lang;
    this.demo = demo;
    this.model = model;
    this.votes = votes;
    this.index = new SessionIndex(projectsDir, keyRegex);
    this.store = new CapsuleStore(cacheDir);
    this.capsuleSearch = new CapsuleSearch(this.store);
    this.fileIndex = new FileIndex(this.index, this.store, path.join(cacheDir, '.index', 'files.json')); // not a capsule: all() only reads <key>.json
    this.strings = loadStrings(lang);
    this.usage = new UsageTracker(usageFile);
    this.rawAsk = ask;
    this.busy = new Set();
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
    };
  }

  usageSnapshot() {
    return this.usage.snapshot();
  }

  listTasks() {
    const objectives = new Map(this.store.all().map((c) => [c.key, (c.capsule && c.capsule.objective) || '']));
    const tasks = this.index.tasks();
    for (const t of tasks) {
      t.has_capsule = objectives.has(t.key);
      t.objective = objectives.get(t.key) || '';
      t.generatable = isGeneratable(t.key);
    }
    return tasks;
  }

  taskDetail(key) {
    const sessions = this.index.taskSessions(key).map(([s]) => {
      const { path: _p, mentions: _m, ...rest } = s;
      return rest;
    });
    sessions.sort((a, b) => ((a.first_ts || '') < (b.first_ts || '') ? -1 : (a.first_ts || '') > (b.first_ts || '') ? 1 : 0));
    const task = this.listTasks().find((t) => t.key === key) || null;
    const cap = this.store.load(key);
    if (!task && !sessions.length && !cap) return null;
    return { task, sessions, capsule: cap };
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
    return this.capsuleSearch.coverage(this.index.tasks());
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
    const file = resolveSession(this.index.listFiles(), session);
    const cap = key ? this.store.load(key) : null;
    const ranges = cap ? (parseSources(cap.sources)[String(session).toLowerCase()] || null) : null;
    return readEvidence(file, turn, { context, ranges });
  }

  withTask(link, t) {
    return { ...link, kind: t ? t.kind : 'key', text: t ? t.objective || t.snippet : '', last_ts: t ? t.last_ts : null, has_capsule: t ? t.has_capsule : false };
  }

  // --- AI actions (spend tokens; callers must have confirmed with the user first) ---
  checkKey(key) {
    if (!isGeneratable(key)) {
      throw new UserError('Sessions without a task key cannot be turned into a capsule. ' +
        'Name your branches after the task, or mention a task key in your prompts.');
    }
  }

  estimate(key) {
    this.checkKey(key);
    const plan = planTask(this.index, key);
    if (!plan.length) throw new UserError(`No sessions found for ${key}`);
    const est = capsule.estimateTask(key, plan, this.votes);
    return { ...est, sessions: plan.length, model: this.model };
  }

  /**
   * Builds and caches the capsule of `key`. `emit` (optional) receives real progress events; `signal` (optional
   * AbortSignal) cancels it: running `claude -p` processes are killed and nothing is saved.
   */
  async generate(key, { emit = null, signal = null } = {}) {
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
      const plan = planTask(this.index, key);
      if (!plan.length) throw new UserError(`No sessions found for ${key}`);
      stage(report, 'scan', 'done', 'scan_done', { sessions: plan.length, turns: plan.reduce((n, p) => n + p.turns.length, 0) });
      const result = await capsule.generate(key, plan, ask, { votes: this.votes, language: this.strings.llm_language || 'English', emit: report, signal });
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
    return this.index.tasks().filter((t) => t.kind !== UNASSIGNED).slice(0, SEARCH_MAX_TASKS).map((t) => {
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
