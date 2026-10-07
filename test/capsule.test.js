import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/capsule.js';
import { Aborted, estimateCost, extractJson, isAbort, parseClaudeOutput } from '../src/llm.js';
import { fakeAsk, makeSession, tmpDir, ts } from './helpers.js';

test('mergeRanges / leadRanges', () => {
  assert.deepEqual(C.mergeRanges([[5, 7], [0, 2], [3, 4]]), [[0, 7]]);
  assert.deepEqual(C.leadRanges([[6, 8]], 2), [[4, 5]]);
  assert.deepEqual(C.leadRanges([[1, 2], [4, 5]], 4), [[0, 0], [3, 3]]);
});

test('parseRanges clamps and ignores garbage', () => {
  const obj = { ranges: [{ start: -3, end: 2 }, { start: 'x' }, { start: 9, end: 4 }, { start: 8, end: 99 }] };
  assert.deepEqual(C.parseRanges(obj, 10), [[0, 2], [8, 9]]);
  assert.deepEqual(C.parseRanges(null, 10), []);
});

const mkTurns = () => Array.from({ length: 8 }, (_, i) => ({
  ts: `2026-01-01T00:0${i}:00Z`, text: `t${i}`, keys: i === 1 || i === 5 ? ['KK-1'] : [], cwd: '', branch: '',
  files: [], assistant: [], commands: [], noise: false, compaction: false,
}));

test('selectRanges keeps the UNION of the votes and falls back to heuristics', async () => {
  const answers = [{ ranges: [{ start: 0, end: 2 }] }, { ranges: [{ start: 5, end: 6 }] }, { ranges: [{ start: 0, end: 3 }] }];
  let n = 0;
  const ask = async () => [JSON.stringify(answers[n++]), {}];
  const [ranges, mode] = await C.selectRanges('KK-1', '/p/abcdefghi.jsonl', mkTurns(), ask, 3);
  assert.deepEqual(ranges, [[0, 3], [5, 6]]);
  assert.equal(mode, 'llm-vote3/3');
  const [, fallbackMode] = await C.selectRanges('KK-1', '/p/abcdefghi.jsonl', mkTurns(), async () => ['not json', {}], 2);
  assert.equal(fallbackMode, 'heuristic');
});

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('```json\n{"a": {"b": "}"}}\n```'), { a: { b: '}' } });
  assert.deepEqual(extractJson('Sure! {"x": 1} hope that helps'), { x: 1 });
  assert.throws(() => extractJson('no json here'));
  assert.throws(() => extractJson('{"open": '));
});

test('parseClaudeOutput reads text, real cost and token usage (cache tokens included)', () => {
  const stdout = JSON.stringify({
    result: '{"ok":true}', total_cost_usd: 0.0421,
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 4000, output_tokens: 55 },
  });
  assert.deepEqual(parseClaudeOutput(stdout), ['{"ok":true}', { cost_usd: 0.0421, input_tokens: 4210, output_tokens: 55 }]);
  assert.deepEqual(parseClaudeOutput(JSON.stringify({ result: 'x' }))[1], { cost_usd: null, input_tokens: 0, output_tokens: 0 });
  assert.throws(() => parseClaudeOutput('not json'), /non-JSON/);
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'boom' })), /boom/);
});

test('estimateCost scales with calls and input size', () => {
  const small = estimateCost(1, 4000, 3000);
  const big = estimateCost(4, 400000, 3600);
  assert.equal(small.input_tokens, 1000 + 4000);
  assert.ok(big.usd > small.usd);
  assert.ok(big.seconds > small.seconds);
});

test('commit events, the confirmed/possible split and pushed flag', () => {
  const ev = C.commitEvents('[feat/KK-1 abc1234] KK-1: do it\n 1 file changed\n   0000000..abc1234  feat -> feat', ts(1), 'main');
  assert.deepEqual(ev.map((e) => e.kind), ['commit', 'push']);
  const events = [...ev, { ts: ts(5), source: 'main', kind: 'commit', hash: '9999999', branch: 'other', msg: 'no key' }];
  const out = C.collectCommits(events, [[ts(0), '9999']], 'KK-1');
  assert.deepEqual(out.confirmed.map((c) => c.hash), ['abc1234']);
  assert.deepEqual(out.possible.map((c) => c.hash), ['9999999']);
  assert.equal(out.confirmed[0].pushed, true);
});

test('undoneByReset: same subagent, or a reset naming the hash', () => {
  const commit = { ts: ts(1), source: 'agent1', hash: 'abc1234' };
  const reset = { ts: ts(9), source: 'agent1', kind: 'revert', cmd: 'git reset --soft HEAD~1' };
  assert.equal(C.undoneByReset(commit, [reset]), true);
  assert.equal(C.undoneByReset({ ...commit, source: 'main' }, [{ ...reset, source: 'main' }]), false);
  assert.equal(C.undoneByReset({ ...commit, source: 'main' }, [{ ...reset, source: 'main', cmd: 'git reset --hard abc1234' }]), true);
});

