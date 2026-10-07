import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App } from '../src/app.js';
import { EvidenceError, readEvidence } from '../src/evidence.js';
import { PAGE_MAX, TEXT_CHARS, clearMessageCache, messageList, pageMessages } from '../src/messages.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir, ts } from './helpers.js';

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

test('messages are redacted, one line and clipped; automatic ones keep their number but are hidden', () => {
  const proj = path.join(tmpDir(), 'projects');
  const long = `KK-1 ${'long text '.repeat(60)}`;
  const file = makeSession(proj, 'AAAAAAAA-1111', [
    [ts(0), 'KK-1 use password=hunter2 and sk-abcdefghijklmnop1234\nsecond line', 'ok'],
    [ts(1), '[Request interrupted by user]', 'ok'],
    [ts(2), long, 'ok'],
  ], { branch: 'fix/KK-1' });
  const page = pageMessages(file, { key: 'KK-1', markable: true });
  assert.equal(page.total, 2);
  assert.equal(page.hidden_noise, 1);
  assert.deepEqual(page.messages.map((m) => m.turn), [0, 2], 'numbers are those of the evidence panel, automatic turn 1 is skipped');
  const [first, second] = page.messages;
  assert.ok(!/hunter2|sk-abcdefghijklmnop1234/.test(first.text), first.text);
  assert.ok(first.text.includes('[REDACTED]'));
  assert.ok(!first.text.includes('\n'));
  assert.equal(first.cut, false);
  assert.equal(second.text.length, TEXT_CHARS);
  assert.equal(second.cut, true);
});

