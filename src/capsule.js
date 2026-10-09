// Generate a Work Capsule for one task from real sessions, using headless Claude Code (see llm.js).
//
// Pipeline: pick the turn ranges that belong to the task (heuristic candidates + LLM votes) -> condensed REDACTED
// transcript (+ a few lead-up turns) -> LLM writes structured JSON with citations -> drop uncited decisions -> markdown.
// Commits and files come from tool events of the main session AND its subagents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KEY_REGEX } from './config.js';
import { UserError } from './errors.js';
import { Aborted, estimateCost, extractJson, isAbort } from './llm.js';
import { clip, log, makeFindingsScanner, stage, throttle } from './progress.js';
import { isNoise, segment } from './segment.js';
import { countRedactions, findKeys, redact, userText } from './sessions.js';
import { meaningfulText } from './units.js';
import { basename, jsonRecords } from './util.js';

const GIT_RX = /\bgit\s+(commit|push|checkout|switch|merge|rebase|cherry-pick)\b/;
const COMMIT_PUSH_RX = /\bgit\s+(?:-C\s+\S+\s+)?(commit|push)\b/;
const COMMIT_OUT_RX = /^\[(?<branch>[^\]\s]+)(?: \(root-commit\))? (?<hash>[0-9a-f]{7,40})\] (?<msg>.+)$/;
const PUSH_OUT_RX = /^\s*(?<a>[0-9a-f]{7,40})\.\.(?<b>[0-9a-f]{7,40})\s+\S+\s+->\s+(?<dst>\S+)/;
const REVERT_RX = /\bgit\s+(?:checkout|restore|reset|stash|clean|rm)\b|(?:^|[\s;&|])rm\s/;
const RESET_RX = /\bgit\s+reset\b/;
const BULK_REVERT_RX = /\bgit\s+(?:checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+(?:--staged\s+)?\.(?:\s|$)|reset\s+--hard|clean\b|stash(?!\s+(?:pop|apply|list|show|drop)))/;
const PATH_TOKEN_RX = /[\w@.\-[\]()]+(?:\/[\w@.\-[\]()]+)+/g;
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];
const LEAD_TURNS = 4;
export const MAX_TRANSCRIPT_CHARS = 150000;

const CAPSULE_OUTPUT_TOKENS = 3000; // typical size of the structured answer, for the cost estimate

// ---------- loading ----------

/** One turn per real user prompt, plus the full assistant text, edited files and commands that followed it. */
export function loadRichTurns(file, keyRegex = DEFAULT_KEY_REGEX) {
  const turns = [];
  for (const d of jsonRecords(file)) {
    if (d.isSidechain) continue;
    if (d.type === 'user' && !d.isMeta) {
      const txt = userText(d.message);
      if (txt) {
        turns.push({
          ts: d.timestamp, text: txt, branch: d.gitBranch || '', cwd: d.cwd || '', files: [], assistant: [], commands: [],
          noise: isNoise(txt), compaction: txt.startsWith('This session is being continued'),
        });
      }
    } else if (d.type === 'assistant' && turns.length) {
      const content = d.message && d.message.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (!b || typeof b !== 'object') continue;
        const last = turns[turns.length - 1];
        if (b.type === 'text' && (b.text || '').trim()) {
          last.assistant.push(b.text.trim());
        } else if (b.type === 'tool_use') {
          const inp = b.input || {};
          if (inp.file_path && EDIT_TOOLS.includes(b.name)) last.files.push(inp.file_path);
          else if (b.name === 'Bash' && inp.command) last.commands.push(inp.command);
        }
      }
    }
  }
  for (const tr of turns) tr.keys = tr.noise ? [] : findKeys(tr.text, keyRegex);
  return turns;
}

export function sid8(file) {
  return basename(file).slice(0, 8);
}

// ---------- range selection ----------

