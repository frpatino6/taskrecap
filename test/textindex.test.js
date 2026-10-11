import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TextIndex, words } from '../src/textindex.js';
import { makeSession, tmpDir } from './helpers.js';

const T = (n) => `2026-01-0${n}T10:00:00Z`;

function setup() {
  const projects = tmpDir();
  const cache = tmpDir();
  return { projects, cache, idx: new TextIndex(projects, cache) };
}

const shardDir = (cache) => path.join(cache, '.index', 'search');

test('words: folded, accent-insensitive tokens', () => {
  assert.deepEqual(words('Decisión: SHOP-101, ñandú!'), ['decision', 'shop', '101', 'nandu']);
});

test('build and query: AND inside the same message, accents, substring', async () => {
  const { projects, idx } = setup();
  makeSession(projects, 's1', [
    [T(1), 'Fix the Autenticación bug', 'Looking at the login handler', [['Bash', { command: 'zebra' }, 'zebra result']]],
    [T(2), 'apples are red', 'bananas are yellow'],
  ]);
  const stats = await idx.update();
  assert.equal(stats.added, 1);
  assert.deepEqual(idx.stats(), { sessions: 1, messages: 4 });
  const hits = idx.search('autenticacion');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].turn, 0);
  assert.equal(hits[0].role, 'user');
  assert.match(hits[0].snippet.excerpt, /Autenticación/);
  const [a, b] = hits[0].snippet.highlights[0];
  assert.equal(hits[0].snippet.excerpt.slice(a, b), 'Autenticación');
  assert.equal(idx.search('authent').length, 0);
  assert.equal(idx.search('tentic').length, 1); // substring of a word
  assert.equal(idx.search('apples bananas').length, 0); // different messages
  assert.equal(idx.search('apples red').length, 1);
  assert.equal(idx.search('bananas')[0].role, 'assistant');
  assert.equal(idx.search('bananas')[0].turn, 1);
  assert.equal(idx.search('zebra').length, 0); // tool calls and results are not indexed
  assert.deepEqual(idx.search('   '), []);
});

test('ranking: more and rarer matches first, ties newest first', async () => {
  const { projects, idx } = setup();
  makeSession(projects, 'a', [
    [T(1), 'cache once', 'x'],
    [T(2), 'cache cache cache', 'x'],
    [T(3), 'cache once', 'x'],
  ]);
  await idx.update();
  const hits = idx.search('cache').filter((h) => h.role === 'user');
  assert.deepEqual(hits.map((h) => h.turn), [1, 2, 0]); // most matches, then newest among equals
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(hits[1].score, hits[2].score);
  assert.equal(idx.search('cache', { limit: 2 }).length, 2);
});

test('incremental append reads only the new part', async () => {
  const { projects, cache, idx } = setup();
  const file = makeSession(projects, 's1', [[T(1), 'first topic', 'ok']]);
  await idx.update();
  const before = fs.readFileSync(path.join(shardDir(cache), 's1.json'), 'utf8');
  assert.equal((await idx.update()).unchanged, 1); // nothing changed: nothing rebuilt
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: T(2), message: { content: 'second topic' } }) + '\n');
  const stats = await idx.update();
  assert.equal(stats.appended, 1);
  assert.equal(stats.rebuilt, 0);
  assert.notEqual(fs.readFileSync(path.join(shardDir(cache), 's1.json'), 'utf8'), before);
  const hits = new TextIndex(projects, cache).search('second'); // a fresh instance reads the persisted index
  assert.equal(hits.length, 1);
  assert.equal(hits[0].turn, 1);
  assert.equal(new TextIndex(projects, cache).search('first').length, 1);
});

test('a half-written last line is indexed once it is complete', async () => {
  const { projects, idx } = setup();
  const file = makeSession(projects, 's1', [[T(1), 'alpha', 'ok']]);
  const line = JSON.stringify({ type: 'user', timestamp: T(2), message: { content: 'omega' } });
  fs.appendFileSync(file, line.slice(0, 20));
  await idx.update();
  assert.equal(idx.search('omega').length, 0);
  fs.appendFileSync(file, line.slice(20) + '\n');
  await idx.update();
  assert.equal(idx.search('omega').length, 1);
});

