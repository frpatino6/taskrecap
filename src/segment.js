// Heuristic segmentation of one session into work-unit segments (no LLM).
//
// Turn index = index in the list of real user prompts. The heuristics are good at proposing candidate
// boundaries (high recall); the LLM step in capsule.js decides which ones are real.
import os from 'node:os';
import { Counter } from './util.js';
import { redact } from './sessions.js';

const STOPWORDS = new Set((
  'para pero como esto esta este esos esas que los las del una uno con por sus muy mas hay ese eso ' +
  'sin sobre entre desde hasta cuando donde porque quiero puedes puede hacer haz hace hecho solo ahora ' +
  'the and for that this with from have not you are was but can will all any then there here ' +
  'please want need make just now also should would could http https www com html json'
).split(' '));

// generic "task switch" openers (English / Spanish); not tailored to any one session
const CUE_RX = /^\W*(now\s+let'?s|now\s+i\s+want|new\s+task|different\s+topic|switching\s+to|unrelated|ahora|quiero\s+que\s+ahora|recuerdas|cambiando|otra\s+cosa|otro\s+tema|nueva\s+tarea)/i;
const NOISE_PREFIXES = ['[Request interrupted', '<bash-', 'This session is being continued'];

function pathNoise() {
  const names = new Set(['users', 'home', 'src', 'claude', 'worktrees', 'tmp', 'private', 'var', 'documents', 'apps']);
  try {
    names.add(os.userInfo().username.toLowerCase());
  } catch {
    /* no user info available */
  }
  return names;
}

const PATH_NOISE = pathNoise();

export const DEFAULT_PARAMS = {
  w_time: 0.15, w_key: 0.9, w_shift: 0.9, w_ctx: 0.25, w_cue: 0.3,
  window: 5, threshold: 0.8, min_gap: 4, key_memory: 6, use_assistant: true,
};

export function parseTs(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t / 1000;
}

export function tokenize(text) {
  let t = String(text || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  t = t.replace(/https?:\/\/\S+|\b[0-9a-f]{7,40}\b|<[^>]{0,80}>/g, ' ');
  return (t.match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOPWORDS.has(w));
}

export function pathTokens(p) {
  const out = [];
  for (const part of p.split(/[/\\._-]/)) {
    for (const w of part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) || []) out.push(w.toLowerCase());
  }
  return out.filter((t) => t.length > 2 && !PATH_NOISE.has(t));
}

export function isNoise(text) {
  return NOISE_PREFIXES.some((p) => text.startsWith(p));
}

export function turnTokens(turn, useAssistant = true) {
  if (turn.noise && !turn.files.length) return [];
  let toks = turn.noise ? [] : tokenize(turn.text.slice(0, 1500));
  for (const fp of new Set(turn.files)) toks = toks.concat(pathTokens(fp));
  if (useAssistant) toks = toks.concat(tokenize(turn.assistant.slice(0, 3).join(' ')));
  return toks;
}

export function tfidfVectors(tokenLists) {
  const n = tokenLists.length;
  const df = new Counter();
  for (const toks of tokenLists) for (const t of new Set(toks)) df.add(t);
  return tokenLists.map((toks) => {
    const tf = new Counter();
    for (const t of toks) tf.add(t);
    const vec = new Map();
    for (const [t, c] of tf) vec.set(t, (1 + Math.log(c)) * Math.log((1 + n) / (1 + df.get(t))));
    return vec;
  });
}

export function addVecs(vs) {
  const out = new Map();
  for (const v of vs) for (const [t, w] of v) out.set(t, (out.get(t) || 0) + w);
  return out;
}

/** Cosine similarity of two sparse vectors, or null when either is empty. */
export function cosine(a, b) {
  if (!a.size || !b.size) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    dot += w * (b.get(t) || 0);
    na += w * w;
  }
  for (const w of b.values()) nb += w * w;
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  return na && nb ? dot / (na * nb) : null;
}

const clip01 = (x) => Math.max(0, Math.min(1, x));

export function timeScores(turns) {
  const out = new Array(turns.length).fill(0);
  for (let i = 1; i < turns.length; i++) {
    const a = parseTs(turns[i - 1].ts);
    const b = parseTs(turns[i].ts);
    if (a !== null && b !== null && b > a) out[i] = clip01(Math.log2(1 + (b - a) / 3600) / Math.log2(1 + 48));
  }
  return out;
}

