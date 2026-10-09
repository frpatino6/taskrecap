import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { App, UserError } from '../src/app.js';
import { Overrides, OVERRIDES_VERSION } from '../src/units.js';
import { makeSession, tmpDir } from './helpers.js';

const at = (h, m = 0, d = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

function fixture() {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [[at(9), 'KK-1 fix the rounding bug', 'ok'], [at(10), 'KK-1 more work on the fix', 'ok']], { branch: 'fix/KK-1-x' });
  makeSession(proj, 'BBBBBBBB-2222', [[at(11), 'Investigate why the orders endpoint fails on empty carts', 'ok']], { branch: 'main', proj: 'p2', cwd: '/x/api' });
  makeSession(proj, 'CCCCCCCC-3333', [[at(12), 'Rewrite the onboarding guide for new developers please', 'ok']], { branch: 'main', proj: 'p3', cwd: '/x/docs' });
  return { tmp, proj };
}
const newApp = ({ tmp, proj }) => new App({ projectsDir: proj, cacheDir: path.join(tmp, 'cache'), usageFile: path.join(tmp, 'usage.json'), ask: async () => { throw new Error('corrections never call the LLM'); } });
const keys = (app, opts) => app.listTasks(opts).map((t) => t.key).sort();

// ---------- the store ----------
test('Overrides: persisted as versioned JSON, written atomically, reloaded by a new process', () => {
  const file = path.join(tmpDir(), 'sub', 'overrides.json');
  const o = new Overrides(file);
  const batch = o.add([{ type: 'rename', unit: 'KK-1', label: 'Rounding' }]);
  assert.ok(batch);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, OVERRIDES_VERSION);
  assert.equal(onDisk.ops.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left behind');
  assert.equal(new Overrides(file).state().labels.get('KK-1'), 'Rounding', 'survives a restart');
});

test('Overrides: a damaged file is moved aside and the app starts with no corrections', () => {
  const file = path.join(tmpDir(), 'overrides.json');
  fs.writeFileSync(file, '{ this is not json');
  const o = new Overrides(file);
  assert.equal(o.ops().length, 0);
  assert.ok(o.corrupt && fs.existsSync(o.corrupt), 'the damaged file is kept, not deleted');
  o.add([{ type: 'hide', unit: 'KK-1' }]);
  assert.equal(new Overrides(file).ops().length, 1, 'new corrections are saved normally');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ops: 'nope' }));
  assert.equal(new Overrides(file).ops().length, 0);
  fs.writeFileSync(file, JSON.stringify({ version: 99, ops: [] }));
  const future = new Overrides(file);
  assert.equal(future.ops().length, 0);
  assert.ok(future.corrupt, 'a file written by a newer version is kept aside, not overwritten');
});

test('Overrides: undo reverts a whole batch, in order; nothing to undo is a clear error; signature follows the active corrections', () => {
  const o = new Overrides(path.join(tmpDir(), 'o.json'));
  const empty = o.signature();
  o.add([{ type: 'rename', unit: 'KK-1', label: 'A' }]);
  const one = o.signature();
  const b2 = o.add([{ type: 'merge', unit: 'user:u', members: ['x'] }, { type: 'move', session: 's1', to: 'user:u' }]);
  assert.notEqual(one, o.signature());
  assert.equal(o.last().batch, b2);
  const undone = o.undo();
  assert.equal(undone.length, 2, 'both operations of the batch are undone together');
  assert.equal(o.signature(), one, 'the signature goes back to what it was');
  assert.equal(o.state().merges.size, 0);
  o.undo();
  assert.equal(o.signature(), empty);
  assert.throws(() => o.undo(), (e) => e instanceof UserError && /Nothing to undo/.test(e.message));
  o.add([{ type: 'hide', unit: 'KK-1' }]);
  assert.throws(() => o.undo('no-such-batch'), /already undone or does not exist/);
});