/** Mergeable [start, end] ranges (inclusive), sorted. */
export function mergeRanges(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (out.length && a <= out[out.length - 1][1] + 1) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Fallback without LLM: heuristic segments whose prompts cite `key`. -> [ranges, candidateBoundaries] */
export function heuristicRanges(turns, key) {
  const [bounds, segs] = segment(turns, { threshold: 0.3 });
  const ranges = segs.filter((s) => key in s.keys).map((s) => [s.start, s.end]);
  return [mergeRanges(ranges), bounds];
}

export function skeleton(turns, candidates) {
  const cand = new Set(candidates);
  return turns.map((t, i) => {
    const txt = redact(t.text).replace(/\n/g, ' ').slice(0, 160);
    const keys = [...new Set(t.keys)].sort().join(',');
    const mark = cand.has(i) ? ' <cand>' : '';
    return `t${i} ${(t.ts || '').slice(5, 16)} keys=[${keys}] cwd=${basename(t.cwd)}${mark} | ${txt}`;
  }).join('\n');
}

export function buildRangesPrompt(key, sessionId, turns, candidates, recall = true) {
  const bias = recall
    ? 'Prioritise COVERAGE: when in doubt, INCLUDE the turn (the next step filters what is extra). ' +
      "Also include measurements, pilots, experiments and context turns that lead to the task's work. "
    : '';
  return (
    `A Claude Code session (${sessionId}, ${turns.length} turns) mixes several tasks. ` +
    `State which turn ranges (indexes t<N>, both inclusive) belong to the task ${key}.\n` +
    `Rules: a task may reappear in several ranges; if the key ${key} shows up late, attribute BACKWARDS ` +
    'the earlier turns that are clearly the same work; do not include turns of other tasks. ' +
    `Turns marked <cand> are candidate boundaries between tasks. ${bias}\n` +
    'Reply ONLY with JSON: {"ranges":[{"start":int,"end":int,"reason":"..."}]}\n\n' +
    skeleton(turns, candidates)
  );
}

/** Validate LLM ranges: ints, clamped to [0, n-1], start<=end, merged. Garbage entries are ignored. */
export function parseRanges(obj, nTurns) {
  const out = [];
  for (const r of (obj && obj.ranges) || []) {
    let a = Number.parseInt(r && r.start, 10);
    let b = Number.parseInt(r && r.end, 10);
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    a = Math.max(0, a);
    b = Math.min(nTurns - 1, b);
    if (a <= b) out.push([a, b]);
  }
  return mergeRanges(out);
}

/** Total number of turns covered by inclusive [start, end] ranges. */
export const countTurns = (ranges) => ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);

/** Ranges kept inside [0, nTurns - 1] and merged; empty or inverted ones are dropped. */
export function clampRanges(ranges, nTurns) {
  const out = [];
  for (const [a, b] of ranges || []) {
    const start = Math.max(0, Math.trunc(a));
    const end = Math.min(nTurns - 1, Math.trunc(b));
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) out.push([start, end]);
  }
  return mergeRanges(out);
}

/**
 * Does this turn carry the work of the unit? Not when it is automatic ("[Request interrupted"), an editor tag or a slash command
 * alone, a greeting or a compaction summary, unless Claude edited files or ran git in it (that work belongs to the unit).
 */
export function usableTurn(t) {
  if (t.noise) return false;
  if (t.files.length || t.commands.some((c) => GIT_RX.test(c))) return true;
  return !t.compaction && Boolean(meaningfulText(t.text));
}

/**
 * The turns of a whole session that count for a unit without a task key: every usable turn (see usableTurn), as inclusive ranges.
 * Nothing is asked of the AI: the unit IS the session, only the noise is left out.
 */
export function meaningfulRanges(turns) {
  const hits = [];
  turns.forEach((t, i) => {
    if (usableTurn(t)) hits.push([i, i]);
  });
  return mergeRanges(hits);
}

/**
 * Ask the LLM `votes` times (in parallel); returns the non-empty per-vote ranges (failed/garbage votes are skipped).
 * Each vote reports itself through `emit` as it finishes. A cancel (Aborted) is never swallowed.
 */
export async function voteRanges(key, file, turns, ask, votes, cands, recall = true, emit = null) {
  const prompt = buildRangesPrompt(key, sid8(file), turns, cands, recall);
  const session = sid8(file);
  let finished = 0;
  const results = await Promise.all(Array.from({ length: votes }, async () => {
    let ranges = [];
    let reason = '';
    try {
      const [text] = await ask(prompt);
      ranges = parseRanges(extractJson(text), turns.length);
    } catch (e) {
      if (isAbort(e)) throw e;
      reason = clip(e.message, 120);
    }
    finished += 1;
    const vars = { n: finished, of: votes, session, ranges: ranges.length, turns: countTurns(ranges) };
    if (ranges.length) log(emit, 'vote_done', vars);
    else log(emit, 'vote_failed', { ...vars, reason }, 'warn');
    return ranges;
  }));
  return results.filter((r) => r.length);
}

/**
 * LLM refinement over heuristic candidates. With votes>1 the UNION of all votes is kept (favours recall,
 * removes run-to-run variance); heuristic fallback if no vote is usable. -> [ranges, mode]
 */
export async function selectRanges(key, file, turns, ask, votes = 1, emit = null) {
  const [fallback, cands] = heuristicRanges(turns, key);
  log(emit, 'votes_start', { votes, session: sid8(file), turns: turns.length });
  const got = await voteRanges(key, file, turns, ask, votes, cands, votes > 1, emit);
  if (!got.length) {
    log(emit, 'votes_fallback', { session: sid8(file) }, 'warn');
    return [fallback, 'heuristic'];
  }
  const union = mergeRanges(got.flat());
  return [union, votes === 1 ? 'llm' : `llm-vote${got.length}/${votes}`];
}

export function citesKey(turns, key) {
  return turns.some((t) => t.keys.includes(key));
}

// ---------- evidence ----------

export function inRanges(i, ranges) {
  return ranges.some(([a, b]) => a <= i && i <= b);
}

