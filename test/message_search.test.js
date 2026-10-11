import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { App, DEMO_DIR } from '../src/app.js';
import { seedDemoCache } from '../src/cli.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir, ts } from './helpers.js';

function makeApp() {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  // one session cites a task key and has many matching messages; another has a single match
  makeSession(proj, 'AAAAAAAA-1111', [1, 2, 3, 4, 5].map((i) => [ts(i), `KK-1 work item ${i}`, `the zebracrossing logic ${i} is done`]));
  makeSession(proj, 'BBBBBBBB-2222', [[ts(0), 'unrelated', 'zebracrossing appears here once']], { proj: 'other', branch: 'main' });
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: path.join(tmp, 'usage.json') });
  return { app, tmp };
}

function get(srv, route, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')]));
    }).on('error', reject);
  });
}

test('searchMessages: finds text inside messages, ties the hit to its unit, caps hits per session', async () => {
  const { app } = makeApp();
  const r = await app.searchMessages('zebracrossing');
  assert.equal(r.index.state, 'ready');
  const bySession = (id) => r.messages.filter((m) => m.session.startsWith(id));
  assert.equal(bySession('AAAAAAAA').length, 3, 'at most 3 shown from one session');
  assert.equal(bySession('BBBBBBBB').length, 1);
  const m = bySession('AAAAAAAA')[0];
  assert.equal(m.key, 'KK-1');
  assert.equal(m.id8, 'AAAAAAAA');
  assert.equal(typeof m.turn, 'number');
  assert.ok(m.snippet.excerpt.includes('zebracrossing') && m.snippet.highlights.length);
  assert.equal(bySession('BBBBBBBB')[0].project, 'app');
});

test('searchMessages: the count of what the cap left out is on the last shown hit of the session', async () => {
  const { app } = makeApp();
  const { messages } = await app.searchMessages('zebracrossing');
  const mine = messages.filter((m) => m.session.startsWith('AAAAAAAA'));
  assert.deepEqual(mine.map((m) => m.more), [0, 0, 2]); // 5 matching messages, 3 shown
});

test('searchMessages: hyphens and digits like "KK-1" find the message with both words', async () => {
  const { app } = makeApp();
  const { messages } = await app.searchMessages('KK-1');
  assert.ok(messages.length >= 1 && messages.every((m) => m.session.startsWith('AAAAAAAA')));
});

test('searchMessages: new messages show up without a restart; an empty query finds nothing', async () => {
  const { app, tmp } = makeApp();
  assert.deepEqual((await app.searchMessages('  ')).messages, []);
  assert.equal((await app.searchMessages('quokka')).messages.length, 0);
  makeSession(path.join(tmp, 'projects'), 'CCCCCCCC-3333', [[ts(0), 'a quokka walks in', 'ok']], { proj: 'other', branch: 'main' });
  assert.equal((await app.searchMessages('quokka')).messages.length, 1);
});

test('a failing index never breaks the app: state error, normal search and unit listing still work', async () => {
  const { app } = makeApp();
  app.textIndex.update = async () => { throw new Error('disk on fire'); };
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  let r;
  try {
    r = await app.searchMessages('zebracrossing');
    await app.searchMessages('zebracrossing');
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(r.index.state, 'error');
  assert.deepEqual(r.messages, []);
  assert.equal(lines.filter((l) => l.includes('disk on fire')).length, 1, 'logged once');
  assert.ok(app.search('KK-1').length >= 1, 'task search is untouched');
});

test('a search that throws inside the index is caught too', async () => {
  const { app } = makeApp();
  await app.startIndexing();
  app.textIndex.search = () => { throw new Error('bad shard'); };
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const r = await app.searchMessages('zebracrossing');
    assert.deepEqual(r.messages, []);
    assert.equal(r.index.state, 'error');
  } finally {
    process.stderr.write = orig;
  }
});

test('startIndexing is non-blocking, reports progress and runs once', async () => {
  const { app } = makeApp();
  const p = app.startIndexing();
  assert.equal(app.indexStatus.state, 'building');
  assert.equal(app.startIndexing(), p);
  await p;
  assert.deepEqual(app.indexStatus, { state: 'ready', done: 2, total: 2 });
});

test('GET /api/search keeps hits and searched, adds messages and index; same host protection', async () => {
  const { app } = makeApp();
  const srv = await startServer(app, 0);
  try {
    const [status, body] = await get(srv, '/api/search?q=KK-1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.hits) && body.hits.some((h) => h.key === 'KK-1'));
    assert.ok('searched' in body);
    assert.ok(body.messages.length >= 1);
    assert.deepEqual(Object.keys(body.messages[0]).sort(), ['id8', 'key', 'kind', 'label', 'more', 'project', 'role', 'session', 'snippet', 'ts', 'turn']);
    assert.equal(body.index.state, 'ready');
    const [, none] = await get(srv, '/api/search?q=');
    assert.equal(none.hits, null);
    assert.deepEqual(none.messages, []);
    assert.equal((await get(srv, '/api/search?q=KK-1', { Host: 'evil.example' }))[0], 403);
    // the hit opens that exact message in the evidence panel
    const hit = (await get(srv, '/api/search?q=zebracrossing')) [1].messages[0];
    const [es, ev] = await get(srv, `/api/evidence?session=${hit.session}&turn=${hit.turn}&context=0`);
    assert.equal(es, 200);
    assert.ok(ev.turns.some((t) => t.turn === hit.turn && /zebracrossing/.test(t.assistant + t.user)));
  } finally {
    srv.server.close();
  }
});

test('demo: a word that only appears inside a message finds it', async () => {
  const cache = tmpDir();
  seedDemoCache(path.join(DEMO_DIR, 'capsules'), cache);
  const app = new App({ projectsDir: path.join(DEMO_DIR, 'sessions'), cacheDir: cache, demo: true });
  const { messages } = await app.searchMessages('tombstone');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id8, 'a7b8c9d0');
  assert.equal(messages[0].key, 'SHOP-104');
  assert.deepEqual(app.search('tombstone'), [], 'a word only inside a message is not a task hit');
});
