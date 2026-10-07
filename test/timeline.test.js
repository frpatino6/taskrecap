import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.js';
import { parseSession, promptDays, localDay } from '../src/sessions.js';
import { startServer, timelineOptions } from '../src/server.js';
import { SessionIndex, taskActivity } from '../src/tasks.js';
import {
  MARK_MAX, MARK_MIN, MAX_REPO_COLORS, MIN_SPAN_DAYS, buildTimeline, dayFromNumber, dayNumber, markSize, pickTicks, primaryRepo, repoSlots, xPercent,
} from '../src/timeline.js';
import { makeSession, tmpDir } from './helpers.js';

/** Local noon of a calendar day: the same local day in every time zone, so these tests do not depend on where they run. */
const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour, 0).toISOString();
const d = (month, day) => `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

test('localDay is the local calendar day and ignores unusable timestamps', () => {
  assert.equal(localDay(at(9, 7)), '2026-09-07');
  assert.equal(localDay(at(9, 7, 0)), '2026-09-07');
  assert.equal(localDay(at(9, 7, 23)), '2026-09-07');
  assert.equal(localDay(undefined), null);
  assert.equal(localDay('not a date'), null);
});

test('promptDays counts real prompts per day and, per key, only the prompts that cite it', () => {
  const proj = tmpDir();
  const file = makeSession(proj, 'AAAAAAAA', [
    [at(9, 7), 'KK-1 start', 'ok'], [at(9, 7, 15), 'KK-1 and KK-2 together', 'ok'], [at(9, 8), 'only KK-2 now', 'ok'], [at(9, 8, 16), 'no key here', 'ok'],
  ]);
  const { days, keyDays } = promptDays(parseSession(file));
  assert.deepEqual(days, { '2026-09-07': 2, '2026-09-08': 2 });
  assert.deepEqual(keyDays['KK-1'], { '2026-09-07': 2 });
  assert.deepEqual(keyDays['KK-2'], { '2026-09-07': 1, '2026-09-08': 1 });
});

test('taskActivity: a session counts fully for its main key and only through its citations for other keys', () => {
  const sessions = [
    { key: 'KK-1', project: 'app', days: { '2026-09-07': 3, '2026-09-08': 1 }, mention_days: { 'KK-2': { '2026-09-08': 1 } } },
    { key: 'KK-1', project: 'api', days: { '2026-09-08': 2 }, mention_days: {} },
    { key: 'KK-3', project: 'app', days: { '2026-09-20': 9 }, mention_days: { 'KK-1': { '2026-09-20': 2 } } },
  ];
  assert.deepEqual(taskActivity('KK-1', sessions), [
    { day: '2026-09-07', n: 3, project: 'app' }, { day: '2026-09-08', n: 1, project: 'app' },
    { day: '2026-09-08', n: 2, project: 'api' }, { day: '2026-09-20', n: 2, project: 'app' },
  ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.project < b.project ? -1 : 1)));
  assert.deepEqual(taskActivity('KK-2', sessions), [{ day: '2026-09-08', n: 1, project: 'app' }]);
  assert.deepEqual(taskActivity('KK-9', sessions), []);
});

test('tasks() carries the per-day activity, merged across the sessions of a task', () => {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA', [[at(9, 1), 'KK-1 a', 'ok'], [at(9, 2), 'KK-1 b', 'ok']], { branch: 'fix/KK-1', cwd: '/x/app' });
  makeSession(proj, 'BBBBBBBB', [[at(9, 2, 18), 'KK-1 c', 'ok'], [at(9, 5), 'KK-1 d', 'ok']], { branch: 'fix/KK-1', cwd: '/x/app', proj: 'p2' });
  const t = new SessionIndex(proj).tasks().find((x) => x.key === 'KK-1');
  assert.deepEqual(t.activity, [
    { day: '2026-09-01', n: 1, project: 'app' }, { day: '2026-09-02', n: 2, project: 'app' }, { day: '2026-09-05', n: 1, project: 'app' },
  ]);
});

test('a prompt without a timestamp is skipped, the task keeps its other days', () => {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA', [['', 'KK-1 no clock', 'ok'], [at(9, 3), 'KK-1 with a clock', 'ok']], { branch: 'fix/KK-1' });
  const t = new SessionIndex(proj).tasks().find((x) => x.key === 'KK-1');
  assert.equal(t.prompts, 2);
  assert.deepEqual(t.activity.map((c) => [c.day, c.n]), [['2026-09-03', 1]]);
});

// ---- layout / scale ----

test('day arithmetic is exact across month ends and daylight saving changes', () => {
  assert.equal(dayNumber('2026-10-01') - dayNumber('2026-09-30'), 1);
  assert.equal(dayNumber('2026-03-30') - dayNumber('2026-03-28'), 2);
  assert.equal(dayFromNumber(dayNumber('2026-12-31') + 1), '2027-01-01');
});

test('xPercent puts each day in the middle of its own cell', () => {
  assert.equal(xPercent('2026-09-01', '2026-09-01', '2026-09-10'), 5); // first of 10 cells
  assert.equal(xPercent('2026-09-10', '2026-09-01', '2026-09-10'), 95);
  assert.ok(xPercent('2026-09-05', '2026-09-01', '2026-09-10') < xPercent('2026-09-06', '2026-09-01', '2026-09-10'));
});

test('pickTicks never returns more than 8 ticks and starts at the first day', () => {
  for (const span of [1, 10, 14, 30, 45, 90, 400, 1000]) {
    const to = dayFromNumber(dayNumber('2026-01-01') + span - 1);
    const ticks = pickTicks('2026-01-01', to);
    assert.ok(ticks.length >= 1 && ticks.length <= 8, `${span} days -> ${ticks.length} ticks`);
    assert.equal(ticks[0].day, '2026-01-01');
    assert.ok(ticks.every((t) => t.x > 0 && t.x < 100));
  }
});

test('markSize grows with prompts, stays within bounds and 1 prompt is always the minimum', () => {
  assert.equal(markSize(1, 1), MARK_MIN);
  assert.equal(markSize(1, 50), MARK_MIN);
  assert.equal(markSize(50, 50), MARK_MAX);
  const sizes = [1, 2, 5, 10, 20, 50].map((n) => markSize(n, 50));
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
  assert.ok(sizes.every((s) => s >= MARK_MIN && s <= MARK_MAX));
});

test('repoSlots: stable alphabetical colours, a neutral slot after the validated ones', () => {
  const slots = repoSlots(['zeta', 'alpha', 'beta', 'alpha', 'gamma', 'delta']);
  assert.deepEqual([...slots], [['alpha', 0], ['beta', 1], ['delta', 2], ['gamma', -1], ['zeta', -1]]);
  assert.equal(MAX_REPO_COLORS, 3);
});

test('primaryRepo is the repo with most prompts, ties alphabetical', () => {
  assert.equal(primaryRepo([{ project: 'b', n: 2 }, { project: 'a', n: 2 }, { project: 'c', n: 1 }]), 'a');
  assert.equal(primaryRepo([{ project: 'a', n: 1 }, { project: 'b', n: 5 }]), 'b');
  assert.equal(primaryRepo([]), '');
});

const task = (key, activity, extra = {}) => ({ key, kind: 'key', activity, has_capsule: false, generatable: true, ...extra });
const cell = (month, day, n, project = 'app') => ({ day: d(month, day), n, project });

test('buildTimeline lays out lanes in the given order with dots on their own days', () => {
  const tl = buildTimeline([
    task('B-2', [cell(9, 10, 4), cell(9, 12, 1)]),
    task('A-1', [cell(9, 1, 2, 'api'), cell(9, 3, 8, 'app')], { has_capsule: true }),
  ]);
  assert.deepEqual(tl.lanes.map((l) => l.key), ['B-2', 'A-1']);
  assert.deepEqual(tl.range, { from: '2026-09-01', to: '2026-09-14', days: 14 }); // padded to the minimum span
  const a = tl.lanes[1];
  assert.deepEqual([a.first, a.last, a.prompts, a.active_days], ['2026-09-01', '2026-09-03', 10, 2]);
  assert.deepEqual(a.projects, ['api', 'app']);
  assert.equal(a.project, 'app'); // most prompts
  assert.deepEqual(a.marks.map((m) => m.slot), [0, 1]); // api, app: alphabetical slots
  assert.ok(a.marks[1].size > a.marks[0].size);
  assert.deepEqual(a.line, { x1: a.marks[0].x, x2: a.marks[1].x });
  assert.ok(a.marks.every((m) => m.x > 0 && m.x < 100));
  assert.equal(tl.shown, 2);
  assert.equal(tl.hidden, 0);
});

test('the range follows the shown tasks and is at least two weeks wide', () => {
  const tl = buildTimeline([task('A-1', [cell(9, 4, 1)])]);
  assert.equal(tl.range.days, MIN_SPAN_DAYS);
  assert.equal(tl.range.from, '2026-09-04');
  const wide = buildTimeline([task('A-1', [cell(8, 1, 1), cell(9, 30, 1)])]);
  assert.deepEqual([wide.range.from, wide.range.to], ['2026-08-01', '2026-09-30']);
});

test('limit hides older tasks and reports how many are hidden; "all" and keys show everything asked for', () => {
  const tasks = Array.from({ length: 15 }, (_, i) => task(`T-${i}`, [cell(9, 1 + i, 1)]));
  const first = buildTimeline(tasks);
  assert.deepEqual([first.shown, first.total, first.hidden], [12, 15, 3]);
  assert.equal(buildTimeline(tasks, { limit: 5 }).shown, 5);
  assert.equal(buildTimeline(tasks, { limit: 'all' }).shown, 15);
  assert.deepEqual(buildTimeline(tasks, { keys: ['T-3', 'T-1', 'NOPE'], limit: 1 }).lanes.map((l) => l.key), ['T-1', 'T-3']); // task order, no limit
});

test('filters by repo and by date range drop the dots outside, and the tasks left without any', () => {
  const tasks = [
    task('A-1', [cell(9, 1, 1, 'app'), cell(9, 9, 2, 'api')]),
    task('B-2', [cell(9, 20, 3, 'app')]),
  ];
  const api = buildTimeline(tasks, { repo: 'api' });
  assert.deepEqual(api.lanes.map((l) => [l.key, l.marks.length]), [['A-1', 1]]);
  const range = buildTimeline(tasks, { from: '2026-09-05', to: '2026-09-15' });
  assert.deepEqual(range.lanes.map((l) => l.key), ['A-1']);
  assert.equal(range.range.from, '2026-09-05');
  assert.deepEqual(buildTimeline(tasks, { from: 'garbage', to: '2026-13-45' }).lanes.length, 2); // malformed dates are ignored
});

test('a repo keeps its colour whatever the filter', () => {
  const tasks = [task('A-1', [cell(9, 1, 1, 'alpha')]), task('B-2', [cell(9, 2, 1, 'beta')]), task('C-3', [cell(9, 3, 1, 'gamma')])];
  const all = buildTimeline(tasks);
  const onlyBeta = buildTimeline(tasks, { repo: 'beta' });
  const slot = (tl, repo) => tl.repos.find((r) => r.name === repo).slot;
  assert.equal(slot(all, 'beta'), slot(onlyBeta, 'beta'));
  assert.deepEqual(all.repos.map((r) => [r.name, r.slot]), [['alpha', 0], ['beta', 1], ['gamma', 2]]);
  assert.deepEqual(all.all_repos, ['alpha', 'beta', 'gamma']);
  assert.equal(onlyBeta.repos.length, 1);
});

test('coverage counts only tasks that can have a capsule, whatever is filtered; capsule filters work', () => {
  const tasks = [
    task('A-1', [cell(9, 1, 1)], { has_capsule: true }),
    task('B-2', [cell(9, 2, 1)]),
    task('C-3', [cell(9, 3, 1)]),
    task('unassigned', [cell(9, 4, 1)], { kind: 'unassigned', generatable: false }),
  ];
  const tl = buildTimeline(tasks, { repo: 'nope-repo' });
  assert.deepEqual(tl.coverage, { ready: 1, total: 3 });
  assert.deepEqual(buildTimeline(tasks, { capsule: 'none' }).lanes.map((l) => l.key), ['B-2', 'C-3']); // unassigned cannot have one
  assert.deepEqual(buildTimeline(tasks, { capsule: 'ready' }).lanes.map((l) => l.key), ['A-1']);
});

test('tasks with no dated activity are not drawn but are counted', () => {
  const tl = buildTimeline([task('A-1', []), task('B-2', [cell(9, 2, 1)])]);
  assert.deepEqual(tl.lanes.map((l) => l.key), ['B-2']);
  assert.equal(tl.undated, 1);
  const empty = buildTimeline([]);
  assert.deepEqual([empty.lanes, empty.total, empty.coverage], [[], 0, { ready: 0, total: 0 }]);
});

test('timelineOptions ignores malformed query values', () => {
  const o = timelineOptions(new URLSearchParams('repo=app&from=2026-09-01&capsule=weird&limit=abc&keys=a%0Ab'));
  assert.deepEqual(o, { repo: 'app', from: '2026-09-01', keys: ['a', 'b'] });
  assert.deepEqual(timelineOptions(new URLSearchParams('limit=all&capsule=none')), { limit: 'all', capsule: 'none' });
  assert.deepEqual(timelineOptions(new URLSearchParams('limit=7')), { limit: 7 });
  assert.deepEqual(timelineOptions(new URLSearchParams('limit=-3')), {});
});

// ---- API ----

function get(srv, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: route }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8'))]));
    }).on('error', reject);
  });
}

test('GET /api/timeline serves the layout; /api/tasks stays light (no activity)', async () => {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA', [[at(9, 1), 'KK-1 a', 'ok'], [at(9, 3), 'KK-1 b', 'ok']], { branch: 'fix/KK-1', cwd: '/x/app' });
  makeSession(proj, 'BBBBBBBB', [[at(9, 2), 'KK-2 a', 'ok']], { branch: 'fix/KK-2', cwd: '/x/api', proj: 'p2' });
  makeSession(proj, 'CCCCCCCC', [[at(9, 9), 'loose talk', 'ok']], { branch: 'main', cwd: '/x/app', proj: 'p3' });
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: path.join(tmp, 'usage.json') });
  const srv = await startServer(app, 0);
  try {
    const [status, tl] = await get(srv, '/api/timeline');
    assert.equal(status, 200);
    assert.deepEqual(tl.lanes.map((l) => l.key), ['KK-1', 'KK-2', 'unassigned']);
    assert.equal(tl.lanes.find((l) => l.key === 'KK-1').marks.length, 2);
    assert.equal(tl.lanes[tl.lanes.length - 1].key, 'unassigned');
    assert.deepEqual(tl.coverage, { ready: 0, total: 2 });
    assert.deepEqual(tl.all_repos, ['api', 'app']);
    const [, onlyApi] = await get(srv, '/api/timeline?repo=api');
    assert.deepEqual(onlyApi.lanes.map((l) => l.key), ['KK-2']);
    const [, picked] = await get(srv, `/api/timeline?keys=${encodeURIComponent('KK-1\nunassigned')}`);
    assert.deepEqual(picked.lanes.map((l) => l.key), ['KK-1', 'unassigned']);
    const [, none] = await get(srv, '/api/timeline?capsule=none&limit=1');
    assert.equal(none.shown, 1);
    assert.equal(none.total, 2);
    const [, tasks] = await get(srv, '/api/tasks');
    assert.ok(tasks.tasks.every((t) => !('activity' in t)));
  } finally {
    srv.server.close();
  }
});

test('"tasks" counts match the coverage ring: sessions without a task key are reported apart', () => {
  const tasks = [
    task('A-1', [cell(9, 1, 1)], { has_capsule: true }),
    task('A-2', [cell(9, 2, 1)]),
    task('unassigned', [cell(9, 3, 1)], { kind: 'unassigned', generatable: false }),
  ];
  const tl = buildTimeline(tasks);
  assert.deepEqual(tl.coverage, { ready: 1, total: 2 });
  assert.deepEqual([tl.task_shown, tl.task_total], [2, tl.coverage.total]); // the footer and the ring talk about the same tasks
  assert.deepEqual([tl.unassigned_shown, tl.unassigned_total], [1, 1]);
  assert.deepEqual([tl.shown, tl.total], [3, 3]); // lanes drawn (what "show more" counts) still include the unassigned one
  const noUnassigned = buildTimeline(tasks.slice(0, 2));
  assert.deepEqual([noUnassigned.unassigned_shown, noUnassigned.unassigned_total], [0, 0]);
  const limited = buildTimeline(tasks, { limit: 1 });
  assert.deepEqual([limited.task_shown, limited.task_total, limited.unassigned_total], [1, 2, 1]);
});

test('a reversed date range selects the same days as the ordered one and reports the range it applied', () => {
  const tasks = [task('A-1', [cell(9, 1, 1), cell(9, 20, 1)]), task('A-2', [cell(9, 5, 1)])];
  const ordered = buildTimeline(tasks, { from: d(9, 3), to: d(9, 10) });
  const reversed = buildTimeline(tasks, { from: d(9, 10), to: d(9, 3) });
  assert.deepEqual(reversed.lanes, ordered.lanes);
  assert.deepEqual(reversed.range, ordered.range);
  assert.deepEqual(reversed.applied, { from: d(9, 3), to: d(9, 10) });
  assert.deepEqual(buildTimeline(tasks).applied, { from: null, to: null });
});

test('tasks without dated activity are counted, not drawn, and never break the totals', () => {
  const tl = buildTimeline([task('A-1', [cell(9, 1, 1)]), task('A-2', []), task('A-3', undefined)]);
  assert.equal(tl.undated, 2);
  assert.deepEqual([tl.shown, tl.total, tl.task_shown, tl.task_total], [1, 1, 1, 1]);
  assert.equal(tl.coverage.total, 3); // the ring still counts every task that can have a capsule
});