test('pagination: offset and limit, the limit is capped and bad numbers fall back to the defaults', () => {
  const proj = path.join(tmpDir(), 'projects');
  const prompts = Array.from({ length: 130 }, (_, i) => [`2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, `KK-1 step ${i}`, 'ok']);
  const file = makeSession(proj, 'AAAAAAAA-1111', prompts, { branch: 'fix/KK-1' });
  const p1 = pageMessages(file, { key: 'KK-1', markable: true, limit: 40 });
  assert.deepEqual([p1.total, p1.messages.length, p1.messages[0].turn, p1.messages[39].turn], [130, 40, 0, 39]);
  const p2 = pageMessages(file, { key: 'KK-1', markable: true, offset: 40, limit: 40 });
  assert.deepEqual([p2.messages[0].turn, p2.messages.length], [40, 40]);
  const last = pageMessages(file, { key: 'KK-1', markable: true, offset: 120, limit: 40 });
  assert.equal(last.messages.length, 10);
  assert.equal(pageMessages(file, { limit: 100000 }).messages.length, PAGE_MAX);
  assert.deepEqual([pageMessages(file, { offset: 'abc', limit: 'x' }).offset, pageMessages(file, { limit: -5 }).limit], [0, 1]);
  assert.equal(pageMessages(file, { offset: 9999 }).messages.length, 0);
});

test('a session that mixes tasks: messages citing the key are marked, scope mine keeps only those', () => {
  const proj = path.join(tmpDir(), 'projects');
  const file = makeSession(proj, 'BBBBBBBB-2222', [
    [ts(0), 'KK-2 own work', 'ok'], [ts(1), 'also KK-1 please', 'ok'], [ts(2), 'back to KK-2', 'ok'], [ts(3), 'KK-1 done?', 'ok'], [ts(4), 'thanks', 'ok'],
  ], { branch: 'fix/KK-2' });
  const all = pageMessages(file, { key: 'KK-1', markable: true, main: false });
  assert.deepEqual(all.messages.map((m) => m.mine), [false, true, false, true, false]);
  const mine = pageMessages(file, { key: 'KK-1', markable: true, main: false, scope: 'mine' });
  assert.deepEqual(mine.messages.map((m) => m.turn), [1, 3]);
  assert.equal(mine.total, 2);
  const branchTask = pageMessages(file, { key: 'fix/KK-2', markable: false, scope: 'mine' });
  assert.equal(branchTask.total, 0, 'a branch name cannot be found in message text, so nothing is claimed');
  assert.ok(pageMessages(file, { key: 'fix/KK-2', markable: false }).messages.every((m) => m.mine === false));
});

test('scope new: messages after the capsule; in a shared session only those that cite the key', () => {
  const proj = path.join(tmpDir(), 'projects');
  const file = makeSession(proj, 'BBBBBBBB-2222', [
    [ts(0), 'KK-1 early', 'ok'], [ts(10), 'KK-2 unrelated', 'ok'], [ts(20), 'KK-1 late', 'ok'], [ts(30), 'KK-2 later unrelated', 'ok'],
  ], { branch: 'fix/KK-2' });
  const since = Date.parse(ts(5));
  const shared = pageMessages(file, { key: 'KK-1', markable: true, main: false, since, scope: 'new' });
  assert.deepEqual(shared.messages.map((m) => m.turn), [2]);
  const own = pageMessages(file, { key: 'KK-2', markable: true, main: true, since, scope: 'new' });
  assert.deepEqual(own.messages.map((m) => m.turn), [1, 2, 3], 'for the session own task every later message counts');
  assert.ok(own.messages.every((m) => m.new));
  assert.equal(pageMessages(file, { key: 'KK-1', markable: true, since: NaN, scope: 'new' }).total, 0, 'without a capsule date nothing is new');
});

test('the projection is cached per file version and picks up appended messages', () => {
  const proj = path.join(tmpDir(), 'projects');
  const file = makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 a', 'ok']], { branch: 'fix/KK-1' });
  clearMessageCache();
  const a = messageList(file);
  assert.equal(messageList(file), a, 'same object while the file is unchanged');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: ts(9), gitBranch: 'fix/KK-1', cwd: '/x/app', message: { content: 'KK-1 b' } }) + '\n');
  assert.equal(messageList(file).length, 2);
});

test('a listed message opens the same text in the evidence panel (same turn numbers)', () => {
  const proj = path.join(tmpDir(), 'projects');
  const dir = path.join(proj, 'p');
  fs.mkdirSync(dir, { recursive: true });
  const base = (m) => ({ timestamp: ts(m), gitBranch: 'fix/KK-7', cwd: '/x/shop' });
  const lines = [
    { type: 'user', ...base(0), message: { content: 'KK-7 start' } },
    { type: 'user', ...base(1), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'user', ...base(1), message: { content: '<system-reminder>injected</system-reminder>' } },
    { type: 'user', ...base(2), isSidechain: true, message: { content: 'sidechain prompt' } },
    { type: 'user', ...base(3), message: { content: 'KK-7 second real message' } },
    { type: 'user', ...base(4), message: { content: '[Request interrupted by user]' } },
    { type: 'user', ...base(5), message: { content: 'KK-7 third real message' } },
  ];
  const file = path.join(dir, 'cafe1234-0000-4000-8000-000000000007.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const page = pageMessages(file, { key: 'KK-7', markable: true });
  assert.deepEqual(page.messages.map((m) => m.turn), [0, 1, 3]);
  for (const m of page.messages) {
    const ev = readEvidence(file, m.turn, { context: 0 });
    assert.equal(oneLine(ev.turns[0].user), m.text, `turn ${m.turn}`);
    assert.equal(ev.turns[0].ts, m.ts);
  }
});

let tmp;
let app;
let srv;
const SID_A = 'aaaa1111-0000-4000-8000-000000000001';

before(async () => {
  tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, SID_A, [[ts(0), 'KK-1 start password=hunter2', 'ok'], [ts(10), 'KK-1 more', 'ok']], { branch: 'fix/KK-1', cwd: '/x/shop' });
  makeSession(proj, 'dupe0000-1111-4000-8000-000000000001', [[ts(0), 'KK-2 one', 'ok']], { branch: 'fix/KK-2' });
  makeSession(proj, 'dupe0000-2222-4000-8000-000000000002', [[ts(0), 'KK-2 two', 'ok']], { branch: 'fix/KK-2' });
  makeSession(proj, 'bbbb2222-0000-4000-8000-000000000003', [
    [ts(0), 'KK-3 own', 'ok'], [ts(5), 'KK-1 shared', 'ok'], [ts(6), 'KK-1 shared again', 'ok'], [ts(7), 'KK-3 own again', 'ok'],
  ], { branch: 'fix/KK-3' });
  makeSession(proj, 'cccc3333-0000-4000-8000-000000000004', [[ts(0), 'plain branch work', 'ok'], [ts(1), 'more branch work', 'ok']], { branch: 'feature/no-key' });
  app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: null });
  fs.mkdirSync(app.store.dir, { recursive: true });
  fs.writeFileSync(app.store.filePath('KK-1', 'json'), JSON.stringify({ key: 'KK-1', capsule: { objective: 'o' }, sources: [], markdown: '# x', generated_at: ts(8) }));
  srv = await startServer(app, 0);
});

after(() => srv.server.close());

function get(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, method: 'GET', path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = JSON.parse(raw); } catch { /* not json */ }
        resolve([res.statusCode, body]);
      });
    });
    r.on('error', reject);
    r.end();
  });
}

test('GET /api/messages returns a redacted page, with marking and the new flag', async () => {
  const [code, r] = await get(`/api/messages?key=KK-1&session=${SID_A}`);
  assert.equal(code, 200);
  assert.equal(r.session.id, SID_A);
  assert.equal(r.session.id8, SID_A.slice(0, 8));
  assert.equal(r.mark, true);
  assert.equal(r.generated_at, ts(8));
  assert.ok(!JSON.stringify(r).includes('hunter2'));
  assert.deepEqual(r.messages.map((m) => [m.turn, m.mine, m.new]), [[0, true, false], [1, true, true]]);
  const [, onlyNew] = await get(`/api/messages?key=KK-1&session=${SID_A}&scope=new`);
  assert.deepEqual(onlyNew.messages.map((m) => m.turn), [1]);
  const [, byPrefix] = await get(`/api/messages?key=KK-1&session=${SID_A.slice(0, 8)}&limit=1&offset=1`);
  assert.deepEqual([byPrefix.total, byPrefix.messages.length, byPrefix.messages[0].turn], [2, 1, 1]);
});

test('GET /api/messages: a shared session marks the messages citing the key; a branch task marks nothing', async () => {
  const [, shared] = await get('/api/messages?key=KK-1&session=bbbb2222');
  assert.deepEqual(shared.messages.map((m) => m.mine), [false, true, true, false]);
  const [, branch] = await get('/api/messages?key=feature%2Fno-key&session=cccc3333');
  assert.equal(branch.mark, false);
  assert.ok(branch.messages.every((m) => !m.mine && !m.new));
});

test('GET /api/messages: unknown, ambiguous and malformed sessions give clear errors', async () => {
  const [missing, m1] = await get('/api/messages?key=KK-1&session=ffff9999');
  assert.equal(missing, 404);
  assert.match(m1.error, /no longer exists/);
  const [ambiguous, m2] = await get('/api/messages?key=KK-2&session=dupe0000');
  assert.equal(ambiguous, 409);
  assert.match(m2.error, /More than one session/);
  assert.equal((await get('/api/messages?key=KK-2&session=dupe0000-1111')) [0], 200, 'a longer id resolves the ambiguity');
  const [bad] = await get('/api/messages?key=KK-1&session=../etc');
  assert.equal(bad, 400);
  const [none] = await get('/api/messages?key=KK-1');
  assert.equal(none, 400);
});

test('GET /api/messages refuses other sites (same local-only protection as the rest of the API)', async () => {
  const [code] = await get(`/api/messages?key=KK-1&session=${SID_A}`, { Origin: 'http://evil.example' });
  assert.equal(code, 403);
});

test('GET /api/tasks/<key>: sessions say if they are shared and how many messages are new, and leak no internals', async () => {
  const [code, d] = await get('/api/tasks/KK-1');
  assert.equal(code, 200);
  assert.equal(d.markable, true);
  assert.equal(d.stale.known, true);
  assert.equal(d.stale.new_messages, d.sessions.reduce((n, s) => n + s.new_messages, 0));
  const own = d.sessions.find((s) => s.id === SID_A);
  assert.deepEqual([own.main, own.mixed, own.task_mentions, own.new_messages], [true, false, 2, 1]);
  const shared = d.sessions.find((s) => s.id.startsWith('bbbb2222'));
  assert.deepEqual([shared.main, shared.mixed, shared.task_mentions], [false, true, 2]);
  for (const s of d.sessions) {
    assert.ok(!('path' in s) && !('prompt_ts' in s) && !('mention_ts' in s) && !('mentions' in s), 'internal fields are not sent');
  }
  const [, branch] = await get('/api/tasks/feature%2Fno-key');
  assert.deepEqual([branch.markable, branch.stale], [false, null]);
});

test('an unknown session id is an EvidenceError, not a crash', () => {
  assert.throws(() => app.sessionMessages({ key: 'KK-1', session: 'ffff9999' }), EvidenceError);
});
