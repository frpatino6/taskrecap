import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { App, DEMO_DIR } from '../src/app.js';
import { js } from './web_assets.js';
import { seedDemoCache } from '../src/cli.js';
import { citeTimestamp, turnTimestamps, withRowTimes } from '../src/evidence.js';
import { startServer } from '../src/server.js';
import { makeSession, tmpDir } from './helpers.js';

const T0 = '2026-09-07T14:32:00.000Z';
const T1 = '2026-09-07T15:10:00.000Z';
const T2 = '2026-09-08T09:05:00.000Z';

let tmp;
let proj;
let files;
let app;
let srv;

before(async () => {
  tmp = tmpDir();
  proj = path.join(tmp, 'projects');
  makeSession(proj, 'aaaaaaaa-0001', [[T0, 'KK-3 first', 'ok'], [T1, 'KK-3 second', 'ok'], [T2, 'KK-3 third', 'ok']], { branch: 'fix/KK-3' });
  makeSession(proj, 'dupe0001-aaaa', [[T0, 'one', 'ok']], { proj: 'p2' });
  makeSession(proj, 'dupe0001-bbbb', [[T0, 'two', 'ok']], { proj: 'p3' });
  makeSession(proj, 'nostamp1-0001', [[undefined, 'KK-4 no timestamp', 'ok'], ['not-a-date', 'KK-4 garbage timestamp', 'ok']], { proj: 'p4' });
  app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), votes: 1, usageFile: path.join(tmp, 'usage.json'), ask: async () => { throw new Error('free endpoints must never call the LLM'); } });
  files = app.index.listFiles();
  srv = await startServer(app, 0);
});

after(() => srv.server.close());

function get(route) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: route }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')]));
    }).on('error', reject);
  });
}

test('the time of a row is that of the FIRST cite listed, not the earliest or the last', () => {
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: 1 }, { session: 'aaaaaaaa', turn: 0 }], files), T1);
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: 2 }], files), T2);
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: '0' }], files), T0, 'a numeric string is still a turn number');
});

test('an unresolvable first cite falls through to the next one that can be located', () => {
  const cites = [{ session: 'gone0000', turn: 0 }, { session: 'aaaaaaaa', turn: 99 }, { session: 'aaaaaaaa', turn: 1 }];
  assert.equal(citeTimestamp(cites, files), T1);
});

test('no resolvable cite means no time: it is never invented', () => {
  assert.equal(citeTimestamp([], files), null);
  assert.equal(citeTimestamp(undefined, files), null);
  assert.equal(citeTimestamp('aaaaaaaa:0', files), null, 'cites that are not an array');
  assert.equal(citeTimestamp([{ session: 'gone0000', turn: 0 }], files), null, 'the session file no longer exists');
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: 3 }], files), null, 'turn past the end of the session');
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: -1 }], files), null);
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: 1.5 }], files), null);
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa', turn: null }], files), null, 'null must not mean turn 0');
  assert.equal(citeTimestamp([{ session: 'aaaaaaaa' }], files), null);
  assert.equal(citeTimestamp([{ session: 'dupe0001', turn: 0 }], files), null, 'two sessions share this prefix, so it cannot be matched safely');
  assert.equal(citeTimestamp([{ session: '', turn: 0 }], files), null);
  assert.equal(citeTimestamp([null, 7, { turn: 0 }], files), null, 'junk entries are skipped, not thrown on');
});

test('a message without a usable timestamp gives no time', () => {
  assert.equal(citeTimestamp([{ session: 'nostamp1', turn: 0 }], files), null, 'missing timestamp');
  assert.equal(citeTimestamp([{ session: 'nostamp1', turn: 1 }], files), null, 'unparseable timestamp');
  assert.deepEqual(turnTimestamps(files.find((f) => f.includes('nostamp1'))), [null, null]);
});

test('withRowTimes adds ts to the rows it can place and leaves the input and the other fields alone', () => {
  const input = [
    { date: '09-07', repo: 'shop', result: 'a', cites: [{ session: 'aaaaaaaa', turn: 0 }] },
    { date: '09-08', repo: 'shop', result: 'b', cites: [] },
    { date: '09-09', repo: 'shop', result: 'c' },
  ];
  const snapshot = JSON.stringify(input);
  const out = withRowTimes(input, files);
  assert.equal(JSON.stringify(input), snapshot, 'the stored capsule must not be mutated');
  assert.equal(out[0].ts, T0);
  assert.equal(out[0].date, '09-07');
  assert.equal(out[0].result, 'a');
  assert.ok(!('ts' in out[1]) && !('ts' in out[2]), 'rows without a located cite get no ts');
  assert.deepEqual(withRowTimes(undefined, files), []);
});