test('files: final vs reverted, and scratch files ignored', () => {
  const events = [
    { ts: ts(1), source: 'main', kind: 'edit', path: '/r/src/a.js', cwd: '/r' },
    { ts: ts(2), source: 'main', kind: 'edit', path: '/r/src/b.js', cwd: '/r' },
    { ts: ts(3), source: 'main', kind: 'revert', cmd: 'git checkout -- src/b.js' },
    { ts: ts(1), source: 'main', kind: 'edit', path: '/tmp/scratch.txt', cwd: '/r' },
  ];
  const files = C.collectFiles(events, [[ts(0), '9999']]);
  assert.deepEqual(Object.fromEntries(files.map((f) => [f.short, f.status])), { 'r/src/a.js': 'final', 'r/src/b.js': 'reverted' });
});

test('mergeFiles adds edits and lets the latest status win', () => {
  const merged = C.mergeFiles([
    [{ short: 'r/a.js', edits: 1, status: 'reverted', last: ts(1) }],
    [{ short: 'r/a.js', edits: 2, status: 'final', last: ts(5) }],
  ]);
  assert.deepEqual(merged, [{ short: 'r/a.js', edits: 3, status: 'final', last: ts(5) }]);
});

test('shortPath falls back to the cwd when there is no repo on disk, and maps agent worktrees', () => {
  assert.equal(C.shortPath('/nope/demo/app/src/x.js', '/nope/demo/app'), 'app/src/x.js');
  assert.equal(C.shortPath('/h/shop/.claude/worktrees/agent-1/src/y.js'), 'shop/src/y.js');
});

test('the transcript is redacted and every line is tagged', () => {
  const turns = [{
    ts: '2026-01-02T03:04:05Z', text: 'use password=hunter2 now', files: ['/q/f.py'], assistant: ['done'],
    commands: ['git commit -m x'], noise: false, cwd: '/q', keys: [], branch: '', compaction: false,
  }];
  const text = C.buildTranscript('abcd1234', turns, [[0, 0]]);
  assert.ok(!text.includes('hunter2'));
  assert.ok(text.includes('[s:abcd1234 t:0 01-02T03:04]'));
  assert.ok(text.includes('> edit'));
});

test('validateCapsule drops uncited items and invalid citations', () => {
  const cap = {
    decisions: [{ decision: 'a', cites: [{ session: 's', turn: 1 }] }, { decision: 'b', cites: [{ session: 's', turn: 99 }] }, { decision: 'c' }],
    timeline: [{ cites: [{ session: 's', turn: 99 }] }],
  };
  const [clean, dropped] = C.validateCapsule(cap, { s: [[0, 2]] });
  assert.deepEqual(clean.decisions.map((d) => d.decision), ['a']);
  assert.equal(dropped.decisions, 2);
  assert.deepEqual(clean.timeline[0].cites, []);
});

test('validateCapsule drops any ts the model wrote on a timeline row', () => {
  const cap = { timeline: [{ date: '09-07', result: 'x', ts: '2020-01-01T00:00:00.000Z', cites: [{ session: 's', turn: 1 }] }] };
  const [clean] = C.validateCapsule(cap, { s: [[0, 2]] });
  assert.ok(!('ts' in clean.timeline[0]));
  assert.equal(clean.timeline[0].date, '09-07');
  assert.equal(clean.timeline[0].cites.length, 1, 'valid cites are kept');
});

test('renderMarkdown has every section', () => {
  const md = C.renderMarkdown('KK-1', { objective: 'o', briefing: 'b', decisions: [{ decision: 'd', why: 'w', cites: [{ session: 's', turn: 1 }] }] },
    [{ short: 'r/a.js', edits: 2, status: 'final' }], { confirmed: [], possible: [] }, ['`s`']);
  for (const needle of ['# Work capsule · KK-1', '## Decisions and why', '`s:1`', 'r/a.js', '## Briefing to resume']) assert.ok(md.includes(needle), needle);
});

function planFor(dir) {
  const file = makeSession(dir, 'AAAAAAAA-1111', [
    [ts(0), 'KK-1 fix the thing', 'looking', [['Edit', { file_path: '/x/app/src/a.js' }, 'ok']]],
    [ts(5), 'KK-1 use cents', 'ok', [['Bash', { command: "git commit -m 'KK-1 x'" }, '[fix/KK-1 abc1234] KK-1 x\n 1 file changed']]],
    [ts(30), 'unrelated question about lunch', 'pizza', []],
  ]);
  return [{ path: file, turns: C.loadRichTurns(file), mode: 'keyed' }];
}