/** Up to `lead` turns right before each range (never overlapping the previous range): context on how the work started. */
export function leadRanges(ranges, lead = LEAD_TURNS) {
  const out = [];
  let prevEnd = -1;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const start = Math.max(a - lead, prevEnd + 1);
    if (start < a) out.push([start, a - 1]);
    prevEnd = Math.max(prevEnd, b);
  }
  return out;
}

/** Condensed, redacted transcript of the selected turns (+ lead-up turns, marked). Every line carries a [s:<id> t:<turn>] tag. */
export function buildTranscript(sessionId, turns, ranges, lead = [], promptChars = 700, replyChars = 500) {
  const spans = [...lead.map(([a, b]) => [a, b, true]), ...ranges.map(([a, b]) => [a, b, false])].sort((x, y) => x[0] - y[0]);
  const lines = [];
  for (const [a, b, isLead] of spans) {
    for (let i = a; i <= b; i++) {
      const t = turns[i];
      const tag = `[s:${sessionId} t:${i} ${(t.ts || '').slice(5, 16)}]` + (isLead ? ' (lead-up context)' : '');
      if (!t.noise) lines.push(`${tag} USER: ${redact(t.text).slice(0, promptChars)}`);
      if (t.assistant.length) lines.push(`${tag} CLAUDE: ${redact(t.assistant[t.assistant.length - 1]).slice(0, replyChars)}`);
      for (const fp of [...new Set(t.files)].sort()) lines.push(`${tag}   > edit ${shortPath(fp, t.cwd)}`);
      for (const cmd of t.commands) {
        if (GIT_RX.test(cmd)) lines.push(`${tag}   > bash ${redact(cmd).slice(0, 200)}`);
      }
    }
  }
  return lines.join('\n');
}

/** Shrink per-turn caps until the transcript fits `maxChars` (keeps every turn, trims their text). */
export function boundedTranscript(sessionId, turns, ranges, lead, maxChars) {
  let text = '';
  for (const [pc, rc] of [[700, 500], [350, 250], [180, 120]]) {
    text = buildTranscript(sessionId, turns, ranges, lead, pc, rc);
    if (text.length <= maxChars) return text;
  }
  if (text.length <= maxChars) return text;
  // still too large (a session with hundreds of turns): keep the first and the last lines and say how many were left out
  const lines = text.split('\n');
  const room = Math.max(1, maxChars - 120);
  const head = [];
  const tail = [];
  let used = 0;
  let a = 0;
  let b = lines.length - 1;
  while (a <= b) {
    const next = head.length <= tail.length ? lines[a] : lines[b];
    if (used + next.length + 1 > room) break;
    used += next.length + 1;
    if (head.length <= tail.length) { head.push(next); a += 1; } else { tail.push(next); b -= 1; }
  }
  const skipped = b - a + 1;
  return [...head, ...(skipped > 0 ? [`[... ${skipped} lines from the middle of this session were left out to keep the evidence small ...]`] : []), ...tail.reverse()].join('\n');
}

/**
 * Time windows [[start_ts, end_ts]] of the selected ranges. A range ends when the NEXT prompt starts, so the
 * tool work done during its last turn (edits, commits, subagents) is included; gaps between ranges stay out.
 */
export function sessionWindows(turns, ranges) {
  const out = [];
  for (const [a, b] of ranges) {
    const start = turns[a].ts;
    const end = b + 1 < turns.length ? turns[b + 1].ts : null;
    if (start) out.push([start, end || '9999']);
  }
  return out;
}

export function inWindows(ts, windows) {
  return Boolean(ts) && windows.some(([a, b]) => a <= ts && ts < b);
}

// ---------- tool events (main session + subagents) ----------

const ROOT_CACHE = new Map();

/** Nearest ancestor directory holding a `.git` (dir or worktree file); null if there is none on disk. */
export function repoRoot(file) {
  let d = path.dirname(file);
  const chain = [];
  let root = null;
  while (d && d !== path.dirname(d)) {
    if (ROOT_CACHE.has(d)) {
      root = ROOT_CACHE.get(d);
      break;
    }
    chain.push(d);
    if (fs.existsSync(path.join(d, '.git'))) {
      root = d;
      break;
    }
    d = path.dirname(d);
  }
  for (const c of chain) ROOT_CACHE.set(c, root);
  return root;
}

/** `<repo>/<path inside repo>` instead of a long absolute path (agent worktrees map back to their repo). */
export function shortPath(file, cwd = null) {
  const m = file.match(/^(.*?)\/\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (m) return `${basename(m[1])}/${m[2]}`;
  const root = repoRoot(file);
  if (root) return `${basename(root)}/${path.relative(root, file)}`;
  if (cwd) {
    const base = cwd.replace(/\/+$/, '');
    if (file.startsWith(base + '/')) return `${basename(base)}/${file.slice(base.length + 1)}`;
  }
  const home = os.homedir() + path.sep;
  return file.startsWith(home) ? file.slice(home.length) : file;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

/** Commits / pushes announced in the output of `git commit` / `git push`. */
export function commitEvents(text, ts, source) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = line.trim().match(COMMIT_OUT_RX);
    if (m) {
      out.push({ ts, source, kind: 'commit', hash: m.groups.hash, branch: m.groups.branch, msg: redact(m.groups.msg.trim()).slice(0, 160) });
      continue;
    }
    m = line.match(PUSH_OUT_RX);
    if (m) out.push({ ts, source, kind: 'push', hash: m.groups.b, ref: m.groups.dst });
  }
  return out;
}

