import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.js';
import { SessionIndex, capsuleStaleness, promptTimes } from '../src/tasks.js';
import { parseSession } from '../src/sessions.js';
import { makeSession, tmpDir, ts } from './helpers.js';

const at = (m) => Date.parse(ts(m));

/** Projects dir with: AAAAAAAA (KK-1 only, 3 messages at :00 :10 :20) and BBBBBBBB (KK-2 session that cites KK-1 twice). */
function fixture() {
  const proj = path.join(tmpDir(), 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 start', 'ok'], [ts(10), 'KK-1 continue', 'ok'], [ts(20), 'KK-1 finish', 'ok']], { branch: 'fix/KK-1' });
  makeSession(proj, 'BBBBBBBB-2222', [
    [ts(30), 'KK-2 other work', 'ok'], [ts(40), 'about KK-1 again', 'ok'], [ts(50), 'KK-2 more', 'ok'], [ts(55), 'and KK-1 once more', 'ok'],
  ], { branch: 'fix/KK-2' });
  return proj;
}
const sessionsOf = (proj) => new SessionIndex(proj).sessions();

test('promptTimes skips automatic messages and groups the times by the keys the messages cite', () => {
  const proj = path.join(tmpDir(), 'projects');
  const file = makeSession(proj, 'CCCCCCCC-3333', [[ts(0), 'KK-1 real', 'ok'], [ts(1), '[Request interrupted by user]', 'ok'], [ts(2), 'no key here', 'ok']]);
  const t = promptTimes(parseSession(file), undefined);
  assert.deepEqual(t.all, [at(0), at(2)]);
  assert.deepEqual(t.byKey, { 'KK-1': [at(0)] });
});

test('capsuleStaleness: messages after the capsule date are new; none after means up to date', () => {
  const s = sessionsOf(fixture());
  const fresh = capsuleStaleness(s, 'KK-1', ts(5)); // 2 of the 3 messages of session A (10, 20) plus the 2 citing messages of B (40, 55)
  assert.equal(fresh.known, true);
  assert.equal(fresh.new_messages, 4);
  const a = s.find((x) => x.id.startsWith('AAAAAAAA'));
  assert.equal(fresh.by_session[a.id], 2);
  const none = capsuleStaleness(s, 'KK-1', ts(59));
  assert.deepEqual([none.known, none.new_messages, none.new_sessions, none.by_session], [true, 0, 0, {}]);
});

test('capsuleStaleness: a session the task only shares counts just the messages that cite the key', () => {
  const s = sessionsOf(fixture());
  const b = s.find((x) => x.id.startsWith('BBBBBBBB'));
  const st = capsuleStaleness(s, 'KK-1', ts(35)); // B has 3 messages after :35 but only 2 cite KK-1
  assert.equal(st.by_session[b.id], 2);
  assert.equal(st.new_messages, 2, 'session A is older than the capsule');
});

test('capsuleStaleness: a session that appeared since the capsule is flagged as a new session', () => {
  const s = sessionsOf(fixture());
  const st = capsuleStaleness(s, 'KK-1', ts(25)); // A is entirely older; B (shared) is entirely newer
  assert.equal(st.new_sessions, 1);
  assert.equal(st.new_messages, 2);
  const partial = capsuleStaleness(s, 'KK-1', ts(5)); // A is only partly newer, so it is not a "new session"; B is
  assert.equal(partial.new_sessions, 1);
});

test('capsuleStaleness: a missing or unreadable date is never guessed at', () => {
  const s = sessionsOf(fixture());
  for (const bad of [undefined, null, '', 'not a date']) {
    const st = capsuleStaleness(s, 'KK-1', bad);
    assert.deepEqual([st.known, st.new_messages, st.new_sessions], [false, 0, 0]);
  }
});

test('capsuleStaleness: the same instant written in different time zones gives the same answer', () => {
  const s = sessionsOf(fixture());
  const utc = capsuleStaleness(s, 'KK-1', '2026-01-01T00:05:00Z');
  const plus = capsuleStaleness(s, 'KK-1', '2026-01-01T05:35:00+05:30');
  const minus = capsuleStaleness(s, 'KK-1', '2025-12-31T19:05:00-05:00');
  assert.equal(utc.new_messages, 4);
  assert.deepEqual([plus.new_messages, minus.new_messages], [4, 4]);
});

test('capsuleStaleness: ignores automatic messages written after the capsule', () => {
  const proj = path.join(tmpDir(), 'projects');
  makeSession(proj, 'DDDDDDDD-4444', [[ts(0), 'KK-9 work', 'ok'], [ts(30), '[Request interrupted by user]', 'ok']], { branch: 'fix/KK-9' });
  const st = capsuleStaleness(sessionsOf(proj), 'KK-9', ts(10));
  assert.equal(st.new_messages, 0);
});

function writeCapsule(app, key, generatedAt) {
  fs.mkdirSync(app.store.dir, { recursive: true });
  const body = { key, capsule: { objective: `Objective of ${key}` }, sources: [], markdown: '# x' };
  if (generatedAt !== undefined) body.generated_at = generatedAt;
  fs.writeFileSync(app.store.filePath(key, 'json'), JSON.stringify(body));
}

test('listTasks and taskDetail report which capsules are outdated', () => {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 start', 'ok'], [ts(10), 'KK-1 continue', 'ok'], [ts(20), 'KK-1 finish', 'ok']], { branch: 'fix/KK-1' });
  makeSession(proj, 'EEEEEEEE-5555', [[ts(0), 'KK-3 start', 'ok'], [ts(5), 'KK-3 end', 'ok']], { branch: 'fix/KK-3' });
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: null });
  writeCapsule(app, 'KK-1', ts(5)); // 2 messages newer
  writeCapsule(app, 'KK-3', ts(30)); // up to date
  const tasks = new Map(app.listTasks().map((t) => [t.key, t]));
  assert.deepEqual([tasks.get('KK-1').has_capsule, tasks.get('KK-1').outdated, tasks.get('KK-1').new_messages], [true, true, 2]);
  assert.deepEqual([tasks.get('KK-3').has_capsule, tasks.get('KK-3').outdated, tasks.get('KK-3').new_messages], [true, false, 0]);
  const d = app.taskDetail('KK-1');
  assert.deepEqual([d.stale.known, d.stale.new_messages, d.stale.new_sessions, d.stale.generated_at], [true, 2, 0, ts(5)]);
  assert.equal(d.sessions[0].new_messages, 2);
  assert.equal(d.markable, true);
  const tl = app.timeline();
  assert.equal(tl.coverage.outdated, 1);
  const lane = tl.lanes.find((l) => l.key === 'KK-1');
  assert.deepEqual([lane.outdated, lane.new_messages], [true, 2]);
  assert.equal(tl.lanes.find((l) => l.key === 'KK-3').outdated, false);
});

