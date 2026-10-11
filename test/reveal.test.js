import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App } from '../src/app.js';
import { nearestExisting, revealCommand, revealFile, sessionFileList } from '../src/reveal.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir, ts } from './helpers.js';

let srv;
let app;
let tmp;
const write = (f) => ['Write', { file_path: f }, 'ok'];
const edit = (f) => ['Edit', { file_path: f }, 'ok'];

before(async () => {
  tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 build it', 'ok', [write('/x/shop/src/new.js'), edit('/x/shop/src/old.js'), edit('/x/shop/src/new.js'), write('/tmp/scratch.txt')]]], { branch: 'fix/KK-1', cwd: '/x/shop' });
  app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), votes: 1, usageFile: path.join(tmp, 'usage.json'), ask: async () => { throw new Error('no LLM'); } });
  srv = await startServer(app, 0);
});
after(() => srv.server.close());

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: route, method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')]));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('sessionFileList: created first, then edited, scratch files left out', () => {
  const turns = [{ cwd: '/x/shop', files: ['/x/shop/src/new.js', '/x/shop/src/old.js', '/tmp/scratch.txt', 'rel.js'], written: ['/x/shop/src/new.js', '/tmp/scratch.txt'] }, { cwd: '/x/shop', files: ['/x/shop/src/new.js'], written: [] }];
  const list = sessionFileList(turns);
  assert.deepEqual(list.map((f) => [f.path, f.kind]), [['/x/shop/src/new.js', 'created'], ['/x/shop/src/old.js', 'edited']]);
  assert.equal(list[0].short, 'shop/src/new.js');
  assert.equal(sessionFileList(turns, 1).length, 1);
});

test('revealCommand: argument arrays per platform, no shell string', () => {
  assert.deepEqual(revealCommand('darwin', '/a/b c.js', true), ['open', ['-R', '/a/b c.js']]);
  assert.deepEqual(revealCommand('darwin', '/a', false), ['open', ['/a']]);
  assert.deepEqual(revealCommand('win32', 'C:\\a\\b.js', true), ['explorer.exe', ['/select,C:\\a\\b.js']]);
  assert.deepEqual(revealCommand('linux', '/a/b.js', true), ['xdg-open', ['/a']]);
  assert.deepEqual(revealCommand('linux', '/a', false), ['xdg-open', ['/a']]);
});

test('revealFile: uses the file, else the nearest existing parent, never throws', async () => {
  const calls = [];
  const spawn = async (c, a) => { calls.push([c, a]); };
  assert.deepEqual(await revealFile('/a/b/c.js', { platform: 'darwin', spawn, exists: (p) => p === '/a/b/c.js' }), { ok: true, opened: '/a/b/c.js' });
  assert.deepEqual(calls[0], ['open', ['-R', '/a/b/c.js']]);
  const r = await revealFile('/a/b/c.js', { platform: 'darwin', spawn, exists: (p) => p === '/a' });
  assert.equal(r.opened, '/a');
  assert.deepEqual(calls[1], ['open', ['/a']]);
  assert.equal((await revealFile('/a/b', { spawn, exists: () => false })).ok, false);
  const bad = await revealFile('/a', { platform: 'linux', spawn: async () => { throw new Error('boom'); }, exists: () => true });
  assert.equal(bad.ok, false);
  assert.deepEqual(nearestExisting('/a/b', (p) => p === '/'), { target: '/', isFile: false });
  assert.equal(nearestExisting('/a/b', () => false), null);
});

test('POST /api/reveal: only files the session recorded; JSON and origin enforced', async () => {
  const seen = [];
  const real = app.revealSessionFile.bind(app);
  app.revealSessionFile = (a) => real(a, { spawn: async (c, x) => { seen.push([c, x]); }, exists: () => true, platform: 'linux' });
  try {
    const ok = await request('POST', '/api/reveal', { session: 'AAAAAAAA', path: '/x/shop/src/new.js' });
    assert.equal(ok[0], 200);
    assert.deepEqual(seen, [['xdg-open', ['/x/shop/src']]]);
    for (const p of ['/etc/passwd', '/tmp/scratch.txt', '/x/shop/src/../../../etc/passwd', '/x/shop', '', null, 5]) {
      const [code] = await request('POST', '/api/reveal', { session: 'AAAAAAAA', path: p });
      assert.equal(code, 400, String(p));
    }
    assert.equal((await request('POST', '/api/reveal', { session: 'ZZZZZZZZ', path: '/x/shop/src/new.js' }))[0], 404);
    assert.equal((await request('POST', '/api/reveal', { session: 'AAAAAAAA', path: '/x/shop/src/new.js' }, { Origin: 'http://evil.example' }))[0], 403);
    assert.equal((await request('POST', '/api/reveal', undefined))[0], 415);
    assert.equal((await request('GET', '/api/reveal'))[0], 404);
    assert.equal(seen.length, 1);
  } finally {
    app.revealSessionFile = real;
  }
});

test('evidence carries the session files list', async () => {
  const r = app.evidence({ session: 'AAAAAAAA', turn: 0, context: 0 });
  assert.deepEqual(r.session.made.map((f) => f.kind), ['created', 'edited']);
});
