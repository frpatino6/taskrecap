// Free, local full-text index over the TEXT OF THE MESSAGES of every Claude Code session (no AI, no tokens).
//
// What is indexed: the user's real prompts and the assistant's text blocks (never tool calls or tool results, never
// subagent/sidechain records, never the automatic "noise" prompts of segment.js). What is stored: only references. A shard
// (`<cache>/.index/search/<sessionId>.json`) holds a vocabulary (folded word -> [doc, tf, doc, tf...]) and a doc table
// [[byteOffset, turn, length, role, tsSeconds]]; no message text is ever written. Words are taken from the REDACTED text, so
// a secret never becomes a searchable token. Snippets are cut at query time by re-reading the message from the .jsonl.
//
// Incremental (jsonl is append-only): `update()` compares size/mtime with the manifest. Unchanged -> nothing is read. Grown ->
// only the bytes after the saved offset are read and added. Shrunk, or same size with a different mtime -> that session is
// rebuilt (it was rewritten, offsets can no longer be trusted). File gone -> its shard is dropped. Anything unreadable,
// damaged or written by another version is ignored and rebuilt; nothing here throws at the caller.
import fs from 'node:fs';
import path from 'node:path';
import { redact, userText } from './sessions.js';
import { isNoise } from './segment.js';
import { fold, snippetOf } from './search.js';
import { parseLine } from './util.js';

export const INDEX_VERSION = 1;
export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 100;
const BLOCK_BYTES = 16 * 1024 * 1024; // read a session in blocks of this size
const MAX_TEXT = 200000; // chars of one message that are tokenized
const MAX_WORD = 40; // longer "words" (base64, hashes, minified code) are not indexed
const K1 = 1.2;
const B = 0.75;
const ROLE_USER = 0;
const ROLE_ASSISTANT = 1;

const WORD_RX = /[\p{L}\p{N}]+/gu;

/** Folded, de-duplicated-free word list of a text (query words and indexed words use the same rule). */
export function words(text) {
  return fold(text).match(WORD_RX) || [];
}

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Plain text of one jsonl record that is a searchable message -> {role, text, noise} or null. */
function messageOf(d) {
  if (!d || d.isSidechain) return null;
  if (d.type === 'user' && !d.isMeta) {
    const text = userText(d.message);
    return text ? { role: ROLE_USER, text, noise: isNoise(text) } : null;
  }
  if (d.type === 'assistant') {
    const content = d.message && d.message.content;
    const text = (Array.isArray(content) ? content : [])
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && (b.text || '').trim())
      .map((b) => b.text.trim())
      .join('\n');
    return { role: ROLE_ASSISTANT, text, noise: false };
  }
  return null;
}

const tsSeconds = (ts) => {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
};

function emptyShard(id) {
  return { v: INDEX_VERSION, id, turns: 0, docs: [], words: {} };
}

/** Add the messages of the complete lines of `buf` (which starts at file offset `base`) to `shard`; returns how many bytes were consumed. */
function addBlock(shard, buf, base) {
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const lineStart = pos;
    pos = nl + 1;
    if (nl === lineStart) continue;
    const line = buf.toString('utf8', lineStart, nl);
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
    const d = parseLine(line);
    const msg = messageOf(d);
    if (!msg) continue;
    if (msg.role === ROLE_USER) shard.turns += 1;
    else if (!shard.turns) continue; // assistant text before the first prompt belongs to no turn
    if (msg.noise || !msg.text) continue;
    const toks = words(redact(msg.text.slice(0, MAX_TEXT))).filter((w) => w.length <= MAX_WORD);
    if (!toks.length) continue;
    const doc = shard.docs.length;
    shard.docs.push([base + lineStart, shard.turns - 1, toks.length, msg.role, tsSeconds(d.timestamp)]);
    const tf = new Map();
    for (const w of toks) tf.set(w, (tf.get(w) || 0) + 1);
    for (const [w, n] of tf) {
      const list = Object.prototype.hasOwnProperty.call(shard.words, w) ? shard.words[w] : (shard.words[w] = []);
      list.push(doc, n);
    }
  }
  return pos;
}

/** Index the bytes of `file` from `from` on into `shard` -> new offset (always right after a complete line). */
async function indexFrom(shard, file, from, size) {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = from;
    let want = BLOCK_BYTES;
    while (offset < size) {
      const len = Math.min(want, size - offset);
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, offset);
      if (got <= 0) break;
      const used = addBlock(shard, buf.subarray(0, got), offset);
      if (!used) { // no complete line in the block: a huge line (read more) or a half-written one at the end (stop)
        if (offset + got >= size) break;
        want *= 2;
        continue;
      }
      want = BLOCK_BYTES;
      offset += used;
      await yieldLoop();
    }
    return offset;
  } finally {
    fs.closeSync(fd);
  }
}

