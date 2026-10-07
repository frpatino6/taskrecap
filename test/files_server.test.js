import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App, loadStrings } from '../src/app.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir, ts } from './helpers.js';

let srv;
let app;
let tmp;

const edit = (file) => ['Edit', { file_path: file }, 'ok'];

before(async () => {
  tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 fix the rounding', 'ok', [edit('/x/shop/src/cart.js')]], [ts(1), 'KK-1 more', 'ok', [edit('/x/shop/src/pay.js')]]], { branch: 'fix/KK-1', cwd: '/x/shop' });
  makeSession(proj, 'BBBBBBBB-2222', [[ts(5), 'KK-2 coupons', 'ok', [edit('/x/shop/src/cart.js')]]], { branch: 'fix/KK-2', cwd: '/x/shop', proj: 'p2' });
  app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), votes: 1, usageFile: path.join(tmp, 'usage.json'), ask: async () => { throw new Error('free endpoints must never call the LLM'); } });
  app.store.save('KK-1', {
    key: 'KK-1', capsule: { objective: 'Fix the rounding bug', decisions: [{ decision: 'Use integer cents', why: 'floats drift', cites: [] }], timeline: [], dead_ends: [], left_out: [], pending: [], briefing: '' },
    files: [{ short: 'shop/src/cart.js', status: 'final', edits: 1, last: ts(0) }], commits: { confirmed: [], possible: [] }, markdown: '',
  });
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

test('/api/search ranks hits, says where they matched, and reports what it could look inside', async () => {
  const [status, body] = await get('/api/search?q=' + encodeURIComponent('INTEGER cents'));
  assert.equal(status, 200);
  assert.equal(body.hits.length, 1);
  const h = body.hits[0];
  assert.deepEqual([h.key, h.where, h.section], ['KK-1', 'capsule', 'decisions']);
  assert.ok(h.highlights.length > 0 && h.excerpt.includes('integer cents'));
  assert.deepEqual(body.searched, { capsules: 1, other_tasks: 1 });
  assert.deepEqual((await get('/api/search?q=coupons'))[1].hits.map((x) => [x.key, x.where]), [['KK-2', 'task']]); // no capsule: first prompt only
  assert.deepEqual((await get('/api/search?q=zzz'))[1].hits, []);
  assert.equal((await get('/api/search?q='))[1].hits, null);
});

test('/api/files/tasks lists the other tasks that touched a file, flagging approximate links', async () => {
  const [status, body] = await get('/api/files/tasks?path=' + encodeURIComponent('shop/src/cart.js'));
  assert.equal(status, 200);
  assert.deepEqual(body.tasks.map((t) => [t.key, t.approximate, t.basis, t.status]), [['KK-1', false, 'capsule', 'final'], ['KK-2', true, 'session', 'edited']]);
  assert.ok(body.tasks[0].text.includes('Fix the rounding'));
  assert.equal(body.tasks[1].has_capsule, false);
  assert.deepEqual((await get('/api/files/tasks?path=nope'))[1].tasks, []);
});

test('/api/files finds files by path fragment, and with no query lists the most shared ones', async () => {
  const [, found] = await get('/api/files?q=cart');
  assert.deepEqual(found.files.map((f) => f.path), ['shop/src/cart.js']);
  assert.deepEqual(found.files[0].tasks.map((t) => t.key).sort(), ['KK-1', 'KK-2']);
  const [, top] = await get('/api/files');
  assert.equal(top.files[0].path, 'shop/src/cart.js');
  assert.equal(top.total, 1); // pay.js belongs to KK-1, whose capsule does not list it
});

test('the file index is persisted outside the capsule files', async () => {
  await get('/api/files');
  assert.ok(fs.existsSync(path.join(tmp, 'cache', '.index', 'files.json')));
  assert.deepEqual(app.store.keys(), new Set(['KK-1']));
});

test('the new endpoints keep the local-only protections', async () => {
  assert.equal((await get('/api/files', { Origin: 'https://evil.example' }))[0], 403);
  assert.equal((await get('/api/search?q=a', { Host: 'evil.example' }))[0], 403);
});

test('every string the new UI uses exists', () => {
  const S = loadStrings();
  for (const k of ['search_found_in', 'search_scope', 'search_scope_all', 'search_scope_none', 'search_none_hint', 'search_none_ai', 'search_hit_task',
    'files_hint', 'files_other_title', 'files_none_other', 'files_status_final', 'files_status_reverted', 'files_status_edited', 'files_badge_approx',
    'files_badge_capsule', 'files_basis_capsule', 'files_basis_session', 'files_basis_mention', 'files_incomplete_note', 'files_find_title', 'files_find_top',
    'files_find_results', 'files_find_none', 'objective', 'decisions', 'files', 'commits', 'dead_ends', 'pending', 'left_out', 'timeline', 'briefing']) {
    assert.ok(S[k], k);
  }
});
