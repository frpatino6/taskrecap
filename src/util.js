// Small helpers shared by the modules.
import fs from 'node:fs';

/** Map of counts. `mostCommon` keeps insertion order for ties (like Python's Counter). */
export class Counter extends Map {
  add(key, n = 1) {
    this.set(key, (this.get(key) || 0) + n);
    return this;
  }

  mostCommon(limit) {
    const sorted = [...this.entries()].sort((a, b) => b[1] - a[1]);
    return limit == null ? sorted : sorted.slice(0, limit);
  }
}

/** Parse one jsonl line into a plain object, or null when it is blank / malformed / not an object. */
export function parseLine(line) {
  if (!line) return null;
  try {
    const d = JSON.parse(line);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
}

/** Every JSON object of a jsonl file (malformed lines are skipped). */
export function* jsonRecords(path) {
  const text = fs.readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const d = parseLine(line);
    if (d) yield d;
  }
}

export function expandUser(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || process.env.USERPROFILE || p;
  if (p.startsWith('~/') || p.startsWith('~\\')) return (process.env.HOME || process.env.USERPROFILE || '') + p.slice(1);
  return p;
}

export function basename(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}
