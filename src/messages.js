// Free, local list of the user's messages of one session, for the "Sessions" section of the task view.
// Turn numbers come from loadRichTurns(), the same loader the capsule generator and the evidence panel use, so a message
// listed here opens exactly the same evidence as a capsule citation with that number.
import fs from 'node:fs';
import { loadRichTurns } from './capsule.js';
import { DEFAULT_KEY_REGEX } from './config.js';
import { redact } from './sessions.js';

export const PAGE_DEFAULT = 40;
export const PAGE_MAX = 100;
export const TEXT_CHARS = 280; // per message, after redaction
export const SCOPES = ['all', 'mine', 'new'];
const CACHE_MAX = 16;

const cache = new Map(); // `${file}:${mtimeMs}:${size}:${regex}` -> projection of the session (oldest entry is evicted first)

const oneLine = (text) => redact(text).replace(/\s+/g, ' ').trim();

/**
 * Light projection of a session: [{turn, ts, ms, text, cut, noise, keys}] in turn order. `text` is redacted, on one line
 * and clipped; automatic messages ([Request interrupted...) keep their number but carry no text. Cached per file version.
 */
export function messageList(file, keyRegex = DEFAULT_KEY_REGEX) {
  const st = fs.statSync(file);
  const id = `${file}:${st.mtimeMs}:${st.size}:${keyRegex}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const list = loadRichTurns(file, keyRegex).map((t, turn) => {
    const clean = t.noise ? '' : oneLine(t.text);
    const ms = Date.parse(t.ts);
    return {
      turn, ts: t.ts || null, ms: Number.isNaN(ms) ? null : ms, noise: Boolean(t.noise),
      text: clean.length > TEXT_CHARS ? clean.slice(0, TEXT_CHARS) : clean, cut: clean.length > TEXT_CHARS, keys: [...new Set(t.keys)],
    };
  });
  cache.set(id, list);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return list;
}

const toInt = (v, fallback, min, max) => {
  const n = typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : NaN;
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * One page of the user's messages of a session.
 * opts: {range: [first, last] turns to list (default all), key, markable (the key can be found in text), main (the key is the session's own task), since (epoch ms of the
 * capsule, or NaN), scope: all | mine (cite the key) | new (written after the capsule), offset, limit, keyRegex}
 * `mine` is only meaningful when `markable`; `new` counts the messages after `since` (for a session the task merely shares,
 * only those citing the key, the same rule the outdated badge uses).
 * -> {total, hidden_noise, offset, limit, scope, messages: [{turn, ts, text, cut, mine, new}]}
 */
export function pageMessages(file, { key = '', markable = false, main = true, since = NaN, scope = 'all', offset = 0, limit = PAGE_DEFAULT, keyRegex = DEFAULT_KEY_REGEX, range = null } = {}) {
  const list = messageList(file, keyRegex);
  const sc = SCOPES.includes(scope) ? scope : 'all';
  const rows = [];
  let hiddenNoise = 0;
  for (const m of list) {
    if (range && (m.turn < range[0] || m.turn > range[1])) continue; // a unit that is only part of a session lists only its messages
    if (m.noise) { hiddenNoise += 1; continue; }
    const mine = markable && m.keys.includes(key);
    const fresh = Number.isFinite(since) && m.ms != null && m.ms > since && (main || mine);
    if (sc === 'mine' && !mine) continue;
    if (sc === 'new' && !fresh) continue;
    rows.push({ turn: m.turn, ts: m.ts, text: m.text, cut: m.cut, mine, new: fresh });
  }
  const lim = toInt(limit, PAGE_DEFAULT, 1, PAGE_MAX);
  const off = toInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { total: rows.length, hidden_noise: hiddenNoise, offset: off, limit: lim, scope: sc, messages: rows.slice(off, off + lim) };
}

/** Test helper: forget the cached projections. */
export function clearMessageCache() {
  cache.clear();
}
