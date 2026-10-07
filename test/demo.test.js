import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { App, DEMO_DIR } from '../src/app.js';
import { seedDemoCache } from '../src/cli.js';
import { renderMarkdown } from '../src/capsule.js';
import { DEFAULT_KEY_REGEX } from '../src/config.js';
import { parseSources, readEvidence, resolveSession } from '../src/evidence.js';
import { SessionIndex } from '../src/tasks.js';
import { tmpDir } from './helpers.js';

const CAPSULES = path.join(DEMO_DIR, 'capsules');
const SESSIONS = path.join(DEMO_DIR, 'sessions');
const index = new SessionIndex(SESSIONS, DEFAULT_KEY_REGEX);
const jsonNames = fs.readdirSync(CAPSULES).filter((n) => n.endsWith('.json')).sort();
const load = (n) => JSON.parse(fs.readFileSync(path.join(CAPSULES, n), 'utf8'));

/** Every citation of a capsule, with the item text it supports. */
function citations(cap) {
  const out = [];
  const add = (field, text, cites) => (cites || []).forEach((c) => out.push({ field, text, c }));
  for (const t of cap.timeline || []) add('timeline', t.result, t.cites);
  for (const d of cap.decisions || []) add('decisions', `${d.decision} ${d.why}`, d.cites);
  for (const f of ['dead_ends', 'left_out', 'pending']) for (const i of cap[f] || []) add(f, i.text, i.cites);
  return out;
}

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []);

test('the demo has at least 6 sample capsules plus tasks that deliberately have none', () => {
  assert.ok(jsonNames.length >= 6, `expected >= 6 sample capsules, found ${jsonNames.length}`);
  const cacheDir = tmpDir();
  seedDemoCache(CAPSULES, cacheDir);
  const app = new App({ projectsDir: SESSIONS, cacheDir, demo: true });
  const tasks = new Map(app.listTasks().map((t) => [t.key, t]));
  const ready = [...tasks.values()].filter((t) => t.has_capsule);
  assert.ok(ready.length >= 6, 'home should show mostly "Capsule ready" cards');
  for (const t of ready) assert.ok(t.objective.length > 40, `${t.key} needs a readable objective`);
  assert.equal(tasks.get('SHOP-106').has_capsule, false, 'SHOP-106 stays without a capsule (AI generate demo)');
  assert.equal(tasks.get('unassigned').has_capsule, false);
});

test('every sample capsule belongs to a task of the demo sessions and its .md matches its .json', () => {
  const taskKeys = new Set(index.tasks().map((t) => t.key));
  for (const name of jsonNames) {
    const cap = load(name);
    assert.ok(taskKeys.has(cap.key), `${name}: no demo task with key ${cap.key}`);
    assert.equal(cap.key.replace(/[^\p{L}\p{N}_.-]/gu, '_'), name.replace(/\.json$/, ''));
    const md = fs.readFileSync(path.join(CAPSULES, name.replace(/\.json$/, '.md')), 'utf8');
    assert.equal(md, cap.markdown, `${name}: the .md differs from the markdown stored in the .json`);
    assert.ok(md.includes(cap.capsule.objective), `${name}: objective missing from the .md`);
    assert.equal(md, renderMarkdown(cap.key, cap.capsule, cap.files, cap.commits, cap.sources), `${name}: the .md no longer matches what its own structured data renders`);
    assert.ok(cap.capsule.decisions.length >= 1 && cap.capsule.timeline.length >= 3, `${name}: too thin to demo`);
    assert.ok(Array.isArray(cap.files) && cap.files.length, `${name}: files missing`);
  }
});

test('every citation of every sample capsule resolves to the right message through the evidence lookup', () => {
  const files = index.listFiles();
  let checked = 0;
  for (const name of jsonNames) {
    const cap = load(name);
    const ranges = parseSources(cap.sources);
    for (const { field, text, c } of citations(cap.capsule)) {
      const where = `${name} ${field} ${c.session}:${c.turn}`;
      const ev = readEvidence(resolveSession(files, c.session), c.turn, { context: 0, ranges: ranges[c.session] });
      assert.equal(ev.confidence, 'verified', `${where} points outside the turns the capsule was written from`);
      const turn = ev.turns.find((t) => t.cited);
      assert.ok(turn && !turn.noise && turn.user, `${where} resolves to an empty or noise turn`);
      // the cited message must be about the same thing: share a distinctive word with the item it supports
      const turnWords = words([turn.user, turn.assistant, ...turn.files, ...turn.commands].join(' '));
      assert.ok([...words(text)].some((w) => turnWords.has(w)), `${where} shares no distinctive word with "${text.slice(0, 60)}"`);
      checked += 1;
    }
  }
  assert.ok(checked >= 60, `expected many citations to check, got ${checked}`);
});

