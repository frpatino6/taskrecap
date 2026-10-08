import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App, Busy, loadStrings } from '../src/app.js';
import { hostOf, startServer } from '../src/server.js';
import { fakeAsk, makeSession, tmpDir, ts } from './helpers.js';

let srv;
let app;
let calls;
let tmp;

before(async () => {
  tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 fix thing', 'ok'], [ts(1), 'KK-1 more', 'ok'], [ts(40), 'lunch?', 'pizza']]);
  makeSession(proj, 'BBBBBBBB-2222', [[ts(0), 'hello', 'ok']], { branch: 'main', proj: 'other' });
  calls = [];
  app = new App({
    projectsDir: proj, cacheDir: path.join(tmp, 'cache'), votes: 1, usageFile: path.join(tmp, 'usage.json'),
    ask: async (prompt) => { calls.push(prompt); return fakeAsk(prompt); },
  });
  srv = await startServer(app, 0);
});

after(() => srv.server.close());

function req(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: route, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* html */ }
        resolve([res.statusCode, parsed]);
      });
    });
    r.on('error', reject);
    r.end(body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined);
  });
}

test('binds to loopback only and serves the page and static endpoints', async () => {
  assert.equal(srv.server.address().address, '127.0.0.1');
  const [status, html] = await req('GET', '/');
  assert.equal(status, 200);
  assert.ok(html.includes('taskrecap'));
  assert.equal((await req('GET', '/api/info'))[1].name, 'taskrecap');
  assert.ok('generate' in (await req('GET', '/api/strings'))[1]);
  assert.equal((await req('GET', '/nope'))[0], 404);
});

test('tasks list and detail (no file paths leak to the page)', async () => {
  const [status, body] = await req('GET', '/api/tasks');
  assert.equal(status, 200);
  const byKey = Object.fromEntries(body.tasks.map((t) => [t.key, t]));
  assert.equal(byKey['KK-1'].generatable, true);
  const loose = body.tasks.find((t) => t.kind === 'session');
  assert.ok(loose && loose.generatable === false, 'a session without a task key is listed on its own and cannot have a capsule yet');
  const [s2, d] = await req('GET', '/api/tasks/KK-1');
  assert.equal(s2, 200);
  assert.equal(d.sessions.length, 1);
  assert.ok(!('path' in d.sessions[0]));
  assert.equal((await req('GET', '/api/tasks/DOES-NOT-EXIST'))[0], 404);
});

test('estimate shows tokens and cost without spending any', async () => {
  const before = calls.length;
  const [status, est] = await req('GET', '/api/estimate?key=KK-1');
  assert.equal(status, 200);
  assert.ok(est.usd > 0 && est.input_tokens > 0);
  assert.equal((await req('GET', '/api/estimate?key=unassigned'))[0], 400);
  assert.equal(calls.length, before);
});

test('normal search is free: it never calls the LLM', async () => {
  const before = calls.length;
  const [status, r] = await req('GET', '/api/search?q=kk-1');
  assert.equal(status, 200);
  assert.deepEqual(r.hits.map((h) => h.key), ['KK-1']);
  assert.deepEqual((await req('GET', '/api/search?q=zzzz'))[1].hits, []);
  assert.equal((await req('GET', '/api/search?q='))[1].hits, null);
  assert.equal(calls.length, before);
});

