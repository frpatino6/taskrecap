// Regression tests for the code-review findings on the Claude Code detection (each one fails without its fix).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { App, UserError } from '../src/app.js';
import {
  cachedClaude, cachedClaudePath, checkClaude, classifyFailure, cliErrorText, clearClaudeCache, firstErrorLine, knownLocations, sortNodeVersions,
} from '../src/claude.js';
import { parseCli } from '../src/cli.js';
import * as config from '../src/config.js';
import { LLMUnavailable, askLlm, claudeFailed, mapFailure } from '../src/llm.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir, ts } from './helpers.js';

const posix = process.platform !== 'win32';
const fakeBin = (dir, body, name = 'claude') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
};
async function withOverride(value, fn) {
  const before = process.env.TASKRECAP_CLAUDE;
  const beforeOld = process.env.TASKRECAP_CLAUDE_BIN;
  process.env.TASKRECAP_CLAUDE = value;
  delete process.env.TASKRECAP_CLAUDE_BIN;
  clearClaudeCache();
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.TASKRECAP_CLAUDE; else process.env.TASKRECAP_CLAUDE = before;
    if (beforeOld !== undefined) process.env.TASKRECAP_CLAUDE_BIN = beforeOld;
    clearClaudeCache();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const request = (srv, method, route, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: route, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: t ? JSON.parse(t) : {} }); });
  });
  req.on('error', reject);
  req.end(body);
});
const postJson = (srv, route, headers = {}) => request(srv, 'POST', route, { headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

// ---- 1. a failure is classified from what the CLI itself reported, never from loose words ----
test('classifyFailure: a Jira key, a token count or a sentence of the model never means "not logged in"', () => {
  for (const text of ['ABC-401 failed to build', 'used 401 tokens', 'HTTP 401', 'the model said this is unauthorized', 'ENOENT: no such file or directory, open /x/config.json', 'sh: node: not found']) {
    assert.equal(classifyFailure(text), null, text);
  }
  // stdout is read ONLY when it is an `is_error` result of the CLI: a normal answer is model text
  const answer = JSON.stringify({ is_error: false, result: 'ABC-401 is unauthorized (401) and not logged in' });
  assert.equal(classifyFailure({ stderr: '', stdout: answer }), null);
  assert.equal(classifyFailure({ stderr: '', stdout: 'plain model text: please run /login' }), null);
});

test('classifyFailure: still recognises the real messages (stderr, anchored phrases, the OS error code, an is_error result)', () => {
  assert.equal(classifyFailure({ stderr: 'API Error: 401 Unauthorized' }), 'not-logged-in');
  assert.equal(classifyFailure('401 Unauthorized'), 'not-logged-in');
  assert.equal(classifyFailure({ stderr: 'OAuth token has expired. Please run /login' }), 'not-logged-in');
  assert.equal(classifyFailure({ stderr: 'line one\nInvalid API key · Please run /login\nline three' }), 'not-logged-in');
  assert.equal(classifyFailure({ errCode: 'ENOENT' }), 'not-found');
  assert.equal(classifyFailure({ stderr: "claude : The term 'claude' is not recognized as the name of a cmdlet" }), 'not-found');
  assert.equal(classifyFailure({ stderr: '/bin/sh: 1: claude: not found' }), 'not-found');
  const failed = JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' });
  assert.equal(classifyFailure({ stdout: failed }), 'not-logged-in');
  assert.equal(classifyFailure({ stdout: `{"type":"system"}\n${failed}\n` }), 'not-logged-in'); // stream-json: the last result line
  assert.equal(cliErrorText(JSON.stringify({ is_error: false, result: 'fine' })), '');
});

test('claudeFailed keeps the real first error line visible (sanitised) and mapFailure ignores its message', () => {
  const home = process.env.HOME || '/home/x';
  const e = claudeFailed(2, { stderr: `\u001b[31mboom: cannot open ${home}/secret/file\u001b[0m\nsecond line`, stdout: 'ABC-401 401 unauthorized' });
  assert.equal(e.message, 'Claude failed: boom: cannot open ~/secret/file');
  assert.equal(claudeFailed(3, {}).message, 'Claude failed (exit code 3)');
  assert.equal(mapFailure(e), e); // not classified as login/not-found
  assert.equal(firstErrorLine('x'.repeat(500)).length, 200);
  assert.equal(firstErrorLine('a\u0000b\n\nc'), 'a b');
});

test('askLlm: a failing Claude whose stdout mentions 401 / unauthorized is reported with its real error, not as "not logged in"', { skip: !posix }, async () => {
  const file = fakeBin(tmpDir(), "console.log('ABC-401 is unauthorized, 401 tokens'); console.error('disk quota exceeded'); process.exit(1)");
  await withOverride(file, async () => {
    await assert.rejects(() => askLlm('hi'), (e) => !(e instanceof LLMUnavailable) && /^Claude failed: disk quota exceeded$/.test(e.message));
  });
});

test('askLlm: an is_error result on stdout with a login problem still maps to not-logged-in', { skip: !posix }, async () => {
  const file = fakeBin(tmpDir(), "console.log(JSON.stringify({type:'result',is_error:true,result:'Invalid API key · Please run /login'})); process.exit(1)");
  await withOverride(file, async () => {
    await assert.rejects(() => askLlm('hi'), (e) => e instanceof LLMUnavailable && e.code === 'not-logged-in');
  });
});

// ---- 2/3. the status never blocks the page, probes are shared and forced re-checks are throttled ----
test('checkClaude: concurrent callers share ONE probe', async () => {
  clearClaudeCache();
  let runs = 0;
  const opts = { platform: 'linux', env: { PATH: '/bin' }, home: '/h', override: null, isFile: (p) => p === '/bin/claude', readdir: () => [], run: async () => { runs += 1; await sleep(40); return { ok: true, version: '2.0.0', error: null }; } };
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => checkClaude(opts)));
  assert.equal(runs, 1);
  assert.ok(all.every((s) => s.available && s === all[0]));
  clearClaudeCache();
});

