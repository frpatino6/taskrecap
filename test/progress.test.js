import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Aborted, askLlm, isAbort, makeStreamParser } from '../src/llm.js';
import { clip, makeFindingsScanner, makeMatchScanner, makeReporter, stage, throttle } from '../src/progress.js';
import { countRedactions, redact } from '../src/sessions.js';
import { tmpDir } from './helpers.js';

test('the findings scanner reports each finished capsule item once, with its section', () => {
  const scan = makeFindingsScanner();
  const part1 = '{"objective": "Fix the \\"thing\\"", "timeline": [{"date": "01-01", "result": "done", "cites": []}], "decisions": [{"decision": "Use cents", "why": "flo';
  assert.deepEqual(scan(part1), [
    { kind: 'objective', text: 'Fix the "thing"' },
    { kind: 'timeline', text: 'done' },
    { kind: 'decision', text: 'Use cents' },
  ]);
  assert.deepEqual(scan(part1), []); // nothing new
  const part2 = part1 + 'ats drift", "cites": []}], "dead_ends": [{"text": "tried floats"}], "left_out": [{"text": "i18n"}], "pending": [{"text": "more tests"}';
  assert.deepEqual(scan(part2), [
    { kind: 'dead_end', text: 'tried floats' },
    { kind: 'left_out', text: 'i18n' },
    { kind: 'pending', text: 'more tests' },
  ]);
});

test('the match scanner reports finished {key, reason} pairs only', () => {
  const scan = makeMatchScanner();
  assert.deepEqual(scan('{"matches":[{"key":"KK-1","reason":"about the thing"},{"key":"KK-2","reas'), [{ key: 'KK-1', reason: 'about the thing' }]);
  assert.deepEqual(scan('{"matches":[{"key":"KK-1","reason":"about the thing"},{"key":"KK-2","reason":"other"}]}'), [{ key: 'KK-2', reason: 'other' }]);
});

test('the reporter stamps events with time and usage, and fail() closes running stages', () => {
  const seen = [];
  const emit = makeReporter((e) => seen.push(e), () => ({ calls: 2, tokens: 30 }));
  stage(emit, 'scan', 'running');
  stage(emit, 'scan', 'done', 'scan_done', { sessions: 1 });
  stage(emit, 'votes', 'running');
  emit.fail('cancelled');
  assert.deepEqual(seen.map((e) => `${e.id}:${e.status}`), ['scan:running', 'scan:done', 'votes:running', 'votes:cancelled']);
  assert.ok(seen.every((e) => typeof e.ts === 'string' && e.usage.tokens === 30));
  assert.equal(seen[1].code, 'scan_done');
});

test('clip, throttle and countRedactions', () => {
  assert.equal(clip('a  b\nc', 10), 'a b c');
  assert.equal(clip('x'.repeat(20), 5), 'xxxx…');
  const calls = [];
  const t = throttle((n) => calls.push(n), 1000);
  t(1);
  t(2);
  assert.deepEqual(calls, [1]);
  const text = 'use password=hunter2 and sk-abcdefghijklmnopqrstuv now';
  assert.equal(countRedactions(text), 2);
  assert.equal(countRedactions(redact(text)), 0);
});

test('the stream parser follows the answer as it is written and ends with the real usage', () => {
  const texts = [];
  const parser = makeStreamParser((t) => texts.push(t));
  const delta = (text) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const result = JSON.stringify({ type: 'result', result: '{"a":1}', total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } });
  const wire = [delta('{"a"'), 'not json', delta(':1}'), result].join('\n');
  parser.push(wire.slice(0, 30)); // chunks may cut a line anywhere
  parser.push(wire.slice(30));
  const [text, meta] = parser.end();
  assert.deepEqual(texts, ['{"a"', '{"a":1}']);
  assert.equal(text, '{"a":1}');
  assert.deepEqual(meta, { cost_usd: 0.01, input_tokens: 15, output_tokens: 3 });
  assert.throws(() => makeStreamParser().end(), /without a result/);
});

function fakeClaude(dir, body) {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function withBinary(file, fn) {
  const before = process.env.TASKRECAP_CLAUDE_BIN;
  process.env.TASKRECAP_CLAUDE_BIN = file;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.TASKRECAP_CLAUDE_BIN;
    else process.env.TASKRECAP_CLAUDE_BIN = before;
  }
}

test('askLlm streams text pieces to onText when asked to', async () => {
  const dir = tmpDir();
  const bin = fakeClaude(dir, `
const out = (o) => console.log(JSON.stringify(o));
const d = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
out(d('{"matches":[{"key":"KK-1",'));
out(d('"reason":"why"}]}'));
out({ type: 'result', result: '{"matches":[{"key":"KK-1","reason":"why"}]}', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
`);
  const seen = [];
  const [text, meta] = await withBinary(bin, () => askLlm('prompt', { onText: (t) => seen.push(t) }));
  assert.equal(seen.length, 2);
  assert.ok(text.includes('"reason":"why"'));
  assert.equal(meta.output_tokens, 5);
});

test('aborting askLlm kills the claude process and rejects with Aborted', async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'pid');
  const bin = fakeClaude(dir, `
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const abort = new AbortController();
  const call = withBinary(bin, () => askLlm('prompt', { signal: abort.signal }));
  const assertion = assert.rejects(call, (e) => isAbort(e) && e instanceof Aborted);
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(pidFile), 'the fake claude process started');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  abort.abort();
  await assertion;
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the claude process is gone');
});

test('askLlm refuses to start when the signal is already aborted', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => askLlm('prompt', { signal: abort.signal }), isAbort);
});