test('shrunk file is rebuilt, deleted file drops its shard', async () => {
  const { projects, cache, idx } = setup();
  const file = makeSession(projects, 's1', [[T(1), 'old words here', 'ok'], [T(2), 'more old words', 'ok']]);
  makeSession(projects, 's2', [[T(1), 'other session', 'ok']], { proj: 'p2' });
  await idx.update();
  makeSession(projects, 's1', [[T(1), 'new', 'ok']]);
  const stats = await idx.update();
  assert.equal(stats.rebuilt, 1);
  assert.equal(idx.search('old').length, 0);
  assert.equal(idx.search('new').length, 1);
  fs.unlinkSync(path.join(projects, 'p2', 's2.jsonl'));
  const s2 = await idx.update();
  assert.equal(s2.dropped, 1);
  assert.equal(fs.existsSync(path.join(shardDir(cache), 's2.json')), false);
  assert.equal(idx.search('other').length, 0);
  assert.ok(file);
});

test('corrupt or old-version shard and manifest are rebuilt, never crash', async () => {
  const { projects, cache, idx } = setup();
  makeSession(projects, 's1', [[T(1), 'findable text', 'ok']]);
  await idx.update();
  fs.writeFileSync(path.join(shardDir(cache), 's1.json'), '{not json');
  const fresh = new TextIndex(projects, cache);
  assert.deepEqual(fresh.search('findable'), []); // ignored, no throw
  assert.equal((await fresh.update()).added, 1);
  assert.equal(fresh.search('findable').length, 1);

  fs.writeFileSync(path.join(shardDir(cache), 's1.json'), JSON.stringify({ v: 999, docs: [], words: {} }));
  const old = new TextIndex(projects, cache);
  assert.equal(old.search('findable').length, 0);
  await old.update();
  assert.equal(old.search('findable').length, 1);

  fs.writeFileSync(path.join(shardDir(cache), 'manifest.json'), 'garbage');
  const again = new TextIndex(projects, cache);
  await again.update();
  assert.equal(again.search('findable').length, 1);
});

test('secrets are redacted before indexing and in snippets', async () => {
  const { projects, cache, idx } = setup();
  makeSession(projects, 's1', [[T(1), 'use sk-abcdefghijklmnopqrstuvwx and password=hunter2xyz please', 'noted']]);
  await idx.update();
  assert.equal(idx.search('abcdefghij').length, 0);
  assert.equal(idx.search('hunter2xyz').length, 0);
  const hits = idx.search('please');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet.excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(hits[0].snippet.excerpt, /hunter2|abcdefghij/);
  const raw = fs.readFileSync(path.join(shardDir(cache), 's1.json'), 'utf8');
  assert.doesNotMatch(raw, /hunter2|abcdefghij/);
});

test('shards hold no message text, only the vocabulary and references', async () => {
  const { projects, cache, idx } = setup();
  makeSession(projects, 's1', [[T(1), 'the quick brown fox jumps over', 'lazy dogs sleep']]);
  await idx.update();
  const shard = JSON.parse(fs.readFileSync(path.join(shardDir(cache), 's1.json'), 'utf8'));
  assert.deepEqual(Object.keys(shard).sort(), ['docs', 'id', 'turns', 'v', 'words']);
  const raw = JSON.stringify(shard);
  assert.doesNotMatch(raw, /quick brown|lazy dogs/);
  for (const d of shard.docs) assert.ok(d.every((x) => typeof x === 'number'));
});

test('noise prompts and sidechain records are skipped, turn numbers match the turn list', async () => {
  const { projects, idx } = setup();
  const file = makeSession(projects, 's1', [[T(1), '[Request interrupted by user]', 'asst one'], [T(2), 'real prompt', 'asst two']]);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'sidechain secret' } }) + '\n');
  await idx.update();
  assert.equal(idx.search('interrupted').length, 0);
  assert.equal(idx.search('sidechain').length, 0);
  assert.equal(idx.search('prompt')[0].turn, 1);
  assert.equal(idx.search('asst')[0].turn, 1); // newest first on equal scores
});

test('progress callback and missing projects dir', async () => {
  const { projects, idx } = setup();
  makeSession(projects, 's1', [[T(1), 'a b', 'c']]);
  makeSession(projects, 's2', [[T(1), 'a b', 'c']]);
  const seen = [];
  await idx.update({ onProgress: (p) => seen.push(p) });
  assert.deepEqual(seen[seen.length - 1], { done: 2, total: 2 });
  const none = new TextIndex(path.join(projects, 'nope'), tmpDir());
  assert.equal((await none.update()).sessions, 0);
  assert.deepEqual(none.search('a'), []);
});
