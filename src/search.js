// Free, local search inside the text of generated capsules (no AI, no tokens).
//
// Normal-mode search is literal: every word you type must appear (accent- and case-insensitive, as part of a word)
// in a task. Tasks are ranked with BM25 and each hit says WHERE it matched, with a highlighted snippet.

const K1 = 1.2;
const B = 0.75;
const HEAD_WEIGHT = 3; // task key, repos, first prompt
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 110;

/** Capsule sections that are searched, with their weight in the ranking. `id` is also the UI string key. */
export const SECTIONS = [
  ['objective', 3], ['decisions', 2], ['files', 1.5], ['commits', 1.5], ['dead_ends', 1.5], ['pending', 1.5],
  ['left_out', 1], ['timeline', 1], ['briefing', 0.5],
];

/**
 * Lower-case without accents ("Decisión" -> "decision"), keeping the SAME length as the input, so a position in the
 * folded text is a position in the original (that is what lets us cut and highlight the original snippet).
 */
export function fold(text) {
  let out = '';
  for (const ch of String(text || '')) {
    let n = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    if (n.length !== ch.length) n = ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
    out += n;
  }
  return out;
}

/** Folded search words of a query. */
export function queryWords(query) {
  return fold(query).split(/\s+/).filter(Boolean);
}

function countOf(haystack, needle) {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

const lines = (items, pick) => (Array.isArray(items) ? items.map(pick).filter(Boolean).join('\n') : '');
const citeless = (i) => (i && (i.text || i.decision || i.result || '')) || '';

/** Plain text of each searchable section of one cached capsule -> [{id, weight, text, folded}]. */
export function capsuleSections(cap) {
  const c = (cap && cap.capsule) || {};
  const commits = (cap && cap.commits) || {};
  const text = {
    objective: c.objective || '',
    decisions: lines(c.decisions, (d) => `${d.decision || ''}${d.why ? ` — ${d.why}` : ''}`),
    files: lines(cap && cap.files, (f) => `${f.short} (${f.status})`),
    commits: lines([...(commits.confirmed || []), ...(commits.possible || [])], (m) => `${m.hash || ''} ${m.branch || ''} ${m.msg || ''}`),
    dead_ends: lines(c.dead_ends, citeless),
    pending: lines(c.pending, citeless),
    left_out: lines(c.left_out, citeless),
    timeline: lines(c.timeline, (t) => `${t.date || ''} ${t.repo || ''} ${t.result || ''}`),
    briefing: c.briefing || '',
  };
  return SECTIONS.map(([id, weight]) => ({ id, weight, text: text[id], folded: fold(text[id]) })).filter((s) => s.text.trim());
}

/** Merged, sorted [start, end) ranges of every query word inside `folded` (used to highlight). */
export function highlightRanges(folded, words) {
  const raw = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) raw.push([at, at + w.length]);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [a, b] of raw) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

/** A short piece of `section.text` around the first match, whitespace flattened (same length), plus highlight ranges. */
export function snippetOf(section, words) {
  const first = words.map((w) => section.folded.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (first == null) return { excerpt: '', highlights: [] };
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(section.text.length, first + SNIPPET_AFTER);
  const excerpt = section.text.slice(start, end).replace(/\s/g, ' ');
  const highlights = highlightRanges(section.folded.slice(start, end), words);
  return { excerpt, highlights, truncated: [start > 0, end < section.text.length] };
}

export class CapsuleSearch {
  /** @param {import('./tasks.js').CapsuleStore} store */
  constructor(store) {
    this.store = store;
    this.sig = null;
    this.docs = new Map(); // task key -> sections of its capsule
  }

  /** Sections of every cached capsule, rebuilt lazily when a capsule is written, replaced or deleted. */
  sections() {
    const sig = this.store.signature();
    if (sig !== this.sig) {
      this.docs = new Map(this.store.all().map((cap) => [cap.key, capsuleSections(cap)]));
      this.sig = sig;
    }
    return this.docs;
  }

  /** How much of the task list the free search can look inside. */
  coverage(tasks) {
    const docs = this.sections();
    const withCapsule = tasks.filter((t) => docs.has(t.key)).length;
    return { capsules: withCapsule, other_tasks: tasks.length - withCapsule };
  }

  /**
   * @param {string} query
   * @param {{key: string, projects: string[], snippet: string}[]} tasks as listed on the home page
   * @returns {null | {key, where: 'task'|'capsule', section, sections, excerpt, highlights, score}[]} best first; null for an empty query
   */
  search(query, tasks) {
    const words = queryWords(query);
    if (!words.length) return null;
    const docs = this.sections();
    const items = tasks.map((t) => {
      const head = fold(`${t.key} ${t.label && t.label !== t.key ? t.label : ''} ${(t.projects || []).join(' ')} ${t.snippet || ''}`); // a name the user chose is searchable too
      const secs = docs.get(t.key) || [];
      const len = Math.max(1, head.length + secs.reduce((n, s) => n + s.folded.length, 0));
      return { t, head, secs, len };
    });
    const avg = items.reduce((n, d) => n + d.len, 0) / Math.max(1, items.length);
    const has = (d, w) => d.head.includes(w) || d.secs.some((s) => s.folded.includes(w));
    const df = new Map(words.map((w) => [w, items.filter((d) => has(d, w)).length]));

    const hits = [];
    for (const d of items) {
      if (!words.every((w) => has(d, w))) continue; // literal: every word must be there
      let score = 0;
      for (const w of words) {
        const tf = HEAD_WEIGHT * countOf(d.head, w) + d.secs.reduce((n, s) => n + s.weight * countOf(s.folded, w), 0);
        const idf = Math.log(1 + (items.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / avg));
      }
      const base = { key: d.t.key, score: Math.round(score * 1000) / 1000 };
      if (words.every((w) => d.head.includes(w))) { // the card already shows the key, repos and first prompt
        hits.push({ ...base, where: 'task', section: 'task', sections: ['task'], excerpt: '', highlights: [] });
        continue;
      }
      const ranked = d.secs
        .map((s) => ({ s, found: words.filter((w) => s.folded.includes(w)).length }))
        .filter((r) => r.found)
        .sort((a, b) => b.found - a.found || b.s.weight - a.s.weight);
      const best = ranked[0].s;
      hits.push({ ...base, where: 'capsule', section: best.id, sections: ranked.slice(0, 3).map((r) => r.s.id), ...snippetOf(best, words) });
    }
    return hits.sort((a, b) => b.score - a.score);
  }
}