/** Edits, revert-like commands, commits and pushes found in one transcript file. */
export function scanFile(file, source, skipSidechain) {
  const events = [];
  const pending = new Map();
  for (const d of jsonRecords(file)) {
    const ts = d.timestamp;
    const content = d.message && d.message.content;
    if (!ts || !Array.isArray(content) || (skipSidechain && d.isSidechain)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const inp = b.input || {};
        if (EDIT_TOOLS.includes(b.name) && inp.file_path) {
          events.push({ ts, source, kind: 'edit', path: inp.file_path, cwd: d.cwd || '' });
        } else if (b.name === 'Bash' && inp.command) {
          const cmd = inp.command;
          if (REVERT_RX.test(cmd)) events.push({ ts, source, kind: 'revert', cmd });
          if (COMMIT_PUSH_RX.test(cmd)) pending.set(b.id, cmd);
        }
      } else if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
        events.push(...commitEvents(resultText(b.content), ts, source));
      }
    }
  }
  return events;
}

/** All tool events of a session: its main transcript plus every subagent transcript (subagents/ folder). */
export function scanEvents(file) {
  const events = scanFile(file, 'main', true);
  const subDir = path.join(path.dirname(file), basename(file).replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(subDir).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    /* no subagents folder */
  }
  for (const n of names) events.push(...scanFile(path.join(subDir, n), n.replace(/\.jsonl$/, '').slice(0, 14), false));
  return events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** True if a revert-like command explicitly names this file (or one of its parent directories). */
export function revertsPath(ev, file) {
  const cmd = ev.cmd.replace(/\\\n/g, ' ').replace(/\bcd\s+"?[^\s"&;]+/g, ' '); // `cd <repo>` is not a reverted path
  for (let tok of cmd.match(PATH_TOKEN_RX) || []) {
    if (tok.startsWith('./')) tok = tok.slice(2);
    tok = tok.replace(/\/+$/, '');
    if ((tok.match(/\//g) || []).length >= 1 && (file.endsWith('/' + tok) || file.includes('/' + tok + '/'))) return true;
  }
  return false;
}

/** `git checkout .`, `git reset --hard`, `git stash`... : hits files in the `cd` dir, or else the same agent's files. */
export function revertsBulk(ev, editSource, file) {
  if (!BULK_REVERT_RX.test(ev.cmd)) return false;
  const m = ev.cmd.match(/\bcd\s+"?([^\s"&;]+)/);
  return m ? file.startsWith(m[1].replace(/\/+$/, '') + '/') : ev.source === editSource;
}

/** False for files that are not task work: Claude's own memory/config, scratch/temp dirs, handoff notes. */
export function isWorkFile(file) {
  if (/\/\.claude\/worktrees\//.test(file)) return true;
  if (file.includes('/.claude/') || ['/tmp/', '/private/tmp/', '/var/folders/'].some((p) => file.startsWith(p))) return false;
  return !(basename(file) === 'HANDOFF.md' && file.includes('/docs/handoff/'));
}

/**
 * [{path, short, edits, status, last}] for files edited inside `windows`.
 * status = 'reverted' if a later revert command (explicit path, or a bulk revert inside the windows) hit it, else 'final'.
 */
export function collectFiles(events, windows) {
  const info = new Map();
  for (const e of events) {
    if (e.kind === 'edit' && inWindows(e.ts, windows) && isWorkFile(e.path)) {
      let f = info.get(e.path);
      if (!f) {
        f = { edits: 0, last: '', source: e.source, cwd: e.cwd || '' };
        info.set(e.path, f);
      }
      f.edits += 1;
      if (e.ts >= f.last) {
        f.last = e.ts;
        f.source = e.source;
      }
    }
  }
  for (const e of events) {
    if (e.kind !== 'revert') continue;
    for (const [file, f] of info) {
      if (e.ts <= f.last) continue;
      if (revertsPath(e, file) || (inWindows(e.ts, windows) && revertsBulk(e, f.source, file))) {
        f.status = 'reverted';
        f.revert_ts = e.ts;
      }
    }
  }
  const out = [...info].map(([p, f]) => ({
    path: p, short: shortPath(p, f.cwd), edits: f.edits, status: f.status || 'final', last: f.last,
  }));
  return sortFiles(out);
}

function sortFiles(list) {
  return list.sort((a, b) => (a.status !== 'final') - (b.status !== 'final') || (a.short < b.short ? -1 : a.short > b.short ? 1 : 0));
}

/** Merge per-session file lists by short path: edits add up; the status of the latest edit wins. */
export function mergeFiles(lists) {
  const byPath = new Map();
  for (const lst of lists) {
    for (const f of lst) {
      const cur = byPath.get(f.short);
      if (!cur) {
        byPath.set(f.short, { ...f });
      } else {
        cur.edits += f.edits;
        if (f.last >= cur.last) {
          cur.status = f.status;
          cur.last = f.last;
        }
      }
    }
  }
  return sortFiles([...byPath.values()]);
}

/**
 * Heuristic: a later `git reset` by the same agent/session part, or one that names the commit hash, probably
 * unwound the commit (typically `reset --soft` to leave the changes as a pending diff). Not proof: git history is not read.
 */
export function undoneByReset(commit, events) {
  for (const e of events) {
    if (e.kind !== 'revert' || e.ts <= commit.ts || !RESET_RX.test(e.cmd)) continue;
    if (e.source === commit.source && commit.source !== 'main') return true;
    if (e.cmd.includes(commit.hash.slice(0, 7))) return true;
  }
  return false;
}

/**
 * Commits made inside `windows` (main session + subagents). Split in 'confirmed' (key in message/branch) and
 * 'possible' (same time window, no key: may belong to another interleaved task). `pushed` comes from any push of the session.
 */
export function collectCommits(events, windows, key, keyed = true) {
  const pushes = events.filter((e) => e.kind === 'push').map((e) => e.hash);
  const seen = new Set();
  const out = { confirmed: [], possible: [] };
  for (const e of events) {
    if (e.kind !== 'commit' || !inWindows(e.ts, windows) || seen.has(e.hash)) continue;
    seen.add(e.hash);
    const item = {
      hash: e.hash, branch: e.branch, msg: e.msg, source: e.source, ts: e.ts,
      pushed: pushes.some((p) => p.startsWith(e.hash) || e.hash.startsWith(p)),
    };
    item.undone = undoneByReset(item, events);
    // a unit without a task key has nothing to match: the windows are its own messages, so every commit in them is its commit
    const match = !keyed || `${e.msg} ${e.branch}`.toLowerCase().includes(key.toLowerCase());
    out[match ? 'confirmed' : 'possible'].push(item);
  }
  return out;
}

export function mergeCommits(parts) {
  const out = { confirmed: [], possible: [] };
  const seen = new Set();
  for (const p of parts) {
    for (const kind of Object.keys(out)) {
      for (const c of p[kind]) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          out[kind].push(c);
        }
      }
    }
  }
  return out;
}

