import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SessionIndex, CapsuleStore, isGeneratable } from '../src/tasks.js';
import { UsageTracker, sumMetas } from '../src/usage.js';
import { makeSession, tmpDir, ts } from './helpers.js';

function fixture() {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 fix thing', 'ok'], [ts(1), 'KK-1 more', 'ok'], [ts(40), 'lunch?', 'pizza']], { branch: 'fix/KK-1-thing' });
  makeSession(proj, 'BBBBBBBB-2222', [[ts(5), 'hello', 'ok']], { branch: 'main', proj: 'other' });
  makeSession(proj, 'CCCCCCCC-3333', [[ts(9), 'autocomplete', 'ok']], { branch: 'feature/autocomplete', proj: 'third' });
  fs.writeFileSync(path.join(proj, 'other', 'EMPTY.jsonl'), JSON.stringify({ type: 'system', timestamp: ts(0) }) + '\n');
  return proj;
}

test('tasks are grouped by key, then branch, with unassigned last and empty sessions hidden', () => {
  const idx = new SessionIndex(fixture());
  const tasks = idx.tasks();
  assert.deepEqual(tasks.map((t) => [t.key, t.kind]), [
    ['KK-1', 'key'], ['feature/autocomplete', 'branch'], ['unassigned', 'unassigned'],
  ]);
  assert.equal(idx.sessions().length, 3); // the empty session does not count
  assert.equal(tasks.find((t) => t.key === 'KK-1').prompts, 3);
  assert.equal(isGeneratable('unassigned'), false);
});

test('a key cited often in another session still pulls that session into the task', () => {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA', [[ts(0), 'KK-1 start', 'ok']], { branch: 'fix/KK-1' });
  makeSession(proj, 'BBBBBBBB', [[ts(1), 'back to KK-2', 'ok'], [ts(2), 'KK-1 again', 'ok'], [ts(3), 'KK-1 and again', 'ok']], { branch: 'fix/KK-2', proj: 'p2' });
  const idx = new SessionIndex(proj);
  assert.equal(idx.taskSessions('KK-1').length, 2);
  assert.equal(idx.taskSessions('KK-2').length, 1);
});

test('the index re-parses a session when its file changes', () => {
  const proj = tmpDir();
  const file = makeSession(proj, 'AAAAAAAA', [[ts(0), 'hello', 'ok']]);
  const idx = new SessionIndex(proj);
  assert.equal(idx.sessions()[0].n_prompts, 1);
  makeSession(proj, 'AAAAAAAA', [[ts(0), 'hello', 'ok'], [ts(1), 'again', 'ok']]);
  assert.ok(fs.existsSync(file));
  assert.equal(idx.sessions()[0].n_prompts, 2);
});

test('a missing sessions folder is simply empty', () => {
  assert.deepEqual(new SessionIndex('/definitely/not/here').tasks(), []);
});

test('CapsuleStore saves json + markdown, loads them back and lists keys', () => {
  const store = new CapsuleStore(path.join(tmpDir(), 'cache'));
  assert.equal(store.load('KK-1'), null);
  const saved = store.save('KK-1', { key: 'KK-1', capsule: { objective: 'o' }, markdown: '# md' });
  assert.ok(saved.generated_at);
  assert.equal(store.load('KK-1').capsule.objective, 'o');
  assert.equal(fs.readFileSync(store.filePath('KK-1', 'md'), 'utf8'), '# md');
  store.save('feature/x y', { key: 'feature/x y', markdown: '' }); // unsafe characters are sanitised in the file name
  assert.deepEqual([...store.keys()].sort(), ['KK-1', 'feature/x y']);
});

test('CapsuleStore.all() parses each file once, and sees saves, edits from outside and deletions', () => {
  const store = new CapsuleStore(path.join(tmpDir(), 'cache'));
  store.save('KK-1', { key: 'KK-1', capsule: { objective: 'first' }, markdown: '' });
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (...a) => { parses += 1; return parse(...a); };
  try {
    assert.equal(store.all()[0].capsule.objective, 'first');
    store.all();
    store.all();
    assert.equal(parses, 1); // later listings cost a directory scan, not a parse
    store.save('KK-1', { key: 'KK-1', capsule: { objective: 'second' }, markdown: '' }); // regenerated
    assert.equal(store.all()[0].capsule.objective, 'second');
    assert.equal(parses, 2);
    fs.writeFileSync(store.filePath('KK-1', 'json'), JSON.stringify({ key: 'KK-1', capsule: { objective: 'edited outside, longer' } })); // another process
    assert.equal(store.all()[0].capsule.objective, 'edited outside, longer');
    fs.rmSync(store.filePath('KK-1', 'json'));
    assert.deepEqual(store.all(), []);
  } finally {
    JSON.parse = parse;
  }
});

test('UsageTracker keeps session and persisted totals apart', () => {
  const file = path.join(tmpDir(), 'usage.json');
  const a = new UsageTracker(file);
  a.record({ cost_usd: 0.1, input_tokens: 1000, output_tokens: 200 });
  a.record({ cost_usd: 0.05, input_tokens: 500, output_tokens: 100 });
  assert.deepEqual(a.snapshot().session, { calls: 2, input_tokens: 1500, output_tokens: 300, usd: 0.15, tokens: 1800 });
  const b = new UsageTracker(file); // a new app start: session resets, total persists
  assert.equal(b.snapshot().session.tokens, 0);
  assert.equal(b.snapshot().total.tokens, 1800);
  b.record(null); // a call without usage data must not break the counter
  assert.equal(b.snapshot().total.calls, 3);
  assert.equal(new UsageTracker(null).snapshot().total.tokens, 0);
});

test('sumMetas adds calls, tokens and cost', () => {
  assert.deepEqual(sumMetas([{ cost_usd: 0.1, input_tokens: 5, output_tokens: 1 }, {}, null]),
    { calls: 3, input_tokens: 5, output_tokens: 1, cost_usd: 0.1, tokens: 6 });
});