test('checkClaude: a forced re-check right after a probe reuses it; after the interval it probes again', async () => {
  clearClaudeCache();
  let runs = 0;
  const opts = { platform: 'linux', env: { PATH: '/bin' }, home: '/h', override: null, isFile: (p) => p === '/bin/claude', readdir: () => [], run: async () => { runs += 1; return { ok: true, version: '2.0.0', error: null }; } };
  await checkClaude(opts);
  for (let i = 0; i < 20; i++) await checkClaude({ ...opts, force: true, minIntervalMs: 5000 });
  assert.equal(runs, 1); // a loop of forced checks cannot start a stream of processes
  await checkClaude({ ...opts, force: true, minIntervalMs: 0 });
  assert.equal(runs, 2);
  clearClaudeCache();
});

test('cachedClaude / cachedClaudePath: nothing before the first check, the answer after, nothing when the override changes', async () => {
  clearClaudeCache();
  const env = { PATH: '/bin' };
  const opts = { platform: 'linux', env, home: '/h', override: null, isFile: (p) => p === '/bin/claude', readdir: () => [], run: async () => ({ ok: true, version: '2.0.0', error: null }) };
  assert.equal(cachedClaude({ platform: 'linux', env, override: null }), null);
  await checkClaude(opts);
  assert.equal(cachedClaude({ platform: 'linux', env, override: null }).fresh, true);
  assert.equal(cachedClaudePath({ platform: 'linux', env, override: null }), '/bin/claude');
  assert.equal(cachedClaude({ platform: 'linux', env, override: '/other/claude' }), null);
  clearClaudeCache();
});