test('generate with a mocked LLM: ranges, citations, commits and files', async () => {
  const res = await C.generate('KK-1', planFor(tmpDir()), fakeAsk, { votes: 2 });
  assert.equal(res.capsule.objective, 'Fix the thing');
  assert.deepEqual(res.capsule.decisions.map((d) => d.decision), ['Use cents']);
  assert.equal(res.commits.confirmed[0].hash, 'abc1234');
  assert.equal(res.files[0].short, 'app/src/a.js');
  assert.ok(!('path' in res.files[0]));
  assert.equal(res.info.range_mode.AAAAAAAA, 'llm-vote2/2');
});

test('a task not cited in the prompts uses the whole session with a single call', async () => {
  const calls = [];
  await C.generate('not-in-prompts', planFor(tmpDir()), async (p) => { calls.push(p); return fakeAsk(p); }, { votes: 3 });
  assert.equal(calls.length, 1);
});

test('estimateTask counts the calls and scales with votes', () => {
  const plan = planFor(tmpDir());
  const e3 = C.estimateTask('KK-1', plan, 3);
  const e1 = C.estimateTask('KK-1', plan, 1);
  assert.deepEqual([e3.calls, e1.calls], [4, 2]);
  assert.ok(e3.usd > 0);
  assert.equal(C.estimateTask('branchy', plan, 3).calls, 1);
});

test('generate rejects an empty plan', async () => {
  await assert.rejects(() => C.generate('KK-1', [], fakeAsk), /No sessions found/);
});

test('generate reports its real stages in order, with votes, merge, drafts and validation', async () => {
  const events = [];
  const ask = async (prompt, opts = {}) => {
    const answer = await fakeAsk(prompt);
    if (opts.onText && !prompt.includes('State which turn ranges')) { // the capsule call streams its answer
      opts.onText('{"objective": "Fix the thing", "decisions": [{"decision": "Use cents", "why": "x", "cites": []}], "pending": [{"text": "more tests"}]');
    }
    return answer;
  };
  await C.generate('KK-1', planFor(tmpDir()), ask, { votes: 2, emit: (e) => events.push(e) });
  const stages = events.filter((e) => e.type === 'stage');
  assert.deepEqual(stages.filter((e) => e.status === 'running').map((e) => e.id), ['redact', 'votes', 'merge', 'evidence', 'write', 'validate']);
  assert.deepEqual(stages.filter((e) => e.status === 'done').map((e) => e.id), ['redact', 'votes', 'merge', 'evidence', 'write', 'validate']);
  const votes = events.filter((e) => e.type === 'log' && e.code === 'vote_done');
  assert.deepEqual(votes.map((e) => `${e.vars.n}/${e.vars.of}`), ['1/2', '2/2']);
  assert.equal(votes[0].vars.turns, 2); // fakeAsk answers turns 0-1
  const merge = stages.find((e) => e.id === 'merge' && e.status === 'done');
  assert.deepEqual([merge.code, merge.vars.turns, merge.vars.sessions], ['merge_done', 2, 1]);
  const found = events.filter((e) => e.type === 'log' && e.code.startsWith('found_')).map((e) => `${e.code}:${e.vars.text}`);
  assert.deepEqual(found, ['found_objective:Fix the thing', 'found_decision:Use cents', 'found_pending:more tests']);
  const validate = stages.find((e) => e.id === 'validate' && e.status === 'done');
  assert.deepEqual(validate.vars, { kept: 1, total: 2, dropped: 1 }); // the uncited decision was dropped
  assert.ok(events.some((e) => e.type === 'log' && e.code === 'validate_dropped'));
  assert.ok(events.some((e) => e.type === 'progress' && e.id === 'write'));
});

test('a task that needs no AI selection skips the votes stage and says so', async () => {
  const events = [];
  await C.generate('not-in-prompts', planFor(tmpDir()), fakeAsk, { votes: 3, emit: (e) => events.push(e) });
  const votes = events.filter((e) => e.type === 'stage' && e.id === 'votes');
  assert.deepEqual(votes.map((e) => e.status), ['skipped']);
  assert.equal(votes[0].code, 'votes_skipped');
});

test('a failed vote is reported and the others still count', async () => {
  const events = [];
  let n = 0;
  const ask = async (prompt) => {
    if (prompt.includes('State which turn ranges') && n++ === 0) throw new Error('rate limited');
    return fakeAsk(prompt);
  };
  await C.generate('KK-1', planFor(tmpDir()), ask, { votes: 2, emit: (e) => events.push(e) });
  const failed = events.find((e) => e.code === 'vote_failed');
  assert.equal(failed.level, 'warn');
  assert.match(failed.vars.reason, /rate limited/);
  assert.ok(events.some((e) => e.code === 'vote_done'));
});

test('a cancel is never swallowed by a vote and stops generate between steps', async () => {
  const cancelling = async () => { throw new Aborted(); };
  await assert.rejects(() => C.selectRanges('KK-1', '/p/abcdefghi.jsonl', mkTurns(), cancelling, 3), isAbort);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => C.generate('KK-1', planFor(tmpDir()), fakeAsk, { signal: abort.signal }), isAbort);
});
