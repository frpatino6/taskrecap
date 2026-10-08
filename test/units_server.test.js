import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App } from '../src/app.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir } from './helpers.js';

const at = (h, m = 0, d = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
let srv;
let tmp;
let calls = 0;

before(async () => {
  tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[at(9), 'KK-1 fix the rounding bug', 'ok'], [at(10), 'KK-1 more work on the fix', 'ok']], { branch: 'fix/KK-1-x' });
  makeSession(proj, 'BBBBBBBB-2222', [[at(11), 'Investigate why the orders endpoint fails on empty carts', 'ok']], { branch: 'main', proj: 'p2', cwd: '/x/api' });
  makeSession(proj, 'CCCCCCCC-3333', [[at(12), 'hola', 'ok']], { branch: 'main', proj: 'p3', cwd: '/x/docs' });
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: path.join(tmp, 'usage.json'), ask: async () => { calls += 1; throw new Error('corrections never call the LLM'); } });
  srv = await startServer(app, 0);
});
after(() => srv.server.close());

function call(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: route, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let j = {}; try { j = JSON.parse(t); } catch { /* not JSON */ } resolve([res.statusCode, j]); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const tasks = async (q = '') => (await call('GET', '/api/tasks' + q))[1].tasks;

test('the corrections endpoints reject other origins, other hosts and non-JSON requests', async () => {
  const body = { key: 'KK-1', label: 'x' };
  assert.equal((await call('POST', '/api/units/rename', body, { Origin: 'http://evil.example' }))[0], 403);
  assert.equal((await call('POST', '/api/units/rename', body, { Host: 'evil.example' }))[0], 403);
  assert.equal((await call('POST', '/api/units/rename', 'key=KK-1&label=x', { 'Content-Type': 'application/x-www-form-urlencoded' }))[0], 415);
  assert.equal((await call('POST', '/api/units/nope', {}))[0], 404);
  assert.equal((await call('POST', '/api/units/rename', '{ bad json'))[0], 400);
  assert.equal((await call('GET', '/api/units/rename'))[0], 404, 'a correction is never a GET');
  assert.equal((await tasks()).find((t) => t.key === 'KK-1').renamed, false, 'nothing changed');
});

test('rename / merge / move / hide / split / undo work through the API, with clear errors', async () => {
  let [s, r] = await call('POST', '/api/units/rename', { key: 'KK-1', label: 'Rounding bug' });
  assert.equal(s, 200);
  assert.equal(r.ok, true);
  assert.equal(r.undo.type, 'rename');
  assert.equal((await tasks()).find((t) => t.key === 'KK-1').label, 'Rounding bug');

  [s, r] = await call('POST', '/api/units/rename', { key: 'NOPE-1', label: 'x' });
  assert.equal(s, 400);
  assert.match(r.error, /does not exist/);

  [s, r] = await call('POST', '/api/units/merge', { keys: ['session:BBBBBBBB', 'session:CCCCCCCC'], label: 'Mine' });
  assert.equal(s, 200);
  const group = r.unit;
  assert.match(group, /^user:/);
  let t = await tasks();
  assert.ok(t.some((x) => x.key === group && x.can_split && x.label === 'Mine'));
  assert.equal((await call('GET', `/api/tasks/${encodeURIComponent(group)}`))[1].sessions.length, 2, 'the unit page works for a group');

  [s, r] = await call('POST', '/api/units/merge', { keys: ['KK-1'] });
  assert.equal(s, 400);
  assert.match(r.error, /at least two/);

  [s, r] = await call('POST', '/api/units/move', { session: 'BBBBBBBB', to: 'KK-1' });
  assert.equal(s, 200);
  t = await tasks();
  assert.equal(t.find((x) => x.key === 'KK-1').sessions, 2);
  assert.equal(t.find((x) => x.key === group).sessions, 1);

  [s, r] = await call('POST', '/api/units/hide', { key: 'KK-1' });
  assert.equal(s, 200);
  assert.ok(!(await tasks()).some((x) => x.key === 'KK-1'));
  assert.ok((await tasks('?hidden=1')).some((x) => x.key === 'KK-1'));
  assert.deepEqual((await call('GET', '/api/units/hidden'))[1].units.map((u) => u.key), ['KK-1']);
  [s, r] = await call('POST', '/api/units/hide', { key: 'KK-1', hidden: false });
  assert.equal(s, 200);
  assert.ok((await tasks()).some((x) => x.key === 'KK-1'));

  [s, r] = await call('POST', '/api/units/split', { key: 'KK-1' });
  assert.equal(s, 400);
  assert.match(r.error, /Only groups you made/);

  [s, r] = await call('POST', '/api/units/hide', { session: 'AAAAAAAA' });
  assert.equal(s, 200);
  assert.equal((await call('GET', '/api/units/hidden'))[1].sessions.length, 1);

  [s] = await call('POST', '/api/units/split', { key: group });
  assert.equal(s, 200);
  assert.ok(!(await tasks()).some((x) => x.key === group));

  const hist = (await call('GET', '/api/units/history'))[1];
  assert.equal(hist.last.type, 'split');
  assert.ok(hist.count > 3);
  // undo everything, newest first: the page is back to its automatic state
  for (let i = 0; i < 20; i++) {
    const [us] = await call('POST', '/api/units/undo', {});
    if (us !== 200) { assert.equal(us, 400); break; }
  }
  t = await tasks();
  assert.deepEqual(t.map((x) => x.key).sort(), ['KK-1', 'session:BBBBBBBB', 'session:CCCCCCCC']);
  assert.equal(t.find((x) => x.key === 'KK-1').renamed, false);
  [s, r] = await call('POST', '/api/units/undo', {});
  assert.equal(s, 400);
  assert.match(r.error, /Nothing to undo/);
  assert.equal(calls, 0, 'not one correction called the LLM');
});

test('noise is flagged on the list and left out of the timeline lanes, which count it apart', async () => {
  const t = await tasks();
  const loose = t.find((x) => x.key === 'session:CCCCCCCC');
  assert.equal(loose.noise, true);
  assert.equal(t.find((x) => x.key === 'session:BBBBBBBB').noise, false);
  const [, tl] = await call('GET', '/api/timeline');
  assert.ok(!tl.lanes.some((l) => l.key === 'session:CCCCCCCC'));
  assert.equal(tl.empty_total, 1);
  assert.ok(tl.lanes.some((l) => l.key === 'session:BBBBBBBB' && l.unsorted));
});

test('the page assets include the units script and every API string it needs exists in English and Spanish', async () => {
  const [s] = await call('GET', '/js/units.js');
  assert.equal(s, 200);
  const en = (await call('GET', '/api/strings?lang=en'))[1];
  const es = (await call('GET', '/api/strings?lang=es'))[1];
  for (const k of ['menu_rename', 'menu_merge', 'menu_move', 'menu_hide', 'menu_undo', 'merge_confirm', 'hide_text', 'empty_group_title', 'unit_fallback_session', 'related_tip']) {
    assert.ok(en[k] && es[k] && en[k] !== es[k], k);
  }
});