/** Text of the message that starts at byte `offset` of `file` (a whole jsonl line), or '' when it is gone. */
function readMessage(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    const buf = Buffer.alloc(65536);
    for (let at = offset; ; ) {
      const got = fs.readSync(fd, buf, 0, buf.length, at);
      if (got <= 0) break;
      const nl = buf.indexOf(10);
      if (nl >= 0 && nl < got) { chunks.push(Buffer.from(buf.subarray(0, nl))); break; }
      chunks.push(Buffer.from(buf.subarray(0, got)));
      at += got;
    }
    const msg = messageOf(parseLine(Buffer.concat(chunks).toString('utf8')));
    return msg ? redact(msg.text.slice(0, MAX_TEXT)) : '';
  } catch {
    return '';
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function listFiles(projectsDir) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(projectsDir, d.name);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of names) out.push(path.join(dir, n));
  }
  return out.sort();
}

const sessionId = (file) => path.basename(file).replace(/\.jsonl$/, '');
const safeName = (id) => id.replace(/[^A-Za-z0-9._-]/g, '_');

export class TextIndex {
  /**
   * @param {string} projectsDir `~/.claude/projects`
   * @param {string} cacheDir the app cache; the index lives in `<cacheDir>/.index/search/`
   */
  constructor(projectsDir, cacheDir) {
    this.projectsDir = projectsDir;
    this.dir = path.join(cacheDir, '.index', 'search');
    this.manifestFile = path.join(this.dir, 'manifest.json');
    this.manifest = null; // {v, sessions: {id: {file, size, mtimeMs, bytes, turns, v}}}
    this.shards = new Map(); // id -> loaded shard (lazy)
  }

  shardFile(id) {
    return path.join(this.dir, `${safeName(id)}.json`);
  }

