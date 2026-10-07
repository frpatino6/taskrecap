import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FileIndex, sessionEdits, sessionLinks } from '../src/files.js';
import { CapsuleStore, SessionIndex } from '../src/tasks.js';
import { makeSession, tmpDir, ts } from './helpers.js';

const edit = (file) => ['Edit', { file_path: file }, 'ok'];
const cap = (key, files) => ({ key, capsule: { objective: key, timeline: [], decisions: [], dead_ends: [], left_out: [], pending: [], briefing: '' }, files, commits: { confirmed: [], possible: [] }, markdown: '' });

/** KK-1 (shop), KK-2 (blog, same relative file name), KK-3 (main key) with KK-4 mentioned from turn 1 on. */
function fixture() {
  const proj = tmpDir();
  const cache = tmpDir();
  makeSession(proj, 'AAAAAAAA', [
    [ts(0), 'KK-1 start', 'ok', [edit('/x/shop/src/index.js'), edit('/x/shop/src/cart.js'), edit('/x/shop/.claude/memory.md'), edit('/tmp/scratch.js')]],
    [ts(1), 'KK-1 more', 'ok', [edit('/x/shop/src/cart.js')]],
  ], { branch: 'fix/KK-1', cwd: '/x/shop' });
  makeSession(proj, 'BBBBBBBB', [[ts(5), 'KK-2 blog', 'ok', [edit('/x/blog/src/index.js')]]], { branch: 'fix/KK-2', cwd: '/x/blog', proj: 'blog' });
  makeSession(proj, 'CCCCCCCC', [
    [ts(10), 'KK-3 start', 'ok', [edit('/x/lib/a.js')]],
    [ts(11), 'now KK-4 thing', 'ok', [edit('/x/lib/b.js')]],
    [ts(12), 'KK-4 again', 'ok', [edit('/x/lib/c.js')]],
  ], { branch: 'fix/KK-3', cwd: '/x/lib', proj: 'lib' });
  const index = new SessionIndex(proj);
  const store = new CapsuleStore(path.join(cache, 'capsules'));
  const file = path.join(cache, 'capsules', '.index', 'files.json');
  return { proj, cache, index, store, file, fx: new FileIndex(index, store, file) };
}

const linksOf = (fx, short) => Object.fromEntries(fx.tasksOf(short).map((l) => [l.key, l]));

test('files are keyed by repo + path inside the repo, so the same name in two repos never collides', () => {
  const { fx } = fixture();
  assert.deepEqual(Object.keys(linksOf(fx, 'shop/src/index.js')), ['KK-1']);
  assert.deepEqual(Object.keys(linksOf(fx, 'blog/src/index.js')), ['KK-2']);
  assert.deepEqual(fx.tasksOf('src/index.js'), []); // no bare file names
});

test("Claude's own files and scratch dirs are not task work", () => {
  const { fx } = fixture();
  const all = Object.keys(fx.get().files);
  assert.ok(!all.some((f) => f.includes('.claude') || f.includes('scratch')));
});

test('without a capsule the links are approximate and say they come from the sessions', () => {
  const { fx } = fixture();
  const l = linksOf(fx, 'shop/src/cart.js')['KK-1'];
  assert.equal(l.approximate, true);
  assert.equal(l.status, 'edited');
  assert.equal(l.basis, 'session');
  assert.equal(l.edits, 2);
});

test('a capsule is the source of truth for its task: final vs reverted, and no session guesses on top', () => {
  const { fx, store } = fixture();
  store.save('KK-1', cap('KK-1', [{ short: 'shop/src/cart.js', status: 'reverted', edits: 3, last: ts(1) }, { short: 'shop/src/new.js', status: 'final', edits: 1, last: ts(1) }]));
  const cart = linksOf(fx, 'shop/src/cart.js')['KK-1'];
  assert.deepEqual([cart.status, cart.approximate, cart.basis, cart.edits], ['reverted', false, 'capsule', 3]);
  assert.equal(linksOf(fx, 'shop/src/new.js')['KK-1'].status, 'final');
  assert.equal(linksOf(fx, 'shop/src/index.js')['KK-1'], undefined); // the capsule did not list it
  assert.equal(linksOf(fx, 'blog/src/index.js')['KK-2'].approximate, true); // KK-2 has no capsule yet
});