test('generate needs an explicit confirmation, then caches, counts usage and is searchable', async () => {
  const before = calls.length;
  assert.equal((await req('POST', '/api/generate', { key: 'KK-1' }))[0], 400);
  assert.equal((await req('POST', '/api/generate', { key: 'KK-1', confirm: 'yes' }))[0], 400);
  assert.equal(calls.length, before); // nothing was spent without an explicit confirm
  const [status, res] = await req('POST', '/api/generate', { key: 'KK-1', confirm: true });
  assert.equal(status, 200);
  assert.equal(res.capsule.objective, 'Fix the thing');
  assert.ok(Math.abs(res.info.cost_usd - 0.03) < 1e-9);
  assert.equal(res.info.tokens, 165); // 10+5 (range vote) + 100+50 (capsule)
  const [, d] = await req('GET', '/api/tasks/KK-1');
  assert.equal(d.capsule.capsule.briefing, 'Resume the thing.'); // served from the cache
  const tasks = Object.fromEntries((await req('GET', '/api/tasks'))[1].tasks.map((t) => [t.key, t]));
  assert.equal(tasks['KK-1'].has_capsule, true);
  assert.equal(tasks['KK-1'].objective, 'Fix the thing');
  const [, usage] = await req('GET', '/api/usage');
  assert.equal(usage.session.tokens, 165);
  assert.equal(usage.session.calls, 2);
  assert.ok(Math.abs(usage.session.usd - 0.03) < 1e-9);
  // the saved capsule text is now found by the free, literal search
  const [, found] = await req('GET', '/api/search?q=floats%20drift');
  assert.equal(found.hits[0].key, 'KK-1');
  assert.equal(found.hits[0].where, 'capsule');
});

test('AI search: estimate is free, a call needs confirmation, invented keys are dropped, usage is counted', async () => {
  const before = calls.length;
  assert.equal((await req('GET', '/api/ai-search/estimate?q='))[0], 400);
  const [s1, est] = await req('GET', '/api/ai-search/estimate?q=the%20thing');
  assert.equal(s1, 200);
  assert.ok(est.tasks >= 1 && est.usd > 0);
  assert.equal((await req('POST', '/api/ai-search', { query: 'the thing' }))[0], 400);
  assert.equal(calls.length, before);
  const tokensBefore = (await req('GET', '/api/usage'))[1].session.tokens;
  const [s2, res] = await req('POST', '/api/ai-search', { query: 'the thing', confirm: true });
  assert.equal(s2, 200);
  assert.deepEqual(res.matches.map((m) => m.key), ['KK-1']); // MADE-UP-9 is not a real task
  assert.equal(res.matches[0].reason, 'about the thing');
  assert.equal(res.usage.tokens, 220);
  assert.equal((await req('GET', '/api/usage'))[1].session.tokens, tokensBefore + 220);
});

test('generate rejects unassigned and bad input', async () => {
  assert.equal((await req('POST', '/api/generate', { key: 'unassigned', confirm: true }))[0], 400);
  assert.equal((await req('POST', '/api/generate', 'not json', { 'Content-Type': 'application/json' }))[0], 400);
  assert.equal((await req('POST', '/api/generate', 'x', { 'Content-Type': 'text/plain' }))[0], 415);
  assert.equal((await req('POST', '/api/other', {}))[0], 404);
});

test('foreign Host and Origin headers are blocked', async () => {
  assert.equal((await req('GET', '/api/tasks', undefined, { Host: 'evil.example.com' }))[0], 403);
  assert.equal((await req('POST', '/api/generate', { key: 'KK-1', confirm: true }, { Origin: 'https://evil.example.com' }))[0], 403);
  assert.equal((await req('GET', '/api/tasks', undefined, { Origin: 'http://localhost:8765' }))[0], 200);
});

test('hostOf strips the port and lowercases', () => {
  assert.equal(hostOf('LocalHost:8765'), 'localhost');
  assert.equal(hostOf(undefined), '');
});

test('startServer picks the next free port when the preferred one is busy', async () => {
  const taken = http.createServer();
  await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  const busyPort = taken.address().port;
  const second = await startServer(app, busyPort);
  assert.equal(second.port, busyPort + 1);
  second.server.close();
  taken.close();
});

test('a key that is already being generated is rejected', async () => {
  const dir = tmpDir();
  const a = new App({ projectsDir: path.join(dir, 'p'), cacheDir: path.join(dir, 'c'), ask: fakeAsk });
  a.busy.add('KK-1');
  await assert.rejects(() => a.generate('KK-1'), Busy);
});

test('strings fall back to English', () => {
  assert.equal(loadStrings('xx').llm_language, 'English');
});