export function commitLine(c) {
  return `${c.hash} [${c.branch}] ${c.msg}` + (c.pushed ? ' (pushed)' : '') +
    (c.undone ? ' (possibly undone by a later reset?)' : '') + ` · ${c.source} ${c.ts.slice(5, 16)}`;
}

// ---------- LLM prompt ----------

const CAPSULE_SCHEMA = `{
 "objective": "1-3 sentences",
 "timeline": [{"date": "MM-DD", "repo": "...", "result": "one line", "cites": [{"session": "id8", "turn": N}]}],
 "decisions": [{"decision": "...", "why": "...", "cites": [{"session": "id8", "turn": N}], "uncertain": false}],
 "dead_ends": [{"text": "...", "cites": [{"session": "id8", "turn": N}]}],
 "left_out": [{"text": "what was left out of the branch/commit/scope, and why", "cites": [{"session": "id8", "turn": N}]}],
 "pending": [{"text": "...", "cites": []}],
 "briefing": "one paragraph to paste into a fresh Claude session, including any user rules visible in the evidence"
}`;

/** The unit a capsule is written for. Without `unit` it is a task key (the key is the name). `keyed: false` = no task key. */
const unitOf = (key, unit) => ({ keyed: !unit || unit.keyed !== false, label: (unit && unit.label) || '' });