// ---------- the corrections through the app ----------
test('rename: the new name shows, is saved, survives a restart, and an empty name goes back to the automatic one', () => {
  const f = fixture();
  const app = newApp(f);
  app.renameUnit('KK-1', '  Rounding   fix ');
  assert.equal(app.listTasks().find((t) => t.key === 'KK-1').label, 'Rounding fix');
  assert.equal(app.listTasks().find((t) => t.key === 'KK-1').renamed, true);
  assert.equal(newApp(f).listTasks().find((t) => t.key === 'KK-1').label, 'Rounding fix', 'a new process still has it');
  app.renameUnit('KK-1', '');
  assert.equal(app.listTasks().find((t) => t.key === 'KK-1').label, 'KK-1');
  assert.throws(() => app.renameUnit('NOPE-1', 'x'), /does not exist/);
  assert.throws(() => app.renameUnit('KK-1', 'x'.repeat(200)), /at most 120/);
});

test('merge: two units become one group of the user; split gives them back; undo does too', () => {
  const f = fixture();
  const app = newApp(f);
  const r = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC'], 'Docs and API');
  assert.match(r.unit, /^user:/);
  assert.deepEqual(keys(app), ['KK-1', r.unit].sort());
  const group = app.listTasks().find((t) => t.key === r.unit);
  assert.equal(group.label, 'Docs and API');
  assert.equal(group.sessions, 2);
  assert.equal(group.can_split, true);
  assert.equal(group.generatable, true);
  assert.deepEqual(app.taskDetail(r.unit).sessions.map((s) => s.main), [true, true]);
  app.splitUnit(r.unit);
  assert.deepEqual(keys(app), ['KK-1', 'session:BBBBBBBB', 'session:CCCCCCCC']);
  app.undoChange(); // undo the split: the group is back
  assert.ok(keys(app).includes(r.unit));
  app.undoChange(); // undo the merge
  assert.deepEqual(keys(app), ['KK-1', 'session:BBBBBBBB', 'session:CCCCCCCC']);
});

test('merge: joining a group adds to it; two groups cannot be merged; bad input is a clear error', () => {
  const app = newApp(fixture());
  const first = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC']).unit;
  const joined = app.mergeUnits([first, 'KK-1']);
  assert.equal(joined.unit, first, 'KK-1 joined the existing group');
  assert.equal(app.listTasks().find((t) => t.key === first).sessions, 3);
  assert.throws(() => app.mergeUnits(['KK-1']), /at least two/);
  assert.throws(() => app.mergeUnits([first, 'NOPE']), /does not exist/);
  const second = app.moveSession('AAAAAAAA-1111', 'new').unit;
  assert.throws(() => app.mergeUnits([first, second]), /Two groups cannot be merged/);
});

test('move: a session leaves its unit and is read only under the new one; "new" makes a group; undo brings it back', () => {
  const f = fixture();
  const app = newApp(f);
  app.moveSession('BBBBBBBB', 'KK-1'); // an id prefix is enough
  assert.ok(!keys(app).includes('session:BBBBBBBB'));
  assert.equal(app.listTasks().find((t) => t.key === 'KK-1').sessions, 2);
  assert.equal(newApp(f).listTasks().find((t) => t.key === 'KK-1').sessions, 2, 'persisted');
  const msgs = app.sessionMessages({ key: 'KK-1', session: 'BBBBBBBB' });
  assert.equal(msgs.total, 1);
  const moved = app.taskDetail('KK-1').sessions.find((s) => s.id.startsWith('BBBBBBBB'));
  assert.equal(moved.main, true, 'a moved session counts fully for the unit it was moved to');
  assert.equal(moved.mixed, false);
  app.undoChange();
  assert.ok(keys(app).includes('session:BBBBBBBB'));
  const made = app.moveSession('CCCCCCCC', 'new', 'My docs work');
  const g = app.listTasks().find((t) => t.key === made.unit);
  assert.equal(g.label, 'My docs work');
  assert.equal(g.sessions, 1);
  assert.ok(!keys(app).includes('session:CCCCCCCC'));
  assert.throws(() => app.moveSession('NOSUCHSESSION', 'KK-1'), /does not exist/);
  assert.throws(() => app.moveSession('BBBBBBBB', 'NOPE'), /destination does not exist/);
  assert.throws(() => app.moveSession('ab', 'KK-1'), /Which session/);
});