test('a session that only cites a task counts from its first mention onwards', () => {
  const { fx } = fixture();
  assert.deepEqual(Object.keys(linksOf(fx, 'lib/a.js')), ['KK-3']);
  const b = linksOf(fx, 'lib/b.js');
  assert.deepEqual(Object.keys(b).sort(), ['KK-3', 'KK-4']);
  assert.equal(b['KK-3'].basis, 'session');
  assert.equal(b['KK-4'].basis, 'mention');
  assert.equal(linksOf(fx, 'lib/a.js')['KK-4'], undefined); // edited before KK-4 was ever mentioned
});

test('several tasks on one file: capsule links first, then approximate ones', () => {
  const { fx, store } = fixture();
  store.save('KK-2', cap('KK-2', [{ short: 'shop/src/cart.js', status: 'final', edits: 1, last: ts(5) }]));
  const order = fx.tasksOf('shop/src/cart.js').map((l) => [l.key, l.approximate]);
  assert.deepEqual(order, [['KK-2', false], ['KK-1', true]]);
});

test('the index is persisted, reused after a restart, and only changed sessions are re-read', () => {
  const { index, store, file, fx, proj } = fixture();
  fx.get();
  assert.equal(fx.parsed, 3);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.readdirSync(store.dir).some((n) => n.endsWith('.json')), 'the index file must not look like a capsule');

  const again = new FileIndex(new SessionIndex(proj), new CapsuleStore(store.dir), file); // "restart"
  assert.deepEqual(Object.keys(again.get().files).sort(), Object.keys(fx.get().files).sort());
  assert.equal(again.parsed, 0);

  makeSession(proj, 'BBBBBBBB', [[ts(5), 'KK-2 blog', 'ok', [edit('/x/blog/src/index.js'), edit('/x/blog/src/new.js')]]], { branch: 'fix/KK-2', cwd: '/x/blog', proj: 'blog' });
  assert.deepEqual(Object.keys(linksOf(fx, 'blog/src/new.js')), ['KK-2']);
  assert.equal(fx.parsed, 4); // only the changed session was parsed again

  store.save('KK-2', cap('KK-2', []));
  assert.equal(fx.tasksOf('blog/src/index.js').length, 0); // the (empty) capsule now wins
  assert.equal(fx.parsed, 4); // a capsule change never re-reads transcripts
  assert.ok(index.sessions().length === 3);
});

test('a persisted index built for another key regex is not trusted', () => {
  const { file, proj, store, fx } = fixture();
  fx.get();
  const other = new FileIndex(new SessionIndex(proj, String.raw`\bKK-\d+\b`), new CapsuleStore(store.dir), file);
  other.get();
  assert.equal(other.parsed, 3);
});

test('find matches path fragments (any case or accent) and ranks files shared by several tasks first', () => {
  const { fx } = fixture();
  assert.deepEqual(fx.find('CART').files.map((f) => f.path), ['shop/src/cart.js']);
  assert.deepEqual(fx.find('src index').files.map((f) => f.path).sort(), ['blog/src/index.js', 'shop/src/index.js']);
  assert.equal(fx.find('nothing-like-this').total, 0);
  const top = fx.find('').files[0]; // lib/b.js is touched by KK-3 and KK-4
  assert.equal(top.path, 'lib/b.js');
  assert.equal(fx.find('', 2).files.length, 2);
  assert.ok(fx.find('', 2).total > 2);
});

test('sessionEdits and sessionLinks: first-mention attribution, edit counts and latest time', () => {
  const proj = tmpDir();
  const f = makeSession(proj, 'SSSSSSSS', [
    [ts(0), 'KK-1 a', 'ok', [edit('/x/app/one.js')]],
    [ts(1), 'KK-2 b', 'ok', [edit('/x/app/one.js'), edit('/x/app/two.js')]],
  ]);
  const data = sessionEdits(f);
  assert.deepEqual(data.keyTurns, { 'KK-1': 0, 'KK-2': 1 });
  const whole = sessionLinks([{ main: true, data, key: 'KK-1' }]);
  assert.equal(whole.get('app/one.js').edits, 2);
  const mention = sessionLinks([{ main: false, data, key: 'KK-2' }]);
  assert.deepEqual([...mention.keys()].sort(), ['app/one.js', 'app/two.js']);
  assert.equal(mention.get('app/one.js').edits, 1); // the turn-0 edit does not belong to KK-2
  assert.equal(mention.get('app/one.js').basis, 'mention');
  assert.equal(mention.get('app/one.js').last, ts(1));
});