/** files: [{short, edits, status}]; commits: {confirmed: [...], possible: [...]} (real data from tool events). unit: {keyed, label}. */
export function buildCapsulePrompt(key, transcript, files, commits, language = 'English', unit = null) {
  const u = unitOf(key, unit);
  const final = files.filter((f) => f.status === 'final').map((f) => `${f.short} (${f.edits}x)`).slice(0, 40);
  const reverted = files.filter((f) => f.status === 'reverted').map((f) => f.short).slice(0, 20);
  const confirmed = commits.confirmed.map(commitLine).slice(0, 20);
  const possible = commits.possible.map(commitLine).slice(0, 20);
  const what = u.keyed
    ? `the task ${key}`
    : `a unit of work that has no task key${u.label ? `, named "${redact(u.label)}"` : ''}`;
  const keyless = u.keyed ? '' :
    '- This work has no task key. Do NOT invent a key, ticket number or branch name. The objective comes from what the user asked for in the ' +
    "evidence; the unit's name is only a hint and may be imperfect.\n";
  const lead = u.keyed
    ? 'Lines marked "(lead-up context)" are turns ' + "before the task's work: use them only to explain where the finding came from; they may belong to another task.\n"
    : 'Every line of the evidence belongs to this work.\n';
  return (
    `You are an analyst. Below is the evidence (condensed, redacted transcript) of the work on ${what}. ` +
    `Every line starts with a tag [s:<session> t:<turn> date]. ${lead}` +
    `Write, in ${language}, a record of the task as JSON with exactly this schema:\n${CAPSULE_SCHEMA}\n` +
    'Strict rules:\n' +
    '- Use ONLY facts present in the evidence. Do not invent. If something is doubtful, set "uncertain": true or say so in the text.\n' +
    '- Every decision, dead end and "left_out" item MUST carry at least one {session, turn} citation taken from the tags.\n' +
    "- Decisions often come from the user's corrections or instructions; include the why only if it is in the evidence.\n" +
    '- Include secondary decisions too: accessibility, conventions copied from other components, feature flags ' +
    '(and whether their final decision was left unrecorded), and what was left out of the branch, commit or scope ("left_out").\n' +
    '- Files marked as reverted were a discarded attempt: do not present them as part of the final result.\n' +
    '- A commit marked "possibly undone by a later reset" is probably no longer on the branch (the changes were left as a pending diff): ' +
    'do not claim it exists in the final state or that "there were no commits"; explain both facts.\n' +
    '- If a commit or push happened without the user asking for it and the evidence shows it (user complaint), say so in the text.\n' +
    keyless +
    '- Do not include secrets, tokens or passwords.\n\n' +
    `Final files (real data): ${final.join(', ') || 'none'}\n` +
    `Reverted/discarded files (real data): ${reverted.join(', ') || 'none'}\n` +
    (u.keyed
      ? `Commits of the task (real data): ${confirmed.join(' | ') || 'none'}\n` +
        `Commits in the same time window without the task key (possible, may belong to another task): ${possible.join(' | ') || 'none'}\n\n`
      : `Commits made during this work (real data): ${[...confirmed, ...possible].join(' | ') || 'none'}\n\n`) +
    `EVIDENCE:\n${transcript}`
  );
}

// ---------- validation + rendering ----------

/** valid: {sessionId: [[start, end], ...]} - a citation must point inside a selected range. */
export function citeOk(c, valid) {
  const turn = Number.parseInt(c && c.turn, 10);
  if (!c || Number.isNaN(turn) || c.session == null) return false;
  return inRanges(turn, valid[String(c.session)] || []);
}

/** Drop decisions / dead ends / left-out items without a valid citation; strip invalid citations elsewhere. -> [clean, dropped] */
export function validateCapsule(cap, valid) {
  const dropped = { decisions: 0, dead_ends: 0, left_out: 0 };
  const clean = { ...cap };
  for (const field of ['decisions', 'dead_ends', 'left_out']) {
    const kept = [];
    for (const item of cap[field] || []) {
      const cites = (item.cites || []).filter((c) => citeOk(c, valid));
      if (cites.length) kept.push({ ...item, cites });
      else dropped[field] += 1;
    }
    clean[field] = kept;
  }
  for (const field of ['timeline', 'pending']) {
    clean[field] = (cap[field] || []).map((i) => ({ ...i, cites: (i.cites || []).filter((c) => citeOk(c, valid)) }));
  }
  // `ts` is computed from the cited message when the capsule is read; never keep one the model wrote.
  clean.timeline = clean.timeline.map(({ ts: _invented, ...row }) => row);
  return [clean, dropped];
}

const fmtCites = (cites) => (cites || []).map((c) => `\`${c.session}:${c.turn}\``).join(' ');

function commitMd(c) {
  return `- \`${c.hash}\` \`${c.branch}\` · ${c.msg}` + (c.pushed ? ' · _pushed_' : '') +
    (c.undone ? ' · _possibly undone by a later reset?_' : '') + ` · ${c.source}`;
}

export function renderMarkdown(key, cap, files, commits, sources, unit = null) {
  const u = unitOf(key, unit);
  const L = [`# Work capsule · ${u.keyed ? key : redact(u.label) || key}`, '',
    `> Generated automatically from: ${sources.join(', ')}. Citations \`session:turn\` point to the evidence.`, '',
    '## Objective', cap.objective || '_(no data)_', '', '## Timeline',
    '| Date | Repo | Result | Evidence |', '|---|---|---|---|'];
  for (const t of cap.timeline || []) L.push(`| ${t.date || ''} | ${t.repo || ''} | ${t.result || ''} | ${fmtCites(t.cites)} |`);
  L.push('', '## Decisions and why');
  for (const d of cap.decisions || []) {
    L.push(`- **${d.decision || ''}**${d.uncertain ? ' _(uncertain)_' : ''} — ${d.why || 'no reason in the evidence'} ${fmtCites(d.cites)}`);
  }
  const final = files.filter((f) => f.status === 'final');
  const reverted = files.filter((f) => f.status === 'reverted');
  L.push('', '## Files touched', '**Final**');
  if (final.length) L.push(...final.slice(0, 40).map((f) => `- \`${f.short}\` (${f.edits}x)`));
  else L.push('_(none)_');
  if (final.length > 40) L.push(`- _… and ${final.length - 40} more_`);
  if (reverted.length) {
    L.push('', '**Reverted or discarded** (attempt that did not stay)');
    L.push(...reverted.slice(0, 20).map((f) => `- \`${f.short}\` (${f.edits}x)`));
  }
  L.push('', '## Commits');
  L.push(...(commits.confirmed.length ? commits.confirmed.map(commitMd) : [u.keyed ? '_(none carrying the task key)_' : '_(none)_']));
  if (commits.possible.length) {
    L.push('', '**Same time window, no key** (may belong to another task)');
    L.push(...commits.possible.map(commitMd));
  }
  const bullets = (items) => (items && items.length ? items.map((c) => `- ${c.text || ''} ${fmtCites(c.cites)}`) : ['_(none)_']);
  L.push('', '## Dead ends', ...bullets(cap.dead_ends));
  L.push('', '## Left out', ...bullets(cap.left_out));
  L.push('', '## Pending', ...(cap.pending && cap.pending.length ? cap.pending.map((p) => `- ${p.text || ''} ${fmtCites(p.cites)}`.trimEnd()) : ['_(none)_']));
  L.push('', '## Briefing to resume', '> ' + (cap.briefing || '_(no data)_').replace(/\n/g, '\n> '), '');
  return L.join('\n');
}