test('a ts already stored in a row is never shown: no resolvable cite -> no time; a resolvable cite -> the time of that message', () => {
  const INVENTED = '2020-01-01T00:00:00.000Z';
  const input = [
    { date: '09-07', repo: 'shop', result: 'unplaceable', cites: [{ session: 'gone0000', turn: 0 }], ts: INVENTED },
    { date: '09-08', repo: 'shop', result: 'no cites at all', ts: INVENTED },
    { date: '09-09', repo: 'shop', result: 'placeable', cites: [{ session: 'aaaaaaaa', turn: 2 }], ts: INVENTED },
  ];
  const snapshot = JSON.stringify(input);
  const out = withRowTimes(input, files);
  assert.equal(JSON.stringify(input), snapshot, 'the input rows are not mutated');
  assert.ok(!('ts' in out[0]) && !('ts' in out[1]), 'a stored ts must be dropped when no cite resolves');
  assert.equal(out[2].ts, T2, 'the time comes from the cited message, not from the stored value');
  assert.deepEqual(out.map((r) => r.date), ['09-07', '09-08', '09-09']);
  assert.deepEqual(out.map((r) => r.result), ['unplaceable', 'no cites at all', 'placeable']);
});

test('GET /api/tasks/<key> never returns a stored ts for a row whose cites do not resolve, and leaves the stored file untouched', async () => {
  const stored = {
    key: 'KK-6',
    capsule: {
      objective: 'x', decisions: [], dead_ends: [], left_out: [], pending: [], briefing: '',
      timeline: [
        { date: '09-07', repo: 'shop', result: 'hallucinated time', cites: [{ session: 'gone0000', turn: 0 }], ts: '2020-01-01T00:00:00.000Z' },
        { date: '09-08', repo: 'shop', result: 'real time', cites: [{ session: 'aaaaaaaa', turn: 1 }], ts: '2020-01-01T00:00:00.000Z' },
      ],
    },
    files: [], commits: { confirmed: [], possible: [] }, markdown: '',
  };
  app.store.save('KK-6', stored);
  const file = path.join(tmp, 'cache', 'KK-6.json');
  const before = fs.readFileSync(file, 'utf8');
  const [status, body] = await get('/api/tasks/KK-6');
  assert.equal(status, 200);
  const rows = body.capsule.capsule.timeline;
  assert.deepEqual(rows.map((r) => r.ts || null), [null, T1]);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the stored capsule file is not rewritten');
});

test('timestamps are re-read when the session file changes', () => {
  const dir = tmpDir();
  const f = makeSession(dir, 'cccccccc-0001', [[T0, 'KK-5 one', 'ok']]);
  assert.deepEqual(turnTimestamps(f), [T0]);
  fs.appendFileSync(f, JSON.stringify({ type: 'user', timestamp: T2, gitBranch: 'main', cwd: '/x/app', message: { content: 'KK-5 two' } }) + '\n');
  assert.deepEqual(turnTimestamps(f), [T0, T2]);
});

test('GET /api/tasks/<key> returns each timeline row with its time, and the stored capsule keeps no ts', async () => {
  const stored = {
    key: 'KK-3',
    capsule: {
      objective: 'Fix it', decisions: [], dead_ends: [], left_out: [], pending: [], briefing: '',
      timeline: [
        { date: '09-07', repo: 'shop', result: 'start', cites: [{ session: 'aaaaaaaa', turn: 0 }] },
        { date: '09-08', repo: 'shop', result: 'finish', cites: [{ session: 'aaaaaaaa', turn: 2 }, { session: 'aaaaaaaa', turn: 1 }] },
        { date: '09-09', repo: 'shop', result: 'unplaceable', cites: [{ session: 'gone0000', turn: 0 }] },
      ],
    },
    files: [], commits: { confirmed: [], possible: [] }, markdown: '',
  };
  app.store.save('KK-3', stored);
  const [status, body] = await get('/api/tasks/KK-3');
  assert.equal(status, 200);
  const rows = body.capsule.capsule.timeline;
  assert.deepEqual(rows.map((r) => r.ts || null), [T0, T2, null]);
  assert.deepEqual(rows.map((r) => r.date), ['09-07', '09-08', '09-09'], 'rows keep their stored date and order');
  assert.ok(!JSON.stringify(app.store.load('KK-3')).includes('"ts"'), 'the stored capsule is untouched');
  assert.ok(!fs.readFileSync(path.join(tmp, 'cache', 'KK-3.json'), 'utf8').includes('"ts"'));
});

