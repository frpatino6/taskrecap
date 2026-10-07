import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App } from '../src/app.js';
import { loadRichTurns } from '../src/capsule.js';
import { EvidenceError, parseSources, readEvidence, resolveSession } from '../src/evidence.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir, ts } from './helpers.js';

const SID = 'cafe1234-0000-4000-8000-000000000001';
let tmp;
let proj;
let file;
let app;
let srv;

/** A session where several jsonl lines are NOT turns (injected reminder, tool result, sidechain): the turn index must skip them. */
function writeTrickySession(dir, sid) {
  fs.mkdirSync(dir, { recursive: true });
  const base = (m) => ({ timestamp: ts(m), gitBranch: 'fix/KK-7', cwd: '/x/shop' });
  const lines = [
    { type: 'user', ...base(0), message: { content: 'KK-7 start the checkout work' } },
    { type: 'assistant', ...base(0), message: { content: [{ type: 'text', text: 'Plan: fix the cart.' }, { type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/x/shop/src/cart.js' } }] } },
    { type: 'user', ...base(1), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'user', ...base(1), message: { content: '<system-reminder>injected, not a turn</system-reminder>' } },
    { type: 'user', ...base(1), isSidechain: true, message: { content: 'subagent prompt, not a turn' } },
    { type: 'user', ...base(2), message: { content: 'MARKER-ONE use integer cents, password=hunter2 sk-abcdefghijklmnop1234' } },
    { type: 'assistant', ...base(2), message: { content: [{ type: 'text', text: 'Done, committing.' }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git commit -m "KK-7 cents"' } }] } },
    { type: 'user', ...base(3), message: { content: 'KK-7 now ship it' } },
    { type: 'assistant', ...base(3), message: { content: [{ type: 'text', text: 'Shipped.' }] } },
  ];
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

/** Stands in for the LLM: selects every turn, then cites the turn whose transcript line holds MARKER-ONE. */
async function citingAsk(prompt) {
  const meta = { cost_usd: 0.01, input_tokens: 10, output_tokens: 5 };
  if (prompt.includes('State which turn ranges')) return [JSON.stringify({ ranges: [{ start: 0, end: 2 }] }), meta];
  const m = prompt.match(/\[s:(\S+) t:(\d+) [^\]]*\] USER: MARKER-ONE/);
  assert.ok(m, 'the transcript must carry a tag for the marked prompt');
  const cap = {
    objective: 'Fix checkout', timeline: [{ date: '01-01', repo: 'shop', result: 'cents', cites: [{ session: m[1], turn: Number(m[2]) }] }],
    decisions: [{ decision: 'Use integer cents', why: 'floats drift', cites: [{ session: m[1], turn: Number(m[2]) }] }],
    dead_ends: [], left_out: [], pending: [], briefing: 'Resume.',
  };
  return [JSON.stringify(cap), meta];
}

before(async () => {
  tmp = tmpDir();
  proj = path.join(tmp, 'projects');
  file = writeTrickySession(path.join(proj, 'p1'), SID);
  makeSession(proj, 'dupe0001-aaaa', [[ts(0), 'one', 'ok']], { proj: 'p2' });
  makeSession(proj, 'dupe0001-bbbb', [[ts(0), 'two', 'ok']], { proj: 'p3' });
  app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), votes: 1, usageFile: path.join(tmp, 'usage.json'), ask: citingAsk });
  srv = await startServer(app, 0);
});

after(() => srv.server.close());

function get(route, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')]));
    }).on('error', reject);
  });
}

test('turn indexing skips reminders, tool results and sidechains, exactly like the generator', () => {
  const turns = loadRichTurns(file);
  assert.deepEqual(turns.map((t) => t.text.slice(0, 12)), ['KK-7 start t', 'MARKER-ONE u', 'KK-7 now shi']);
});

test('round trip: a citation written by a real generation resolves to the exact message it cited', async () => {
  const cap = await app.generate('KK-7');
  const cite = cap.capsule.decisions[0].cites[0];
  assert.deepEqual(cite, { session: SID.slice(0, 8), turn: 1 });
  const r = app.evidence({ session: cite.session, turn: cite.turn, context: 1, key: 'KK-7' });
  const cited = r.turns.find((t) => t.cited);
  assert.equal(cited.turn, 1);
  assert.ok(cited.user.startsWith('MARKER-ONE use integer cents'));
  assert.equal(cited.assistant, 'Done, committing.');
  assert.deepEqual(cited.commands, ['git commit -m "KK-7 cents"']);
  assert.deepEqual(r.turns.map((t) => t.turn), [0, 1, 2]); // context 1 around turn 1
  assert.equal(r.confidence, 'verified');
  assert.equal(r.warning, null);
  assert.equal(r.session.id, SID);
  assert.equal(r.session.resume, `claude --resume ${SID}`);
  assert.deepEqual([r.session.project, r.session.branch, r.session.turns_total], ['shop', 'fix/KK-7', 3]);
});

