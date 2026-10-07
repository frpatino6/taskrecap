// Parse Claude Code session jsonl files and detect a work key per session.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KEY_REGEX } from './config.js';
import { Counter, basename, jsonRecords } from './util.js';

// Tokens that match a Jira-style key regex but are not work keys.
export const KEY_STOPLIST_PREFIXES = new Set([
  'UTF', 'SHA', 'ISO', 'MD', 'AES', 'RSA', 'HTTP', 'TLS', 'SSL', 'RFC', 'CVE',
  'WCAG', 'ES', 'X', 'TCP', 'UDP', 'PNG', 'JPEG', 'IPV', 'EC', 'HS', 'RS',
  'IE', 'COVID', 'GPT', 'BASE', 'CRC', 'UUID', 'JWT', 'PDF', 'CSS', 'ARIA', 'SIGINT',
]);
export const GENERIC_BRANCHES = new Set(['main', 'master', 'HEAD', 'develop', 'dev', '']);
export const UNASSIGNED = 'unassigned';
export const KEY_MIN_MENTIONS = 2; // a key counts for a session it is not the main key of only if prompts cite it this often

const SECRET_CASE_SENSITIVE = /(eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[bap]-[A-Za-z0-9-]{10,})/g;
const SECRET_ASSIGNMENT = /(?:password|passwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi;

/** Replace credentials (JWTs, API keys, `password=...`) with [REDACTED]. Always applied before any LLM call. */
export function redact(text) {
  return String(text || '').replace(SECRET_CASE_SENSITIVE, '[REDACTED]').replace(SECRET_ASSIGNMENT, '[REDACTED]');
}

/** How many credential-like strings `redact` would mask in `text` (used to tell the user what was masked). */
export function countRedactions(text) {
  const s = String(text || '');
  return (s.match(SECRET_CASE_SENSITIVE) || []).length +
    (s.replace(SECRET_CASE_SENSITIVE, '[REDACTED]').match(SECRET_ASSIGNMENT) || []).length;
}

const regexCache = new Map();

/** Compile a user-provided key regex once (global flag, so matchAll works). Throws on an invalid pattern. */
export function toRegex(keyRegex) {
  if (keyRegex instanceof RegExp) return keyRegex.global ? keyRegex : new RegExp(keyRegex.source, keyRegex.flags + 'g');
  let rx = regexCache.get(keyRegex);
  if (!rx) {
    rx = new RegExp(keyRegex, 'g');
    regexCache.set(keyRegex, rx);
  }
  return rx;
}

/** Work-key candidates in `text`, ignoring known false positives (UTF-8, SHA-256, ...). */
export function findKeys(text, keyRegex = DEFAULT_KEY_REGEX) {
  const keys = [];
  for (const m of String(text || '').matchAll(toRegex(keyRegex))) {
    const k = m[0];
    if (!k) continue;
    if (KEY_STOPLIST_PREFIXES.has(k.split('-')[0].replace(/[0-9]+$/, ''))) continue;
    keys.push(k);
  }
  return keys;
}

const INJECTED_PREFIXES = ['<system-reminder>', '<command-', '<local-command', '<task-notification', 'Caveat:'];

/** Plain text of a real user prompt, or '' for tool results / injected reminders. */
export function userText(msg) {
  let content = msg && msg.content;
  if (Array.isArray(content)) {
    content = content.filter((b) => b && typeof b === 'object' && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  content = String(content || '').trim();
  if (!content || INJECTED_PREFIXES.some((p) => content.startsWith(p))) return '';
  return content;
}

/** Light parse of one session file: prompts, branches, timestamps and `git commit` commands. */
export function parseSession(file) {
  const s = {
    path: file,
    id: basename(file).replace(/\.jsonl$/, ''),
    project: basename(path.dirname(file)),
    size: fs.statSync(file).size,
    title: null,
    cwd: null,
    branches: new Counter(),
    first_ts: null,
    last_ts: null,
    prompts: [],
    commits: [],
  };
  for (const d of jsonRecords(file)) {
    if (d.type === 'custom-title') s.title = d.customTitle;
    const ts = d.timestamp;
    if (ts) {
      if (!s.first_ts || ts < s.first_ts) s.first_ts = ts;
      if (!s.last_ts || ts > s.last_ts) s.last_ts = ts;
    }
    if (d.gitBranch) s.branches.add(d.gitBranch);
    s.cwd = s.cwd || d.cwd || null;
    if (d.isSidechain) continue;
    if (d.type === 'user' && !d.isMeta) {
      const txt = userText(d.message);
      if (txt) s.prompts.push({ ts, text: txt });
    } else if (d.type === 'assistant') {
      const content = d.message && d.message.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (!b || b.type !== 'tool_use' || b.name !== 'Bash') continue;
        const cmd = (b.input && b.input.command) || '';
        if (/\bgit\s+commit\b/.test(cmd)) s.commits.push(cmd);
      }
    }
  }
  return s;
}

/** Layered detection -> [key, method]. Never invents a key. */
export function detectKey(s, keyRegex = DEFAULT_KEY_REGEX) {
  for (const [br] of s.branches.mostCommon()) {
    const k = findKeys(br, keyRegex);
    if (k.length) return [k[0], 'branch-regex'];
  }
  const counter = new Counter();
  for (const p of s.prompts) for (const k of findKeys(p.text, keyRegex)) counter.add(k);
  for (const c of s.commits) for (const k of findKeys(c, keyRegex)) counter.add(k);
  if (counter.size) return [counter.mostCommon(1)[0][0], 'prompt-or-commit-regex'];
  for (const [br] of s.branches.mostCommon()) {
    if (!GENERIC_BRANCHES.has(br) && !br.startsWith('worktree-agent-')) return [br, 'branch-name'];
  }
  return [UNASSIGNED, 'none'];
}

/** How many real prompts cite each key (a prompt counts once per key). */
export function promptKeyCounts(s, keyRegex = DEFAULT_KEY_REGEX) {
  const counts = new Counter();
  for (const p of s.prompts) for (const k of new Set(findKeys(p.text, keyRegex))) counts.add(k);
  return counts;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar day ('YYYY-MM-DD') of an ISO timestamp, or null. Local, because the server runs on the user's own machine. */
export function localDay(ts) {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Real prompts per local day: {days: {day: n}, keyDays: {key: {day: n}}} where keyDays only counts the prompts that cite
 * each key. Feeds the home timeline; prompts without a usable timestamp are skipped.
 */
export function promptDays(s, keyRegex = DEFAULT_KEY_REGEX) {
  const days = {};
  const keyDays = {};
  for (const p of s.prompts) {
    const day = localDay(p.ts);
    if (!day) continue;
    days[day] = (days[day] || 0) + 1;
    for (const k of new Set(findKeys(p.text, keyRegex))) {
      if (!keyDays[k]) keyDays[k] = {};
      keyDays[k][day] = (keyDays[k][day] || 0) + 1;
    }
  }
  return { days, keyDays };
}

/** Human name of the repo: last folder of the session's working directory. */
export function projectName(s) {
  if (s.cwd) return basename(s.cwd) || s.cwd;
  return s.project;
}