// ---------- planning + generation ----------

/**
 * Does this session need LLM range selection? Only when its prompts cite the key; otherwise the whole session
 * belongs to the task (key came from the branch name, or the session is a single-task one). Never when the turns of the unit
 * are already known (`item.ranges`: a single session, a group of the user's, a part of a session the user or the AI cut).
 */
export function planRanges(item, key, useLlmRanges) {
  return useLlmRanges && !item.ranges && item.mode === 'keyed' && citesKey(item.turns, key);
}

export const PROMPT_BASE_CHARS = 2500; // buildCapsulePrompt() without evidence, files or commits (a test keeps it honest)

/** Rough cost estimate before spending anything. Uses heuristic ranges (no LLM) to size the transcript. */
export function estimateTask(key, plan, votes = 3, useLlmRanges = true, maxChars = MAX_TRANSCRIPT_CHARS) {
  let calls = 1;
  let chars = 0;
  for (const item of plan) {
    const turns = item.turns;
    let ranges;
    if (item.ranges) {
      ranges = clampRanges(item.ranges, turns.length);
      if (ranges.length) chars += boundedTranscript(sid8(item.path), turns, ranges, [], Math.floor(maxChars / Math.max(1, plan.length))).length;
      continue;
    }
    if (planRanges(item, key, useLlmRanges)) {
      const [r, cands] = heuristicRanges(turns, key);
      calls += votes;
      chars += votes * skeleton(turns, cands).length;
      ranges = r.length ? r : [[0, turns.length - 1]];
    } else {
      ranges = [[0, turns.length - 1]];
    }
    if (turns.length) chars += boundedTranscript(sid8(item.path), turns, ranges, leadRanges(ranges), Math.floor(maxChars / Math.max(1, plan.length))).length;
  }
  chars += PROMPT_BASE_CHARS; // the instructions around the evidence
  return estimateCost(calls, chars, CAPSULE_OUTPUT_TOKENS + (calls - 1) * 200);
}

/** Credential-like strings that `redact` will mask in the text this task can send (prompts, last replies, git commands). */
function maskedIn(turns) {
  let n = 0;
  for (const t of turns) {
    n += countRedactions(t.text) + countRedactions(t.assistant.length ? t.assistant[t.assistant.length - 1] : '');
    for (const cmd of t.commands) if (GIT_RX.test(cmd)) n += countRedactions(cmd);
  }
  return n;
}

/** How many messages (turns) the plan will send, and whether they are all known without asking the AI. -> {turns, known} */
export function planSize(plan) {
  let turns = 0;
  let known = true;
  for (const item of plan) {
    if (item.ranges) turns += countTurns(clampRanges(item.ranges, item.turns.length));
    else {
      turns += item.turns.length;
      known = false;
    }
  }
  return { turns, known: known && plan.length > 0 };
}

/**
 * plan: [{path, turns, mode: 'keyed'|'whole', ranges?}]. `ranges` (inclusive turn ranges) are the turns of the unit when they are
 * already known: the AI is not asked to pick them and no lead-up turns are added.
 * `unit` ({keyed, label}) says what the capsule is about when it is not a task key. `ask` is async: (prompt, {onText}?) -> [text, meta].
 * Returns a result dict (also the cache format). `emit` (optional) receives real progress events (see progress.js);
 * `signal` (optional AbortSignal) stops the pipeline between steps (running LLM calls are stopped by `ask` itself).
 */