// Hand-picked anchors: this exact citation must exist in the capsule AND land on a message that really says this.
const ANCHORS = [
  ['SHOP-103', 'b2c3d4e5', 7, 'fake timer'], ['SHOP-103', 'b2c3d4e5', 8, '20 of 20'],
  ['SHOP-104', 'f6a7b8c9', 0, 'charged twice'], ['SHOP-104', 'f6a7b8c9', 2, 'Idempotency-Key'], ['SHOP-104', 'f6a7b8c9', 3, 'sessionStorage'],
  ['SHOP-104', 'a7b8c9d0', 1, 'backoff'], ['SHOP-104', 'a7b8c9d0', 2, 'git push'],
  ['SHOP-105', 'b8c9d0e1', 0, '3.4 s'], ['SHOP-105', 'b8c9d0e1', 3, '2.1 s'], ['SHOP-105', 'b8c9d0e1', 4, 'do not push'],
  ['feature/search-autocomplete', 'c3d4e5f6', 1, '/api/suggest'], ['feature/search-autocomplete', 'c3d4e5f6', 3, 'recent searches'],
];

test('hand-picked citations land on the messages they are supposed to point at', () => {
  const files = index.listFiles();
  for (const [key, session, turn, needle] of ANCHORS) {
    const cap = load(`${key.replace(/[^\p{L}\p{N}_.-]/gu, '_')}.json`);
    assert.ok(citations(cap.capsule).some(({ c }) => c.session === session && c.turn === turn), `${key} never cites ${session}:${turn}`);
    const t = readEvidence(resolveSession(files, session), turn, { context: 0 }).turns.find((x) => x.cited);
    const text = [t.user, t.assistant, ...t.commands].join(' ');
    assert.ok(text.includes(needle), `${session}:${turn} should mention "${needle}" but says: ${text.slice(0, 120)}`);
  }
});

test('every dated timeline row matches the day of at least one message it cites', () => {
  const files = index.listFiles();
  for (const name of jsonNames) {
    for (const row of load(name).capsule.timeline) {
      const days = row.cites.map((c) => readEvidence(resolveSession(files, c.session), c.turn, { context: 0 }).turns.find((t) => t.cited).ts.slice(5, 10));
      assert.ok(days.includes(row.date), `${name}: row dated ${row.date} cites messages from ${days.join(', ')}`);
    }
  }
});

test('an upgraded demo cache gets the new samples without losing a capsule the user regenerated', () => {
  const cache = tmpDir();
  fs.writeFileSync(path.join(cache, 'SHOP-101.json'), '{"key":"SHOP-101","custom":true}');
  seedDemoCache(CAPSULES, cache);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'SHOP-101.json'), 'utf8')).custom, true, 'existing file must not be overwritten');
  assert.deepEqual(fs.readdirSync(cache).sort(), fs.readdirSync(CAPSULES).sort(), 'missing samples are copied');
  seedDemoCache(CAPSULES, cache); // idempotent
  assert.equal(fs.readdirSync(cache).length, fs.readdirSync(CAPSULES).length);
  seedDemoCache(path.join(cache, 'nope'), tmpDir()); // a missing sample dir is not an error
});

test('the demo sessions are fictional: no real paths, emails or secrets', () => {
  const blob = fs.readdirSync(path.join(SESSIONS, 'acme-shop')).map((n) => fs.readFileSync(path.join(SESSIONS, 'acme-shop', n), 'utf8')).join('\n')
    + jsonNames.map((n) => fs.readFileSync(path.join(CAPSULES, n), 'utf8')).join('\n');
  assert.ok(!/\/Users\/|\/home\/(?!demo\/)|@[a-z0-9-]+\.(com|org|net|io)\b|sk-[A-Za-z0-9]{16,}|ghp_|AKIA/i.test(blob));
});
