// Free, local evidence lookup: turns a capsule citation ({session: id8, turn: N}) back into the original messages.
// Turn numbers come from loadRichTurns(), the same loader the capsule generator used, so the indexing is identical.
import os from 'node:os';
import path from 'node:path';
import { loadRichTurns } from './capsule.js';
import { redact } from './sessions.js';
import { basename } from './util.js';

export const MAX_CONTEXT = 5;
export const DEFAULT_CONTEXT = 2;
const MAX_TEXT_CHARS = 4000; // per message, after redaction
const MAX_COMMANDS = 8;
const LEAD_TURNS = 4; // the generator also allows citing the lead-up turns just before a selected range

/** Why a citation could not be resolved. code: bad_request | not_found | ambiguous | turn_missing. */
export class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

/** Session files whose id starts with `id` (case-insensitive). Cites carry the first 8 characters of the id. */
export function resolveSession(files, id) {
  const wanted = String(id || '').trim().toLowerCase();
  if (!/^[0-9a-z][0-9a-z-]{3,}$/.test(wanted)) throw new EvidenceError('bad_request', 'Invalid session id');
  const hits = files.filter((f) => basename(f).toLowerCase().startsWith(wanted));
  if (!hits.length) throw new EvidenceError('not_found', 'The session file for this citation no longer exists on this computer.');
  if (hits.length > 1) {
    throw new EvidenceError('ambiguous', `More than one session starts with "${wanted}", so this citation cannot be matched safely.`);
  }
  return hits[0];
}

/** `\`e4d98f1e\` (turns 1-5, 9-9)` -> {e4d98f1e: [[1,5],[9,9]]} (the ranges the capsule was written from). */
export function parseSources(sources) {
  const out = {};
  for (const s of sources || []) {
    const m = String(s).match(/`([^`]+)`\s*\(turns ([\d,\s-]+)\)/);
    if (!m) continue;
    out[m[1].toLowerCase()] = m[2].split(',').map((r) => r.trim().split('-').map(Number)).filter((r) => r.length === 2 && r.every(Number.isInteger));
  }
  return out;
}

function homeShort(p) {
  const home = os.homedir();
  return home && p && (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p || '';
}

function clipText(text) {
  const clean = redact(text);
  return clean.length > MAX_TEXT_CHARS ? [clean.slice(0, MAX_TEXT_CHARS), true] : [clean, false];
}

function publicTurn(t, index, cited) {
  const [user, userCut] = clipText(t.noise ? '' : t.text);
  const assistantText = t.assistant.length ? t.assistant[t.assistant.length - 1] : '';
  const [assistant, assistantCut] = clipText(assistantText);
  const files = [...new Set(t.files)].sort().map((f) => homeShort(f));
  const commands = t.commands.filter((c) => /\bgit\s+(commit|push)\b/.test(c)).slice(0, MAX_COMMANDS).map((c) => clipText(c)[0].slice(0, 300));
  return { turn: index, ts: t.ts || null, cited, noise: Boolean(t.noise), user, assistant, files, commands, truncated: { user: userCut, assistant: assistantCut } };
}

/**
 * Original messages behind a citation. Every text passes through redact(). `ranges` (optional) are the turn ranges
 * the capsule was written from: a cited turn outside them (and their lead-up) is returned as `unverified`.
 * -> {session, turn, turns, confidence: 'verified'|'unverified', warning?}
 */
export function readEvidence(file, turn, { context = DEFAULT_CONTEXT, ranges = null } = {}) {
  const n = typeof turn === 'number' ? turn : (/^\d{1,9}$/.test(String(turn)) ? Number(turn) : NaN); // null / '' must not mean turn 0
  if (!Number.isInteger(n) || n < 0) throw new EvidenceError('bad_request', 'Invalid turn number');
  const ctx = Math.min(MAX_CONTEXT, Math.max(0, Number.isInteger(Number(context)) ? Number(context) : DEFAULT_CONTEXT));
  const turns = loadRichTurns(file);
  if (n >= turns.length) {
    throw new EvidenceError('turn_missing', `Could not locate this turn: the session has ${turns.length} messages and the citation points to #${n}. The file may have changed since the capsule was generated.`);
  }
  const maxEnd = ranges && ranges.length ? Math.max(...ranges.map((r) => r[1])) : -1;
  if (maxEnd >= turns.length) {
    throw new EvidenceError('turn_missing', `Could not locate this turn: the capsule was written from message #${maxEnd}, but the session file now has only ${turns.length} messages.`);
  }
  let confidence = 'verified';
  let warning = null;
  if (ranges && ranges.length && !ranges.some(([a, b]) => a - LEAD_TURNS <= n && n <= b)) {
    confidence = 'unverified';
    warning = 'This citation points outside the messages the capsule was written from, so it may not be the right one.';
  }
  const from = Math.max(0, n - ctx);
  const to = Math.min(turns.length - 1, n + ctx);
  const first = turns[n];
  const shown = [];
  for (let i = from; i <= to; i++) shown.push(publicTurn(turns[i], i, i === n));
  const fileId = basename(file).replace(/\.jsonl$/, '');
  return {
    session: {
      id8: fileId.slice(0, 8), id: fileId, resume: /^[\w-]+$/.test(fileId) ? `claude --resume ${fileId}` : null,
      project: basename(first.cwd) || basename(path.dirname(file)), cwd: homeShort(first.cwd), branch: first.branch || '',
      date: turns[0].ts || null, turns_total: turns.length,
    },
    turn: n, turns: shown, confidence, warning,
  };
}