test('a capsule without a date shows no badge, and a task without a capsule has no staleness at all', () => {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[ts(0), 'KK-1 start', 'ok'], [ts(10), 'KK-1 more', 'ok']], { branch: 'fix/KK-1' });
  makeSession(proj, 'FFFFFFFF-6666', [[ts(0), 'KK-4 a', 'ok'], [ts(1), 'KK-4 b', 'ok']], { branch: 'fix/KK-4' });
  const app = new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: null });
  writeCapsule(app, 'KK-1', undefined);
  const tasks = new Map(app.listTasks().map((t) => [t.key, t]));
  assert.deepEqual([tasks.get('KK-1').outdated, tasks.get('KK-1').new_messages, tasks.get('KK-1').capsule_at], [false, 0, null]);
  assert.equal(tasks.get('KK-4').outdated, undefined);
  assert.equal(app.taskDetail('KK-4').stale, null);
  assert.equal(app.taskDetail('KK-1').stale.known, false);
});

test('the staleness check reads no session file: it uses the summaries already in memory', () => {
  const proj = fixture();
  const index = new SessionIndex(proj);
  const sessions = index.sessions(); // parsed once
  const spy = [];
  const orig = fs.readFileSync;
  fs.readFileSync = (...a) => { spy.push(String(a[0])); return orig(...a); };
  try {
    capsuleStaleness(sessions, 'KK-1', ts(5));
  } finally {
    fs.readFileSync = orig;
  }
  assert.deepEqual(spy, []);
});