export async function generate(key, plan, ask, { votes = 3, language = 'English', useLlmRanges = true, maxChars = MAX_TRANSCRIPT_CHARS, emit = null, signal = null, unit = null } = {}) {
  if (!plan.length) throw new Error(`No sessions found for ${key}`);
  const u = unitOf(key, unit);
  const check = () => {
    if (signal && signal.aborted) throw new Aborted();
  };
  check();

  stage(emit, 'redact', 'running');
  const withTurns = plan.filter((item) => item.turns.length);
  const masked = withTurns.reduce((n, item) => n + maskedIn(item.turns), 0);
  const nPrompts = withTurns.reduce((n, item) => n + item.turns.length, 0);
  stage(emit, 'redact', 'done', masked ? 'redact_done' : 'redact_none', { masked, turns: nPrompts });

  const needsVotes = withTurns.some((item) => planRanges(item, key, useLlmRanges));
  const size = planSize(withTurns);
  if (needsVotes) stage(emit, 'votes', 'running');
  else if (size.known) stage(emit, 'votes', 'skipped', 'votes_skipped_known', { sessions: withTurns.length, turns: size.turns });
  else stage(emit, 'votes', 'skipped', 'votes_skipped', { sessions: withTurns.length });
  const selected = [];
  const modes = {};
  for (const item of plan) {
    check();
    const { turns } = item;
    const sid = sid8(item.path);
    if (!turns.length) continue;
    let ranges;
    if (item.ranges) {
      ranges = clampRanges(item.ranges, turns.length);
      modes[sid] = 'known-ranges';
    } else if (planRanges(item, key, useLlmRanges)) {
      [ranges, modes[sid]] = await selectRanges(key, item.path, turns, ask, votes, emit);
    } else if (item.mode === 'keyed' && citesKey(turns, key)) {
      [ranges] = heuristicRanges(turns, key);
      modes[sid] = 'heuristic';
    } else {
      ranges = [[0, turns.length - 1]];
      modes[sid] = 'whole-session';
    }
    if (ranges.length) selected.push({ item, sid, ranges });
  }
  if (needsVotes) stage(emit, 'votes', 'done', 'votes_done', { sessions: withTurns.filter((item) => planRanges(item, key, useLlmRanges)).length });

  stage(emit, 'merge', 'running');
  if (!selected.length) {
    if (!u.keyed) throw new UserError('This unit has no real messages to summarize.');
    throw new Error(`No usable turns found for ${key}`);
  }
  const selectedTurns = selected.reduce((n, s) => n + countTurns(s.ranges), 0);
  stage(emit, 'merge', 'done', 'merge_done', { turns: selectedTurns, sessions: selected.length, ranges: selected.reduce((n, s) => n + s.ranges.length, 0) });

  check();
  stage(emit, 'evidence', 'running');
  const parts = [];
  const valid = {};
  const fileLists = [];
  const commitParts = [];
  const sources = [];
  for (const { item, sid, ranges } of selected) {
    const lead = item.ranges ? [] : leadRanges(ranges); // known turns: nothing around them is borrowed
    valid[sid] = mergeRanges([...ranges, ...lead]);
    sources.push(`\`${sid}\` (turns ${ranges.map(([a, b]) => `${a}-${b}`).join(', ')})`);
    parts.push(boundedTranscript(sid, item.turns, ranges, lead, Math.floor(maxChars / Math.max(1, plan.length))));
    const events = scanEvents(item.path);
    const windows = sessionWindows(item.turns, ranges);
    fileLists.push(collectFiles(events, windows));
    commitParts.push(collectCommits(events, windows, key, u.keyed));
  }
  const transcript = parts.join('\n');
  const files = mergeFiles(fileLists);
  const commits = mergeCommits(commitParts);
  stage(emit, 'evidence', 'done', 'evidence_done', { files: files.length, commits: commits.confirmed.length + commits.possible.length, chars: transcript.length });

  check();
  stage(emit, 'write', 'running');
  log(emit, 'write_start');
  let onText = null;
  if (emit) {
    const scan = makeFindingsScanner();
    const tick = throttle((text) => emit({ type: 'progress', id: 'write', approx_tokens: Math.ceil(text.length / 4) }));
    onText = (text) => {
      for (const f of scan(text)) log(emit, `found_${f.kind}`, { text: clip(f.text) });
      tick(text);
    };
  }
  const [text, meta] = await ask(buildCapsulePrompt(key, transcript, files, commits, language, u), { onText });
  stage(emit, 'write', 'done', 'write_done', { tokens: ((meta && meta.input_tokens) || 0) + ((meta && meta.output_tokens) || 0) });

  stage(emit, 'validate', 'running');
  const raw = extractJson(text);
  const [clean, dropped] = validateCapsule(raw, valid);
  const total = ['decisions', 'dead_ends', 'left_out'].reduce((n, f) => n + (Array.isArray(raw[f]) ? raw[f].length : 0), 0);
  const lost = dropped.decisions + dropped.dead_ends + dropped.left_out;
  stage(emit, 'validate', 'done', 'validate_done', { kept: total - lost, total, dropped: lost });
  if (lost) log(emit, 'validate_dropped', { dropped: lost }, 'warn');
  const info = { range_mode: modes, dropped, transcript_chars: transcript.length, capsule_call: meta };
  const publicFiles = files.map(({ path: _omit, ...rest }) => rest); // no absolute paths in the cache
  return {
    key, capsule: clean, files: publicFiles, commits, sources, info,
    markdown: renderMarkdown(key, clean, files, commits, sources, u),
  };
}
