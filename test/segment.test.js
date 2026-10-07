import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundaryScores, contextScores, cosine, cueScores, keyScores, labelSegments, pickBoundaries, segment, tfidfVectors, timeScores, tokenize,
} from '../src/segment.js';

const turn = (over = {}) => ({
  ts: '2026-01-01T00:00:00Z', text: 'plain prompt', keys: [], cwd: '/a', branch: 'main', files: [], assistant: [], commands: [],
  noise: false, compaction: false, ...over,
});

test('tokenize drops stopwords, urls, hashes and accents', () => {
  assert.deepEqual(tokenize('Please fix the Código at https://x.io abcdef123456 now'), ['fix', 'codigo']);
});

test('cosine of identical vectors is 1 and of empty vectors is null', () => {
  const [a, b] = tfidfVectors([['alpha', 'beta'], ['alpha', 'gamma']]);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.ok(cosine(a, b) < 1);
  assert.equal(cosine(new Map(), a), null);
});

test('timeScores grows with the gap between prompts', () => {
  const turns = [turn(), turn({ ts: '2026-01-01T00:05:00Z' }), turn({ ts: '2026-01-02T00:05:00Z' })];
  const s = timeScores(turns);
  assert.equal(s[0], 0);
  assert.ok(s[2] > s[1] && s[1] > 0);
});

test('keyScores flags a key not seen recently (0.6 when none was active, 1 when another was)', () => {
  const turns = [turn({ keys: ['A-1'] }), turn({ keys: ['A-1'] }), turn({ keys: ['B-2'] }), turn()];
  assert.deepEqual(keyScores(turns), [0.6, 0, 1, 0]);
});

test('contextScores: cwd change is 1, branch change is 0.5', () => {
  const turns = [turn(), turn({ cwd: '/b' }), turn({ cwd: '/b', branch: 'feat' }), turn({ cwd: '/b', branch: 'HEAD' })];
  assert.deepEqual(contextScores(turns), [0, 1, 0.5, 0]);
});

test('cueScores recognises task-switch openers in English and Spanish', () => {
  const turns = [turn({ text: 'Different topic. The CI is flaky' }), turn({ text: 'ahora quiero otra cosa' }), turn({ text: 'fix the bug' })];
  assert.deepEqual(cueScores(turns), [1, 1, 0]);
});

test('pickBoundaries keeps the highest score within min_gap', () => {
  assert.deepEqual(pickBoundaries([0, 0.9, 0.95, 0, 0, 0, 0.85], 0.8, 4), [2, 6]);
  assert.deepEqual(pickBoundaries([0, 0.1], 0.8, 4), []);
});

test('segment splits a session at a new key + topic and labels the segments', () => {
  const turns = [];
  for (let i = 0; i < 6; i++) turns.push(turn({ ts: `2026-01-01T00:0${i}:00Z`, text: `A-1 checkout rounding cents total ${i}`, keys: ['A-1'], files: ['/r/src/cart/total.js'] }));
  for (let i = 0; i < 6; i++) turns.push(turn({ ts: `2026-01-02T00:0${i}:00Z`, text: `B-2 dark theme toggle colors ${i}`, keys: ['B-2'], files: ['/r/src/ui/theme.css'] }));
  const [bounds, segs] = segment(turns);
  assert.deepEqual(bounds, [6]);
  assert.deepEqual(segs.map((s) => s.key), ['A-1', 'B-2']);
  assert.equal(segs[0].n + segs[1].n, 12);
  const [scores] = boundaryScores(turns);
  assert.equal(scores.length, 12);
});

test('labelSegments redacts secrets in the snippet', () => {
  const segs = labelSegments([turn({ text: 'password=hunter2 please' })], []);
  assert.ok(!segs[0].snippet.includes('hunter2'));
});