test('split only works on groups the user made', () => {
  const app = newApp(fixture());
  assert.throws(() => app.splitUnit('KK-1'), /Only groups you made/);
  assert.throws(() => app.splitUnit('user:nope'), /does not exist/);
});

test('hide: units and sessions leave the list and counts, show up under hidden items, and come back', () => {
  const app = newApp(fixture());
  app.hideUnit('KK-1');
  assert.ok(!keys(app).includes('KK-1'));
  assert.ok(keys(app, { includeHidden: true }).includes('KK-1'));
  assert.ok(app.taskDetail('KK-1'), 'a hidden unit can still be opened');
  assert.deepEqual(app.hiddenItems().units.map((u) => u.key), ['KK-1']);
  app.hideUnit('KK-1', false);
  assert.ok(keys(app).includes('KK-1'));
  app.hideSession('CCCCCCCC');
  assert.ok(!keys(app).includes('session:CCCCCCCC'));
  assert.equal(app.hiddenItems().sessions.length, 1);
  assert.equal(app.hiddenItems().sessions[0].id8, 'CCCCCCCC');
  app.hideSession('CCCCCCCC', false);
  assert.ok(keys(app).includes('session:CCCCCCCC'));
});

test('corrections win over the automatic grouping and survive new sessions arriving', () => {
  const f = fixture();
  const app = newApp(f);
  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC'], 'Mine').unit;
  app.renameUnit('KK-1', 'Renamed');
  app.hideSession('AAAAAAAA');
  makeSession(f.proj, 'DDDDDDDD-4444', [[at(14), 'A brand new session with plenty of words in it', 'ok']], { branch: 'main', proj: 'p4', cwd: '/x/new' });
  const t = app.listTasks();
  assert.ok(t.some((x) => x.key === g && x.label === 'Mine' && x.sessions === 2), 'the group is untouched');
  assert.ok(t.some((x) => x.key === 'session:DDDDDDDD'), 'the new session is its own unit');
  assert.ok(!t.some((x) => x.key === 'KK-1'), 'its only session is hidden, so the unit is gone');
  assert.equal(app.hiddenItems().sessions.length, 1);
});

test('history reports what Undo would revert; a damaged overrides file is flagged and never breaks the app', () => {
  const f = fixture();
  const app = newApp(f);
  assert.deepEqual(app.changeHistory(), { last: null, count: 0, corrupt: false });
  app.renameUnit('KK-1', 'X');
  assert.equal(app.changeHistory().last.type, 'rename');
  const file = path.join(f.tmp, 'cache', '.index', 'overrides.json');
  fs.writeFileSync(file, 'garbage{{');
  const reborn = newApp(f);
  assert.equal(reborn.listTasks().find((t) => t.key === 'KK-1').label, 'KK-1');
  assert.equal(reborn.changeHistory().corrupt, true);
});

test('the file index and search follow the corrections', () => {
  const f = fixture();
  const app = newApp(f);
  app.renameUnit('session:BBBBBBBB', 'Orders endpoint outage');
  assert.deepEqual(app.search('outage').map((h) => h.key), ['session:BBBBBBBB'], 'a name the user chose is searchable');
  const before = app.fileIndex.index.overridesSignature();
  app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC']);
  assert.notEqual(app.fileIndex.index.overridesSignature(), before, 'the persisted file index is rebuilt after a correction');
});

test('a session or group unit can be estimated; the placeholder cannot', () => {
  const app = newApp(fixture());
  assert.equal(app.estimate('session:BBBBBBBB').ranges_known, true);
  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC']).unit;
  assert.equal(app.estimate(g).sessions, 2);
  assert.throws(() => app.estimate('unassigned'), /not a unit with a capsule/);
});