test('every text is redacted before it leaves the server', () => {
  const r = readEvidence(file, 1, { context: 0 });
  const all = JSON.stringify(r);
  assert.ok(!all.includes('hunter2') && !all.includes('sk-abcdefghijklmnop1234'));
  assert.ok(r.turns[0].user.includes('[REDACTED]'));
});

test('context is clamped and the window stays inside the session', () => {
  assert.deepEqual(readEvidence(file, 0, { context: 50 }).turns.map((t) => t.turn), [0, 1, 2]);
  assert.deepEqual(readEvidence(file, 2, { context: 0 }).turns.map((t) => t.turn), [2]);
  assert.equal(readEvidence(file, 0, { context: -3 }).turns.length, 1);
  assert.equal(readEvidence(file, 0, {}).turns.length, 3); // default context is 2
});

test('long messages are shortened and flagged', () => {
  const dir = path.join(tmp, 'long');
  const f = makeSession(dir, 'long0001-xxxx', [[ts(0), 'x'.repeat(9000), 'y'.repeat(9000)]]);
  const t = readEvidence(f, 0, {}).turns[0];
  assert.equal(t.user.length, 4000);
  assert.deepEqual(t.truncated, { user: true, assistant: true });
});

test('a cited turn outside the capsule ranges is returned as unverified, never as verified', () => {
  assert.equal(readEvidence(file, 2, { ranges: [[0, 2]] }).confidence, 'verified');
  const r = readEvidence(file, 2, { ranges: [[0, 0]] });
  assert.equal(r.confidence, 'unverified');
  assert.ok(r.warning);
  assert.equal(readEvidence(file, 1, { ranges: [[2, 2]] }).confidence, 'verified'); // lead-up turns before a range are allowed
});

test('errors: unknown turn, shrunken session, bad numbers', () => {
  assert.throws(() => readEvidence(file, 3, {}), (e) => e instanceof EvidenceError && e.code === 'turn_missing');
  assert.throws(() => readEvidence(file, 1, { ranges: [[0, 9]] }), (e) => e.code === 'turn_missing'); // capsule used turn 9, file has 3
  for (const bad of ['x', -1, 1.5, null, undefined, '', ' ', '1e3']) assert.throws(() => readEvidence(file, bad, {}), (e) => e.code === 'bad_request');
});

test('resolveSession: unique prefix, missing, ambiguous, invalid', () => {
  const files = app.index.listFiles();
  assert.equal(resolveSession(files, 'CAFE1234'), file);
  assert.throws(() => resolveSession(files, 'zzzzzzzz'), (e) => e.code === 'not_found');
  assert.throws(() => resolveSession(files, 'dupe0001'), (e) => e.code === 'ambiguous');
  assert.throws(() => resolveSession(files, '../etc'), (e) => e.code === 'bad_request');
  assert.throws(() => resolveSession(files, ''), (e) => e.code === 'bad_request');
});

test('parseSources reads the ranges a capsule was written from', () => {
  assert.deepEqual(parseSources(['`E4D98F1E` (turns 1-5, 9-9)', 'garbage']), { e4d98f1e: [[1, 5], [9, 9]] });
  assert.deepEqual(parseSources(null), {});
});

test('/api/evidence: 200 with the cited message, errors with clear codes, local-only', async () => {
  const [status, body] = await get(`/api/evidence?session=${SID.slice(0, 8)}&turn=1&key=KK-7`);
  assert.equal(status, 200);
  assert.equal(body.turns.find((t) => t.cited).user.slice(0, 11), 'MARKER-ONE ');
  assert.equal(body.confidence, 'verified');
  let [s, b] = await get('/api/evidence?session=zzzzzzzz&turn=1');
  assert.deepEqual([s, b.code], [404, 'not_found']);
  assert.match(b.error, /no longer exists/);
  [s, b] = await get(`/api/evidence?session=${SID.slice(0, 8)}&turn=99`);
  assert.deepEqual([s, b.code], [404, 'turn_missing']);
  [s, b] = await get('/api/evidence?session=dupe0001&turn=0');
  assert.deepEqual([s, b.code], [409, 'ambiguous']);
  [s, b] = await get('/api/evidence?session=&turn=0');
  assert.deepEqual([s, b.code], [400, 'bad_request']);
  [s, b] = await get(`/api/evidence?session=${SID.slice(0, 8)}&turn=abc`);
  assert.deepEqual([s, b.code], [400, 'bad_request']);
  [s, b] = await get(`/api/evidence?session=${SID.slice(0, 8)}`); // a missing turn must not silently mean turn 0
  assert.deepEqual([s, b.code], [400, 'bad_request']);
  [s] = await get(`/api/evidence?session=${SID.slice(0, 8)}&turn=1`, { Origin: 'http://evil.example' });
  assert.equal(s, 403);
});