/** 1 when a prompt cites a work key not seen in the last `memory` keyed prompts; 0.6 when none was active. */
export function keyScores(turns, memory = 6) {
  const out = new Array(turns.length).fill(0);
  const recent = [];
  turns.forEach((tr, i) => {
    const keys = tr.compaction ? new Set() : new Set(tr.keys);
    if (!keys.size) return;
    const seen = new Set(recent.flatMap((s) => [...s]));
    if (![...keys].some((k) => seen.has(k))) out[i] = seen.size ? 1.0 : 0.6;
    recent.push(keys);
    if (recent.length > memory) recent.shift();
  });
  return out;
}

/** Topic shift: 1 - cosine(tf-idf of the `window` turns before i, tf-idf of the `window` turns from i), z-normalised. */
export function shiftScores(turns, window = 5, useAssistant = true) {
  const n = turns.length;
  const vecs = tfidfVectors(turns.map((t) => turnTokens(t, useAssistant)));
  const raw = new Array(n).fill(null);
  for (let i = 2; i < n - 1; i++) {
    const c = cosine(addVecs(vecs.slice(Math.max(0, i - window), i)), addVecs(vecs.slice(i, i + window)));
    raw[i] = c === null ? null : 1.0 - c;
  }
  const vals = raw.filter((r) => r !== null);
  if (vals.length < 3) return new Array(n).fill(0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1.0;
  return raw.map((r) => (r === null ? 0 : clip01((r - mean) / (2 * std))));
}

/** cwd change = 1, branch change between two non-generic branches = 0.5. */
export function contextScores(turns) {
  const out = new Array(turns.length).fill(0);
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1];
    const b = turns[i];
    if (a.cwd && b.cwd && a.cwd !== b.cwd) out[i] = 1.0;
    else if (a.branch && b.branch && a.branch !== b.branch && a.branch !== 'HEAD' && b.branch !== 'HEAD') out[i] = 0.5;
  }
  return out;
}

export function cueScores(turns) {
  return turns.map((t) => (!t.noise && CUE_RX.test(t.text.slice(0, 80)) ? 1.0 : 0.0));
}

export function boundaryScores(turns, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const comps = {
    time: timeScores(turns),
    key: keyScores(turns, p.key_memory),
    shift: shiftScores(turns, p.window, p.use_assistant),
    ctx: contextScores(turns),
    cue: cueScores(turns),
  };
  const total = turns.map((_, i) => p.w_time * comps.time[i] + p.w_key * comps.key[i] + p.w_shift * comps.shift[i]
    + p.w_ctx * comps.ctx[i] + p.w_cue * comps.cue[i]);
  return [total, comps];
}

/** Scores >= threshold, at least `minGap` turns apart (highest score wins). */
export function pickBoundaries(scores, threshold, minGap) {
  const cands = [];
  for (let i = 1; i < scores.length; i++) if (scores[i] >= threshold) cands.push(i);
  cands.sort((a, b) => scores[b] - scores[a] || a - b);
  const picked = [];
  for (const i of cands) if (picked.every((j) => Math.abs(i - j) >= minGap)) picked.push(i);
  return picked.sort((a, b) => a - b);
}

export function labelSegments(turns, boundaries, topTerms = 4) {
  const edges = [0, ...boundaries, turns.length];
  const vecs = tfidfVectors(turns.map((t) => turnTokens(t)));
  const segs = [];
  for (let e = 0; e < edges.length - 1; e++) {
    const a = edges[e];
    const b = edges[e + 1];
    if (b <= a) continue;
    const keys = new Counter();
    for (const t of turns.slice(a, b)) if (!t.compaction) for (const k of t.keys) keys.add(k);
    const vec = addVecs(vecs.slice(a, b));
    const terms = [...vec.entries()].sort((x, y) => y[1] - x[1]).slice(0, topTerms).map(([t]) => t);
    segs.push({
      start: a, end: b - 1, n: b - a,
      key: keys.size ? keys.mostCommon(1)[0][0] : null,
      keys: Object.fromEntries(keys.mostCommon(3)),
      terms,
      first_ts: turns[a].ts,
      snippet: redact(turns[a].text).replace(/\n/g, ' ').slice(0, 90),
    });
  }
  return segs;
}

/** -> [boundaries, segments, scores, components] */
export function segment(turns, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const [scores, comps] = boundaryScores(turns, p);
  const bounds = pickBoundaries(scores, p.threshold, p.min_gap);
  return [bounds, labelSegments(turns, bounds), scores, comps];
}