  loadManifest() {
    if (this.manifest) return this.manifest;
    this.manifest = { v: INDEX_VERSION, sessions: {} };
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
      if (m && m.v === INDEX_VERSION && m.sessions && typeof m.sessions === 'object') this.manifest = m;
    } catch {
      /* none yet, or damaged: start empty (every session is rebuilt) */
    }
    return this.manifest;
  }

  writeAtomic(file, text) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  saveManifest() {
    this.writeAtomic(this.manifestFile, JSON.stringify(this.manifest));
  }

  /** The shard of a session, or null when missing, damaged or of another version (then the session is marked for rebuild). */
  loadShard(id) {
    if (this.shards.has(id)) return this.shards.get(id);
    let shard = null;
    try {
      const s = JSON.parse(fs.readFileSync(this.shardFile(id), 'utf8'));
      if (s && s.v === INDEX_VERSION && Array.isArray(s.docs) && s.words && typeof s.words === 'object') shard = s;
    } catch {
      /* missing or damaged */
    }
    if (shard) this.shards.set(id, shard);
    else if (this.loadManifest().sessions[id]) {
      delete this.manifest.sessions[id]; // next update() rebuilds it
      try { this.saveManifest(); } catch { /* ignore */ }
    }
    return shard;
  }

  dropShard(id) {
    this.shards.delete(id);
    try { fs.unlinkSync(this.shardFile(id)); } catch { /* already gone */ }
  }

  /**
   * Bring the index up to date with the session files. Cheap when nothing changed (one stat per file, no reads).
   * Yields to the event loop between blocks and files. `onProgress({done, total})` is called after each file.
   * -> {sessions, added, rebuilt, appended, dropped, unchanged, errors}
   */
  async update({ onProgress = null, files = null } = {}) {
    const man = this.loadManifest();
    const list = (files || listFiles(this.projectsDir)).map((file) => ({ file, id: sessionId(file) }));
    const stats = { sessions: list.length, added: 0, rebuilt: 0, appended: 0, dropped: 0, unchanged: 0, errors: 0 };
    let dirty = false;
    const present = new Set(list.map((s) => s.id));
    for (const id of Object.keys(man.sessions)) { // a deleted session file takes its shard with it
      if (present.has(id)) continue;
      delete man.sessions[id];
      this.dropShard(id);
      stats.dropped += 1;
      dirty = true;
    }
    try { // shards no longer in the manifest (an old crash, another version): sweep them
      for (const n of fs.readdirSync(this.dir)) {
        if (!n.endsWith('.json') || n === 'manifest.json') continue;
        if (![...present].some((id) => `${safeName(id)}.json` === n)) fs.unlinkSync(path.join(this.dir, n));
      }
    } catch { /* no index dir yet */ }

    let done = 0;
    for (const { file, id } of list) {
      try {
        const st = fs.statSync(file);
        const ent = man.sessions[id];
        const same = ent && ent.file === file && ent.size === st.size && ent.mtimeMs === st.mtimeMs;
        if (same && fs.existsSync(this.shardFile(id))) {
          stats.unchanged += 1;
        } else {
          const grew = ent && ent.file === file && st.size > ent.size && ent.bytes <= ent.size;
          let shard = grew ? this.loadShard(id) : null;
          const resume = Boolean(shard);
          if (!shard) {
            shard = emptyShard(id);
            if (ent) stats.rebuilt += 1; else stats.added += 1;
          } else stats.appended += 1;
          const bytes = await indexFrom(shard, file, resume ? ent.bytes : 0, st.size);
          this.writeAtomic(this.shardFile(id), JSON.stringify(shard));
          this.shards.set(id, shard);
          man.sessions[id] = { file, size: st.size, mtimeMs: st.mtimeMs, bytes, turns: shard.turns, v: INDEX_VERSION };
          dirty = true;
        }
      } catch {
        stats.errors += 1; // unreadable now: leave it out; the next update() tries again
        delete man.sessions[id];
        this.shards.delete(id);
        dirty = true;
      }
      done += 1;
      if (onProgress) onProgress({ done, total: list.length });
      await yieldLoop();
    }
    if (dirty) this.saveManifest();
    return stats;
  }

  /**
   * Literal search: every query word must be inside the SAME message (case- and accent-insensitive; a query word matches any
   * indexed word that contains it). Ranked with BM25, ties newest first.
   * -> [{session, file, turn, role: 'user'|'assistant', ts, score, snippet: {excerpt, highlights, truncated}}] (empty for an empty query)
   * Words are split like the index does, so "SHOP-101" means "shop" and "101" in the same message.
   */
  search(query, { limit = LIMIT_DEFAULT } = {}) {
    const terms = [...new Set(words(query))];
    if (!terms.length) return [];
    const cap = Math.min(LIMIT_MAX, Math.max(1, Number.isInteger(limit) ? limit : LIMIT_DEFAULT));
    const man = this.loadManifest();
    const cands = []; // {id, doc, tfs: [tf per term]}
    const df = new Array(terms.length).fill(0);
    let nDocs = 0;
    let totalLen = 0;
    for (const id of Object.keys(man.sessions)) {
      const shard = this.loadShard(id);
      if (!shard) continue;
      nDocs += shard.docs.length;
      for (const d of shard.docs) totalLen += d[2];
      const per = terms.map(() => new Map()); // doc -> tf, per term
      const vocab = shard.words;
      for (const w of Object.keys(vocab)) {
        terms.forEach((t, i) => {
          if (!w.includes(t)) return;
          const list = vocab[w];
          for (let k = 0; k < list.length; k += 2) per[i].set(list[k], (per[i].get(list[k]) || 0) + list[k + 1]);
        });
      }
      per.forEach((m, i) => { df[i] += m.size; });
      if (per.some((m) => !m.size)) continue;
      const [first, ...rest] = per;
      for (const [doc, tf0] of first) {
        if (rest.every((m) => m.has(doc))) cands.push({ id, doc, tfs: [tf0, ...rest.map((m) => m.get(doc))] });
      }
    }
    if (!cands.length) return [];
    const avg = totalLen / Math.max(1, nDocs);
    const scored = cands.map((c) => {
      const d = this.shards.get(c.id).docs[c.doc];
      let score = 0;
      c.tfs.forEach((tf, i) => {
        const idf = Math.log(1 + (nDocs - df[i] + 0.5) / (df[i] + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d[2]) / avg));
      });
      return { c, d, score };
    });
    scored.sort((a, b) => b.score - a.score || b.d[4] - a.d[4]);
    return scored.slice(0, cap).map(({ c, d, score }) => {
      const file = man.sessions[c.id].file;
      const text = readMessage(file, d[0]);
      const snippet = snippetOf({ text, folded: fold(text) }, terms);
      return {
        session: c.id, file, turn: d[1], role: d[3] === ROLE_USER ? 'user' : 'assistant',
        ts: d[4] ? new Date(d[4] * 1000).toISOString() : null, score: Math.round(score * 1000) / 1000, snippet,
      };
    });
  }

  /** Sessions and messages currently indexed (from the manifest and the loaded/loadable shards). */
  stats() {
    const ids = Object.keys(this.loadManifest().sessions);
    let messages = 0;
    for (const id of ids) {
      const s = this.loadShard(id);
      if (s) messages += s.docs.length;
    }
    return { sessions: ids.length, messages };
  }
}
