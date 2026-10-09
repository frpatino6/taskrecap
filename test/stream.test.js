import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App } from '../src/app.js';
import { Aborted } from '../src/llm.js';
import { startServer } from '../src/server.js';
import { fakeAsk, makeSession, tmpDir, ts } from './helpers.js';

const servers = [];
after(() => servers.forEach((s) => s.server.close()));

async function boot(ask) {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 fix thing', 'ok'], [ts(1), 'KK-1 more', 'ok'], [ts(40), 'lunch?', 'pizza']]);
  makeSession(proj, 'BBBBBBBB-2222', [[ts(0), 'hello', 'ok']], { branch: 'main', proj: 'other' });
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), votes: 1, usageFile: path.join(tmp, 'usage.json'), ask });
  const srv = await startServer(app, 0);
  servers.push(srv);
  return { app, srv, cache: path.join(tmp, 'cache') };
}

/** POST asking for the NDJSON progress stream. Events are collected as they arrive. */
function openStream(srv, route, body, headers = {}) {
  const events = [];
  const waiters = [];
  const out = { events, req: null, status: 0, raw: '' };
  const notify = () => waiters.splice(0).forEach((w) => w());
  out.finished = new Promise((resolve) => {
    out.req = http.request({
      host: '127.0.0.1', port: srv.port, method: 'POST', path: route,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...headers },
    }, (res) => {
      out.status = res.statusCode;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        out.raw += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim() && res.headers['content-type'].includes('ndjson')) events.push(JSON.parse(line));
        }
        notify();
      });
      res.on('end', () => { notify(); resolve(out); });
      res.on('close', () => { notify(); resolve(out); });
    });
    out.req.on('error', () => resolve(out));
    out.req.end(JSON.stringify(body));
  });
  out.until = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for an event')), ms);
    const check = () => {
      const hit = events.find(pred);
      if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check);
    };
    check();
  });
  return out;
}

const wait = async (cond, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 25) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

let ok;
before(async () => { ok = await boot(fakeAsk); });

test('generate streams its stages in order and ends with the saved capsule', async () => {
  const s = openStream(ok.srv, '/api/generate', { key: 'KK-1', confirm: true });
  await s.finished;
  assert.equal(s.status, 200);
  const { events } = s;
  assert.equal(events[0].type, 'start');
  assert.deepEqual(events[0].stages, ['scan', 'redact', 'votes', 'merge', 'evidence', 'write', 'validate', 'save']);
  const order = events.filter((e) => e.type === 'stage' && e.status === 'done').map((e) => e.id);
  assert.deepEqual(order, ['scan', 'redact', 'votes', 'merge', 'evidence', 'write', 'validate', 'save']);
  assert.ok(events.every((e) => typeof e.ts === 'string'));
  const calls = events.map((e) => (e.usage ? e.usage.calls : 0));
  assert.deepEqual(calls, [...calls].sort((a, b) => a - b)); // the running usage never goes down
  assert.equal(events.at(-1).usage.calls, 2);
  assert.equal(events.at(-1).usage.tokens, 165);
  const last = events.at(-1);
  assert.equal(last.type, 'done');
  assert.equal(last.result.capsule.objective, 'Fix the thing');
  assert.ok(fs.existsSync(path.join(ok.cache, 'KK-1.json')));
  assert.equal(ok.app.busy.size, 0);
});

test('the stream endpoint still needs a confirmation and keeps normal HTTP errors before it starts', async () => {
  const before = (await new Promise((r) => http.get({ host: '127.0.0.1', port: ok.srv.port, path: '/api/usage' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(JSON.parse(b))); }))).session.calls;
  const noConfirm = openStream(ok.srv, '/api/generate', { key: 'KK-1' });
  await noConfirm.finished;
  assert.equal(noConfirm.status, 400);
  const unassigned = openStream(ok.srv, '/api/generate', { key: 'unassigned', confirm: true });
  await unassigned.finished;
  assert.equal(unassigned.status, 400);
  assert.match(unassigned.raw, /not a unit with a capsule/);
  const foreign = openStream(ok.srv, '/api/generate', { key: 'KK-1', confirm: true }, { Origin: 'https://evil.example.com' });
  await foreign.finished;
  assert.equal(foreign.status, 403);
  const after = (await new Promise((r) => http.get({ host: '127.0.0.1', port: ok.srv.port, path: '/api/usage' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(JSON.parse(b))); }))).session.calls;
  assert.equal(after, before);
});

test('AI search streams matches as found, drops invented keys and ends with the result', async () => {
  const s = openStream(ok.srv, '/api/ai-search', { query: 'the thing', confirm: true });
  await s.finished;
  const { events } = s;
  assert.deepEqual(events[0].stages, ['catalog', 'ask', 'rank']);
  assert.deepEqual(events.filter((e) => e.type === 'match').map((e) => e.key), ['KK-1']);
  const rank = events.find((e) => e.type === 'stage' && e.id === 'rank' && e.status === 'done');
  assert.deepEqual(rank.vars, { matches: 1, dropped: 1 });
  const last = events.at(-1);
  assert.equal(last.type, 'done');
  assert.deepEqual(last.result.matches.map((m) => m.key), ['KK-1']);
  assert.equal(last.usage.tokens, 220);
});

test('an LLM failure is shown on the stage that failed, then as an error event; nothing is saved', async () => {
  const bad = await boot(async (prompt, opts) => {
    if (prompt.includes('You are an analyst. Below is the evidence')) throw new Error('boom: model overloaded');
    return fakeAsk(prompt, opts);
  });
  const s = openStream(bad.srv, '/api/generate', { key: 'KK-1', confirm: true });
  await s.finished;
  const { events } = s;
  const failedStage = events.find((e) => e.type === 'stage' && e.status === 'error');
  assert.equal(failedStage.id, 'write');
  const last = events.at(-1);
  assert.equal(last.type, 'error');
  assert.match(last.message, /boom: model overloaded/);
  assert.ok(!events.some((e) => e.type === 'done'));
  assert.equal(bad.app.busy.size, 0);
  assert.ok(!fs.existsSync(path.join(bad.cache, 'KK-1.json')));
  const retry = openStream(bad.srv, '/api/generate', { key: 'KK-1', confirm: true });
  await retry.finished;
  assert.equal(retry.events.at(-1).type, 'error'); // a second attempt is not blocked as "busy"
});

test('closing the connection (Cancel) aborts the running call, saves nothing and frees the task', async () => {
  let writing = false;
  let aborted = false;
  const slow = await boot((prompt, opts = {}) => {
    if (!prompt.includes('You are an analyst. Below is the evidence')) return fakeAsk(prompt);
    writing = true;
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted = true; reject(new Aborted()); });
    });
  });
  const s = openStream(slow.srv, '/api/generate', { key: 'KK-1', confirm: true });
  await s.until((e) => e.type === 'stage' && e.id === 'write' && e.status === 'running');
  assert.ok(await wait(() => writing), 'the capsule call started');
  assert.equal(slow.app.busy.has('KK-1'), true);
  s.req.destroy(); // what the Cancel button does: abort the fetch
  assert.ok(await wait(() => aborted), 'the server aborted the running call');
  assert.ok(await wait(() => slow.app.busy.size === 0), 'the task is free again');
  assert.ok(!fs.existsSync(path.join(slow.cache, 'KK-1.json')));
  assert.ok(!fs.existsSync(path.join(slow.cache, 'KK-1.md')));
  assert.equal(slow.app.usageSnapshot().session.calls, 1); // only the finished vote is counted, never the cancelled call
});