test('every demo capsule row that cites a message gets a time on the same UTC day as its stored date', () => {
  const cacheDir = tmpDir();
  seedDemoCache(path.join(DEMO_DIR, 'capsules'), cacheDir);
  const demo = new App({ projectsDir: path.join(DEMO_DIR, 'sessions'), cacheDir, demo: true });
  let rows = 0;
  for (const t of demo.listTasks().filter((x) => x.has_capsule)) {
    for (const row of demo.taskDetail(t.key).capsule.capsule.timeline) {
      rows += 1;
      assert.ok(row.ts, `${t.key}: row "${row.date}" should get a time`);
      assert.equal(row.ts.slice(5, 10), row.date, `${t.key}: the time must come from a message of the row's own day`);
    }
  }
  assert.ok(rows >= 18, 'the demo has enough rows to make this meaningful');
});

// ---- the browser formatter (the real function, lifted from web/js) ----

const html = js;
const pad = html.match(/const pad2 = [^\n]+/)[0];
const fn = html.match(/function whenLabel\(ts\) \{[\s\S]*?\n\}/)[0];
/** Runs the shipped function with TZ set to `tz` for just this call (a fresh Function, so no zone is cached across zones). */
const label = (tz, ts) => {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return new Function(`${pad}\n${fn}\nreturn whenLabel(${JSON.stringify(ts)});`)();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};

test('browser formatter: 24 h local time MM-DD HH:MM', () => {
  assert.equal(label('UTC', '2026-09-07T14:32:00.000Z'), '09-07 14:32');
  assert.equal(label('UTC', '2026-01-02T03:04:00Z'), '01-02 03:04', 'zero padded');
  assert.equal(label('Asia/Kolkata', '2026-09-07T14:32:00Z'), '09-07 20:02', 'a half-hour zone');
  assert.equal(label('America/Bogota', '2026-09-07T14:32:00Z'), '09-07 09:32');
  assert.equal(label('UTC', '2026-09-07T23:59:59Z'), '09-07 23:59');
});

test('browser formatter: the local date moves with the zone around midnight', () => {
  assert.equal(label('America/Bogota', '2026-09-08T02:00:00Z'), '09-07 21:00', 'still the previous evening in Colombia');
  assert.equal(label('Pacific/Auckland', '2026-09-07T11:59:00Z'), '09-07 23:59');
  assert.equal(label('Pacific/Auckland', '2026-09-07T12:00:00Z'), '09-08 00:00', 'midnight shows as 00:00, never 24:00');
  assert.equal(label('UTC', '2026-12-31T23:59:00Z'), '12-31 23:59');
  assert.equal(label('Asia/Tokyo', '2026-12-31T15:00:00Z'), '01-01 00:00', 'across New Year');
});

test('browser formatter: daylight saving jumps are respected', () => {
  assert.equal(label('America/New_York', '2026-03-08T06:59:00Z'), '03-08 01:59', 'last minute before the spring jump');
  assert.equal(label('America/New_York', '2026-03-08T07:00:00Z'), '03-08 03:00', '02:00-02:59 does not exist that night');
  assert.equal(label('America/New_York', '2026-11-01T05:30:00Z'), '11-01 01:30', 'first 01:30 of the fall repeat (EDT)');
  assert.equal(label('America/New_York', '2026-11-01T06:30:00Z'), '11-01 01:30', 'second 01:30 (EST)');
});

test('browser formatter: no usable time gives null, so the cell falls back to the stored date', () => {
  for (const bad of [null, undefined, '', 'garbage', '2026-13-45T99:99:99Z']) assert.equal(label('UTC', bad), null, String(bad));
});