test('App: aiStatusCached answers at once with {checking: true} while a slow `claude --version` runs, then with the result', { skip: !posix }, async () => {
  const tmp = tmpDir();
  const file = fakeBin(tmp, "setTimeout(() => console.log('2.5.0 (Claude Code)'), 600)");
  const app = new App({ projectsDir: path.join(tmp, 'p'), cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json') });
  await withOverride(file, async () => {
    const t0 = Date.now();
    const first = app.aiStatusCached();
    assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0} ms`);
    assert.equal(first.checking, true);
    assert.equal(first.available, null);
    const settled = await app.aiStatus(); // shares the running probe
    assert.equal(settled.available, true);
    assert.equal(app.aiStatusCached().version, '2.5.0');
    assert.equal(app.aiStatusCached().checking, undefined);
  });
});

test('server: /api/info does not wait for Claude; GET /api/ai?force=1 never spawns; POST /api/ai/recheck shares one probe', { skip: !posix }, async () => {
  const tmp = tmpDir();
  const counter = path.join(tmp, 'spawns.txt');
  const file = fakeBin(tmp, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); setTimeout(() => console.log('2.5.0 (Claude Code)'), 700)`);
  const spawns = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);
  const app = new App({ projectsDir: path.join(tmp, 'p'), cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json') });
  const srv = await startServer(app, 0);
  try {
    await withOverride(file, async () => {
      const t0 = Date.now();
      const info = await request(srv, 'GET', '/api/info');
      assert.ok(Date.now() - t0 < 400, `/api/info took ${Date.now() - t0} ms`);
      assert.equal(info.body.ai.checking, true);
      await Promise.all([1, 2, 3, 4].map(() => request(srv, 'GET', '/api/info'))); // concurrent page loads
      await app.aiStatus(); // let the single probe finish
      assert.equal(spawns(), 1); // not one per request
      for (let i = 0; i < 10; i++) await request(srv, 'GET', '/api/ai?force=1'); // `force` on a GET is ignored
      assert.equal(spawns(), 1);
      assert.equal((await request(srv, 'GET', '/api/ai')).body.available, true);
      clearClaudeCache(); // the cache expired: five people press "Check again" at the same moment
      const rechecks = await Promise.all([1, 2, 3, 4, 5].map(() => postJson(srv, '/api/ai/recheck')));
      assert.ok(rechecks.every((r) => r.status === 200 && r.body.available === true));
      assert.equal(spawns(), 2); // one more probe, shared
    });
  } finally {
    srv.server.close();
  }
});

test('server: the re-check is POST only, JSON only and local only', async () => {
  const tmp = tmpDir();
  const app = new App({ projectsDir: path.join(tmp, 'p'), cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json'), ask: async () => '{}' });
  const srv = await startServer(app, 0);
  try {
    assert.equal((await request(srv, 'GET', '/api/ai/recheck')).status, 404);
    assert.equal((await request(srv, 'POST', '/api/ai/recheck', { headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415); // what a cross-site <form> can send
    assert.equal((await postJson(srv, '/api/ai/recheck', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await postJson(srv, '/api/ai/recheck')).status, 200);
  } finally {
    srv.server.close();
  }
});

// ---- 5. nvm versions are compared as numbers ----
test('sortNodeVersions: v22 before v18 before v9, odd names last and harmless', () => {
  assert.deepEqual(sortNodeVersions(['v9.11.2', 'v22.2.0', 'v18.20.1', 'v22.10.0', 'default', 'node']), ['v22.10.0', 'v22.2.0', 'v18.20.1', 'v9.11.2', 'node', 'default']);
  assert.deepEqual(sortNodeVersions(['v20', '20.1.0', 'v20.0.5']), ['20.1.0', 'v20.0.5', 'v20']); // partial or unprefixed versions are tolerated
  assert.deepEqual(sortNodeVersions(undefined), []);
});

test('knownLocations: the newest nvm Node is probed first (a string sort puts v9 first)', () => {
  const nvm = '/home/me/.nvm/versions/node';
  const list = knownLocations({ platform: 'linux', env: {}, home: '/home/me', readdir: (d) => (d === nvm ? ['v9.11.2', 'v18.20.1', 'v22.2.0', 'lts'] : []) });
  const order = list.filter((p) => p.startsWith(nvm));
  assert.deepEqual(order.map((p) => p.split('/')[6]), ['v22.2.0', 'v18.20.1', 'v9.11.2', 'lts']);
});

// ---- 6. an unsafe --model is a user error, not a 500 ----
test('--model with unsafe characters is refused up front with a clean message', () => {
  for (const bad of ['claude opus', 'x&calc', 'a"b', '$(id)']) {
    assert.throws(() => parseCli(['generate', 'ABC-1', '--model', bad]), (e) => e instanceof UserError && /--model/.test(e.message) && /Unsupported model name/.test(e.message), bad);
  }
  assert.equal(parseCli(['generate', 'ABC-1', '--model', 'claude-sonnet-5-5']).opts.model, 'claude-sonnet-5-5');
});

test('askLlm: an unsafe model name rejects with a UserError (HTTP 400 on the server), before anything starts', async () => {
  await assert.rejects(() => askLlm('hi', { model: 'sonnet & calc' }), (e) => e instanceof UserError && /Unsupported model name/.test(e.message));
});

test('server: an unsafe model name during an action is a 400 with the message, not "Request failed" 500', async () => {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'p');
  makeSession(proj, 'AAAAAAAA-1', [[ts(0), 'KK-1 fix', 'ok']]);
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json'), votes: 1, model: 'claude opus' });
  const srv = await startServer(app, 0);
  try {
    const r = await request(srv, 'POST', '/api/generate', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'KK-1', confirm: true }) });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unsupported model name/);
    assert.doesNotMatch(r.body.error, /Request failed/);
  } finally {
    srv.server.close();
  }
});

// ---- extras: askLlm reuses the last check; the old bare-'claude' resolver is gone ----
test('askLlm uses the location remembered by the last check, and forgets it when the program cannot be started', { skip: !posix }, async () => {
  const dir = tmpDir();
  const file = fakeBin(dir, "console.log('2.0.0')");
  await withOverride(file, async () => {
    assert.equal((await checkClaude()).available, true);
    fs.rmSync(file); // the file is gone, but the cache still says where it was
    await assert.rejects(() => askLlm('hi'), (e) => e instanceof LLMUnavailable && e.code === 'not-working'); // it tried the remembered path (no new PATH walk)
    await assert.rejects(() => askLlm('hi'), (e) => e instanceof LLMUnavailable && e.code === 'override-not-found'); // the cache was dropped: it looks again
  });
});

test('config.claudeBin is gone: locateClaude is the only way to find Claude', () => {
  assert.equal(config.claudeBin, undefined);
});
