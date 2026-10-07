import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Counter } from '../src/util.js';
import { UNASSIGNED, detectKey, findKeys, parseSession, promptKeyCounts, redact, userText } from '../src/sessions.js';
import { makeSession, tmpDir, ts } from './helpers.js';

test('findKeys ignores known false positives and honours a custom regex', () => {
  assert.deepEqual(findKeys('ABC-123 and UTF-8 and SHA-256 and IE9-11 and QRS-7'), ['ABC-123', 'QRS-7']);
  assert.deepEqual(findKeys('fix #42 and #7', String.raw`#\d+`), ['#42', '#7']);
  assert.deepEqual(findKeys(''), []);
});

test('redact removes tokens, keys and password assignments', () => {
  const text = 'use password=hunter2 and sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuv and Token: abc123';
  const out = redact(text);
  for (const secret of ['hunter2', 'sk-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuv', 'abc123']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('[REDACTED]'));
  assert.equal(redact(null), '');
});

test('userText keeps real prompts and drops injected reminders / tool results', () => {
  assert.equal(userText({ content: '  hello  ' }), 'hello');
  assert.equal(userText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(userText({ content: '<system-reminder>x</system-reminder>' }), '');
  assert.equal(userText({ content: [{ type: 'tool_result', content: 'x' }] }), '');
});

test('detectKey layers: branch regex, prompts, branch name, unassigned', () => {
  const dir = tmpDir();
  const mk = (sid, branch, user) => parseSession(makeSession(dir, sid, [[ts(0), user, 'ok']], { branch }));
  assert.deepEqual(detectKey(mk('s1', 'fix/KK-1-thing', 'hello')), ['KK-1', 'branch-regex']);
  assert.deepEqual(detectKey(mk('s2', 'main', 'work on KK-2 please, KK-2 again, KK-3 once')), ['KK-2', 'prompt-or-commit-regex']);
  assert.deepEqual(detectKey(mk('s3', 'feature/autocomplete', 'hello')), ['feature/autocomplete', 'branch-name']);
  assert.deepEqual(detectKey(mk('s4', 'main', 'hello')), [UNASSIGNED, 'none']);
  assert.deepEqual(detectKey(mk('s5', 'worktree-agent-abc', 'hello')), [UNASSIGNED, 'none']);
});

test('promptKeyCounts counts a prompt once per key', () => {
  const dir = tmpDir();
  const s = parseSession(makeSession(dir, 's', [[ts(0), 'KK-1 KK-1 KK-1', 'a'], [ts(1), 'KK-1 and KK-2', 'b']]));
  assert.deepEqual(Object.fromEntries(promptKeyCounts(s)), { 'KK-1': 2, 'KK-2': 1 });
});

test('Counter.mostCommon keeps insertion order for ties', () => {
  const c = new Counter();
  c.add('b').add('a').add('a').add('c').add('b');
  assert.deepEqual(c.mostCommon(), [['b', 2], ['a', 2], ['c', 1]]);
  assert.deepEqual(c.mostCommon(1), [['b', 2]]);
});
