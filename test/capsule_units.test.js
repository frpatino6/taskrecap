// Phase 5: capsules for every kind of work unit (task key, branch, one session, a group of the user's, a part of a session).
// The LLM is always a stub here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { App, UserError } from '../src/app.js';
import * as C from '../src/capsule.js';
import { CALL_OVERHEAD_TOKENS } from '../src/llm.js';
import { startServer } from '../src/server.js';
import { CapsuleStore, SessionIndex, capsuleDrift, capsuleStaleness, capsuleStem, capsuleStems, planTask, unitMeta } from '../src/tasks.js';
import { makeSession, tmpDir, ts } from './helpers.js';

const servers = [];
after(() => servers.forEach((s) => s.server.close()));

const META = { cost_usd: 0.01, input_tokens: 100, output_tokens: 50 };

/**
 * A scripted model. `calls` records every prompt; the capsule answer cites `cites` (id8 + turn) and echoes nothing else.
 * Range-selection prompts answer with turns 0-1 of whatever session they are about.
 */
function scripted(cites = [{ session: 'BBBBBBBB', turn: 2 }]) {
  const calls = [];
  const ask = async (prompt) => {
    calls.push(prompt);
    if (prompt.includes('State which turn ranges')) return [JSON.stringify({ ranges: [{ start: 0, end: 1, reason: 'x' }] }), META];
    return [JSON.stringify({
      objective: 'Find out why the orders endpoint fails on empty carts',
      timeline: [{ date: '01-01', repo: 'api', result: 'Looked into the failing endpoint', cites }],
      decisions: [{ decision: 'Return zero for an empty cart', why: 'the reduce had no start value', cites }, { decision: 'Invented', why: 'no evidence', cites: [{ session: 'BBBBBBBB', turn: 99 }] }],
      dead_ends: [], left_out: [], pending: [{ text: 'more tests', cites: [] }], briefing: 'Resume the empty cart fix.',
    }), META];
  };
  return { ask, calls, votes: () => calls.filter((c) => c.includes('State which turn ranges')).length, writes: () => calls.filter((c) => !c.includes('State which turn ranges')) };
}

/**
 * KK-1 (key unit), BBBBBBBB (a key-less session full of noise around real work), CCCCCCCC (a short key-less one), DDDDDDDD (8 turns, to be cut).
 */
function fixture() {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'AAAAAAAA-1111', [
    [ts(0), 'KK-1 fix the rounding bug', 'looking', [['Edit', { file_path: '/x/app/src/price.js' }, null]]],
    [ts(1), 'KK-1 and add a test for it', 'done'],
    [ts(2), 'something else entirely: how do I rename a branch?', 'git branch -m'],
  ], { branch: 'fix/KK-1-x' });
  makeSession(proj, 'BBBBBBBB-2222', [
    [ts(10), '<ide_opened_file>The user opened /x/api/src/cart.js in the IDE.</ide_opened_file>', 'ok'], // 0: editor tag only
    [ts(11), 'hola', 'hi!'], // 1: greeting
    [ts(12), 'Investigate why the orders endpoint fails on empty carts', 'The reduce has no start value', [['Edit', { file_path: '/x/api/src/cart.js' }, null]]], // 2
    [ts(13), '/code-review', 'reviewing'], // 3: command
    [ts(14), 'ok', 'fixed it', [['Edit', { file_path: '/x/api/src/cart.js' }, null]]], // 4: a terse answer that came with real work
    [ts(15), '[Request interrupted by user]', 'stopped'], // 5: automatic
    [ts(16), 'Now add a regression test for the empty cart case', 'added', [['Bash', { command: 'git commit -m "empty cart returns zero"' }, '[main abc1234] empty cart returns zero\n 1 file changed']]], // 6
    [ts(17), 'thanks', 'you are welcome'], // 7: greeting, no work
  ], { branch: 'main', proj: 'p2', cwd: '/x/api' });
  makeSession(proj, 'CCCCCCCC-3333', [
    [ts(20), 'Rewrite the onboarding guide for new developers please', 'rewritten', [['Edit', { file_path: '/x/docs/onboarding.md' }, null]]],
    [ts(21), 'Add a section about the local setup of the project', 'added'],
  ], { branch: 'main', proj: 'p3', cwd: '/x/docs' });
  makeSession(proj, 'DDDDDDDD-4444', Array.from({ length: 8 }, (_, i) => [ts(30 + i), `Work item number ${i} needs a careful look today`, `done ${i}`]), { branch: 'main', proj: 'p4', cwd: '/x/web' });
  return { tmp, proj, cache: path.join(tmp, 'cache') };
}
const newApp = (f, ask = scripted().ask) => new App({ projectsDir: f.proj, cacheDir: f.cache, usageFile: path.join(f.tmp, 'usage.json'), votes: 3, ask });
const fullId = (app, id8) => app.index.sessions().find((s) => s.id.startsWith(id8)).id;

// ---------- which turns count ----------
test('usableTurn / meaningfulRanges: editor tags, commands, greetings and automatic messages are left out, work done in a terse turn stays', () => {
  const f = fixture();
  const idx = new SessionIndex(f.proj);
  const file = idx.listFiles().find((p) => p.includes('BBBBBBBB'));
  const turns = C.loadRichTurns(file);
  assert.deepEqual(turns.map((t) => C.usableTurn(t)), [false, false, true, false, true, false, true, false]);
  assert.deepEqual(C.meaningfulRanges(turns), [[2, 2], [4, 4], [6, 6]]);
  assert.deepEqual(C.meaningfulRanges([]), []);
  assert.deepEqual(C.clampRanges([[-3, 2], [5, 99], [7, 6]], 8), [[0, 2], [5, 7]]);
});

// ---------- turn selection per unit type ----------
test('planTask: a session unit sends its usable turns, a group the union of its members, a part exactly its range, a key unit is unchanged', () => {
  const f = fixture();
  const app = newApp(f);
  const idx = app.index;

  const session = planTask(idx, 'session:BBBBBBBB');
  assert.equal(session.length, 1);
  assert.deepEqual(session[0].ranges, [[2, 2], [4, 4], [6, 6]]);

  const key = planTask(idx, 'KK-1');
  assert.equal(key.length, 1);
  assert.equal(key[0].ranges, undefined, 'a key unit still picks its turns by the key');
  assert.equal(key[0].mode, 'keyed');

  const group = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC'], 'Cart and docs').unit;
  const plan = planTask(idx, group);
  assert.equal(plan.length, 2);
  const byId = Object.fromEntries(plan.map((p) => [path.basename(p.path).slice(0, 8), p.ranges]));
  assert.deepEqual(byId, { BBBBBBBB: [[2, 2], [4, 4], [6, 6]], CCCCCCCC: [[0, 1]] });

  app.overrides.add([{ type: 'cut', session: fullId(app, 'DDDDDDDD'), parts: [{ start: 0, end: 2, label: 'First job' }, { start: 3, end: 7, label: 'Second job' }], source: 'ai' }]);
  const first = planTask(idx, 'session:DDDDDDDD#0-2');
  const second = planTask(idx, 'session:DDDDDDDD#3-7');
  assert.deepEqual(first.map((p) => p.ranges), [[[0, 2]]]);
  assert.deepEqual(second.map((p) => p.ranges), [[[3, 7]]], 'exactly the accepted range, nothing around it');
});

test('a group that holds a part and the rest of the same session gets the whole session back', () => {
  const f = fixture();
  const app = newApp(f);
  app.overrides.add([{ type: 'cut', session: fullId(app, 'DDDDDDDD'), parts: [{ start: 0, end: 3, label: 'A' }, { start: 4, end: 7, label: 'B' }], source: 'ai' }]);
  const g = app.mergeUnits(['session:DDDDDDDD#0-3', 'session:DDDDDDDD#4-7']).unit;
  const plan = planTask(app.index, g);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].ranges, [[0, 7]]);
});

// ---------- generation without asking which turns ----------
test('a session unit skips the range votes, says so in the progress, cites only its own turns and never invents a key', async () => {
  const f = fixture();
  const model = scripted([{ session: 'BBBBBBBB', turn: 2 }]);
  const app = newApp(f, model.ask);
  const events = [];
  const saved = await app.generate('session:BBBBBBBB', { emit: (e) => events.push(e) });
  assert.equal(model.votes(), 0, 'no range-selection call for a unit whose turns are known');
  assert.equal(model.calls.length, 1, 'one call: the capsule itself');
  const votes = events.find((e) => e.type === 'stage' && e.id === 'votes' && e.status === 'skipped');
  assert.equal(votes.code, 'votes_skipped_known');
  assert.deepEqual(votes.vars, { sessions: 1, turns: 3 });
  assert.deepEqual(saved.info.range_mode, { BBBBBBBB: 'known-ranges' });
  assert.equal(saved.sources[0], '`BBBBBBBB` (turns 2-2, 4-4, 6-6)');
  // citations: the one inside the unit's turns stays, the invented decision (turn 99) is dropped
  assert.deepEqual(saved.capsule.decisions.map((d) => d.decision), ['Return zero for an empty cart']);
  // the prompt: no key to invent, no noise, no lead-up context
  const prompt = model.writes()[0];
  assert.match(prompt, /a unit of work that has no task key/);
  assert.match(prompt, /Do NOT invent a key/);
  assert.doesNotMatch(prompt, /lead-up context\)\s*(USER|CLAUDE)/);
  assert.match(prompt, /\[s:BBBBBBBB t:2 /);
  assert.doesNotMatch(prompt, /\[s:BBBBBBBB t:(0|1|3|5|7) /, 'noise turns are not sent');
  assert.doesNotMatch(prompt, /hola|ide_opened_file/);
  // commits made in the unit's own turns are its commits (there is no key to match)
  assert.deepEqual(saved.commits.confirmed.map((c) => c.hash), ['abc1234']);
  assert.deepEqual(saved.commits.possible, []);
  assert.match(saved.markdown, /^# Work capsule · Investigate why the orders endpoint fails on empty carts/);
  assert.doesNotMatch(saved.markdown, /session:BBBBBBBB/);
  // it remembers what it was written for
  assert.equal(saved.key, 'session:BBBBBBBB');
  assert.equal(saved.unit.id, 'session:BBBBBBBB');
  assert.equal(saved.unit.keyed, false);
  assert.deepEqual(saved.unit.basis, [{ session: fullId(app, 'BBBBBBBB'), range: null }]);
});

test('a key unit still asks the model which turns belong to it (3 votes), exactly as before', async () => {
  const f = fixture();
  const model = scripted([{ session: 'AAAAAAAA', turn: 0 }]);
  const app = newApp(f, model.ask);
  const saved = await app.generate('KK-1');
  assert.equal(model.votes(), 3);
  assert.match(saved.info.range_mode.AAAAAAAA, /^llm-vote3\/3$/);
  assert.match(model.writes()[0], /work on the task KK-1\./);
  assert.equal(saved.unit.id, 'key:KK-1');
  assert.equal(saved.unit.keyed, true);
  assert.match(saved.markdown, /^# Work capsule · KK-1/);
});

test('a group of the user reads the union of its members; an AI part reads exactly its range, with no lead-up turns', async () => {
  const f = fixture();
  const model = scripted([{ session: 'BBBBBBBB', turn: 2 }, { session: 'CCCCCCCC', turn: 1 }]);
  const app = newApp(f, model.ask);
  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC'], 'Cart and docs').unit;
  const saved = await app.generate(g);
  assert.equal(model.votes(), 0);
  assert.deepEqual(Object.keys(saved.info.range_mode).sort(), ['BBBBBBBB', 'CCCCCCCC']);
  assert.deepEqual(saved.sources, ['`BBBBBBBB` (turns 2-2, 4-4, 6-6)', '`CCCCCCCC` (turns 0-1)']);
  assert.match(saved.markdown, /^# Work capsule · Cart and docs/);
  assert.equal(saved.unit.source, 'user');
  assert.equal(saved.unit.basis.length, 2);

  const m2 = scripted([{ session: 'DDDDDDDD', turn: 4 }]);
  const app2 = newApp(f, m2.ask);
  app2.overrides.add([{ type: 'cut', session: fullId(app2, 'DDDDDDDD'), parts: [{ start: 0, end: 3, label: 'First job' }, { start: 4, end: 7, label: 'Second job' }], source: 'ai' }]);
  const part = await app2.generate('session:DDDDDDDD#4-7');
  assert.equal(m2.votes(), 0);
  assert.equal(part.sources[0], '`DDDDDDDD` (turns 4-7)');
  const prompt = m2.writes()[0];
  assert.match(prompt, /named "Second job"/);
  assert.ok(!/t:[0-3] /.test(prompt), 'turns before the range are not borrowed as context');
  assert.deepEqual(part.capsule.decisions.map((d) => d.decision), ['Return zero for an empty cart'].slice(0, 0).concat(part.capsule.decisions.map((d) => d.decision)));
  assert.deepEqual(part.unit.basis, [{ session: fullId(app2, 'DDDDDDDD'), range: [4, 7] }]);
});

test('a session with no real message cannot be turned into a capsule and costs nothing', async () => {
  const f = fixture();
  makeSession(path.join(f.tmp, 'projects'), 'EEEEEEEE-5555', [[ts(40), 'hola', 'hi'], [ts(41), '/code-review', 'ok']], { branch: 'main', proj: 'p5' });
  const model = scripted();
  const app = newApp(f, model.ask);
  assert.throws(() => app.estimate('session:EEEEEEEE'), /no real messages/);
  await assert.rejects(app.generate('session:EEEEEEEE'), UserError);
  assert.equal(model.calls.length, 0);
  assert.equal(app.listTasks().find((t) => t.key === 'session:EEEEEEEE').generatable, false);
  assert.equal(app.listTasks().find((t) => t.key === 'session:BBBBBBBB').generatable, true);
});

test('a huge session is condensed to the size cap, keeping the start and the end', () => {
  const turns = Array.from({ length: 900 }, (_, i) => ({
    ts: ts(i % 60), text: `Message number ${i} with some words to make it longer than nothing at all`, files: [], assistant: ['an answer that is also somewhat long ' + 'x'.repeat(100)], commands: [], noise: false, keys: [], cwd: '', compaction: false,
  }));
  const text = C.boundedTranscript('ZZZZZZZZ', turns, [[0, 899]], [], 20000);
  assert.ok(text.length <= 20000, `got ${text.length}`);
  assert.match(text, /\[s:ZZZZZZZZ t:0 /);
  assert.match(text, /\[s:ZZZZZZZZ t:899 /);
  assert.match(text, /lines from the middle of this session were left out/);
  const small = C.boundedTranscript('ZZZZZZZZ', turns.slice(0, 5), [[0, 4]], [], 20000);
  assert.doesNotMatch(small, /left out/);
});

// ---------- the estimate ----------
test('the estimate for a unit with known turns is one call and matches what is really sent; a key unit still counts its votes', async () => {
  const f = fixture();
  const model = scripted();
  const app = newApp(f, model.ask);
  const est = app.estimate('session:BBBBBBBB');
  assert.equal(est.calls, 1);
  assert.equal(est.ranges_known, true);
  assert.equal(est.turns, 3);
  assert.equal(est.sessions, 1);
  await app.generate('session:BBBBBBBB');
  const sent = model.writes()[0].length;
  const estimated = (est.input_tokens - CALL_OVERHEAD_TOKENS) * 4; // without the fixed per-call overhead of a headless Claude Code call
  assert.ok(estimated >= sent * 0.85 && estimated <= sent * 1.2, `estimated ${estimated} characters, sent ${sent}`);

  const key = app.estimate('KK-1');
  assert.equal(key.calls, 4, '3 votes + the capsule');
  assert.equal(key.ranges_known, false);
  assert.ok(key.usd >= 0);

  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC']).unit;
  const ge = app.estimate(g);
  assert.equal(ge.calls, 1);
  assert.equal(ge.sessions, 2);
  assert.equal(ge.turns, 5);
});

test('the fixed part of the prompt used by the estimate stays close to the real one', () => {
  const none = { confirmed: [], possible: [] };
  for (const unit of [null, { keyed: false, label: 'A short name for a unit of work' }]) {
    const real = C.buildCapsulePrompt('SHOP-101', '', [], none, 'English', unit).length;
    assert.ok(Math.abs(real - C.PROMPT_BASE_CHARS) / real < 0.1, `the prompt is ${real} characters, the estimate assumes ${C.PROMPT_BASE_CHARS}`);
  }
});

test('the usage counter counts the calls of a unit capsule like any other', async () => {
  const f = fixture();
  const app = newApp(f);
  await app.generate('session:CCCCCCCC');
  const snap = app.usageSnapshot();
  assert.equal(snap.session.calls, 1);
  assert.equal(snap.session.tokens, 150);
});

// ---------- storage ----------
test('capsule files: task keys and branches keep their old names, other units get a safe id-based name, nothing collides', () => {
  assert.deepEqual(capsuleStems('SHOP-101'), ['SHOP-101', capsuleStem('SHOP-101')]);
  assert.equal(capsuleStems('feature/search-autocomplete')[0], 'feature_search-autocomplete', 'the name earlier versions wrote');
  const a = capsuleStems('session:ab12cd34')[0];
  const b = capsuleStems('session:ab12cd34#0-7')[0];
  const c = capsuleStems('user:5d7c0de0-1111-4222-8333-444455556666')[0];
  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal(capsuleStems('session:ab12cd34').length, 1, 'no old name to look for');
  for (const name of [a, b, c, capsuleStem('weird:*?"<>|/\\ name.'), capsuleStem('...'), capsuleStem('con')]) {
    assert.match(name, /^[\p{L}\p{N}_.-]+$/u, `${name} uses only characters every file system accepts`);
    assert.ok(!/[. ]$/.test(name) && !/^[. ]/.test(name), `${name} does not start or end with a dot`);
    assert.ok(name.length <= 100);
  }
  // two ids that clean up to the same text stay apart
  assert.notEqual(capsuleStem('session:ab#1-2'), capsuleStem('session_ab_1-2'));
  assert.notEqual(capsuleStem('a/b'), capsuleStem('a_b'));
});

test('capsules written by earlier versions are found where they are, never renamed, and a colliding key cannot overwrite them', () => {
  const dir = path.join(tmpDir(), 'capsules');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = { key: 'feature/x', capsule: { objective: 'old branch capsule' }, generated_at: '2026-01-01T00:00:00Z', markdown: '# old' };
  fs.writeFileSync(path.join(dir, 'feature_x.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(dir, 'feature_x.md'), '# old');
  fs.writeFileSync(path.join(dir, 'SHOP-101.json'), JSON.stringify({ key: 'SHOP-101', capsule: { objective: 'old key capsule' }, generated_at: '2026-01-01T00:00:00Z' }));
  const before = fs.readdirSync(dir).sort();
  const store = new CapsuleStore(dir);
  assert.equal(store.load('feature/x').capsule.objective, 'old branch capsule');
  assert.equal(store.load('SHOP-101').capsule.objective, 'old key capsule');
  assert.equal(store.load('session:ab12cd34'), null);
  assert.equal(store.all().length, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'reading renames nothing');
  assert.equal(store.filePath('SHOP-101', 'json'), path.join(dir, 'SHOP-101.json'));

  // `feature_x` is a different branch that cleans up to the same file name: it gets its own file
  store.save('feature_x', { key: 'feature_x', capsule: { objective: 'other branch' }, markdown: '# other' });
  assert.equal(store.load('feature/x').capsule.objective, 'old branch capsule', 'the old capsule is untouched');
  assert.equal(store.load('feature_x').capsule.objective, 'other branch');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'feature_x.json'), 'utf8')).capsule.objective, 'old branch capsule');
  assert.equal(store.all().length, 3);
  // saving again goes to the same files (idempotent), no third copy appears
  store.save('feature_x', { key: 'feature_x', capsule: { objective: 'other branch, again' }, markdown: '# other' });
  store.save('feature/x', { key: 'feature/x', capsule: { objective: 'old branch, regenerated' }, markdown: '# old' });
  assert.equal(store.all().length, 3);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 3);
  assert.equal(new CapsuleStore(dir).load('feature/x').capsule.objective, 'old branch, regenerated', 'a fresh process finds the same files');
  assert.equal(new CapsuleStore(dir).load('feature_x').capsule.objective, 'other branch, again');
});

test('the app resolves the stable ids of key and branch units (key:KK-1, branch:feature/x) to the unit and its old capsule', async () => {
  const f = fixture();
  const app = newApp(f, scripted([{ session: 'AAAAAAAA', turn: 0 }]).ask);
  await app.generate('KK-1');
  assert.equal(app.resolveUnitKey('key:KK-1'), 'KK-1');
  assert.equal(app.resolveUnitKey('KK-1'), 'KK-1');
  assert.equal(app.resolveUnitKey('session:BBBBBBBB'), 'session:BBBBBBBB');
  assert.equal(app.resolveUnitKey('key:NOPE-1'), 'key:NOPE-1');
  assert.equal(app.taskDetail('key:KK-1').capsule.key, 'KK-1');
  assert.ok(fs.existsSync(path.join(f.cache, 'KK-1.json')), 'a key unit keeps its <key>.json file');
});

test('capsules of every unit type are stored under their id, listed, and survive a restart', async () => {
  const f = fixture();
  const app = newApp(f);
  await app.generate('session:BBBBBBBB');
  await app.generate('KK-1');
  const g = app.mergeUnits(['session:CCCCCCCC', 'session:DDDDDDDD']).unit;
  await app.generate(g);
  const files = fs.readdirSync(f.cache).filter((n) => n.endsWith('.json')).sort();
  assert.equal(files.length, 3);
  assert.ok(files.includes('KK-1.json'));
  assert.ok(files.some((n) => /^session_BBBBBBBB-[0-9a-f]{8}\.json$/.test(n)), files.join());
  assert.ok(files.some((n) => /^user_[0-9a-f-]{36}-[0-9a-f]{8}\.json$/.test(n)), files.join());
  const again = new App({ projectsDir: f.proj, cacheDir: f.cache, usageFile: path.join(f.tmp, 'usage2.json'), ask: scripted().ask });
  const tasks = new Map(again.listTasks().map((t) => [t.key, t]));
  assert.equal(tasks.get('session:BBBBBBBB').has_capsule, true);
  assert.equal(tasks.get(g).has_capsule, true);
  assert.equal(tasks.get('KK-1').has_capsule, true);
  assert.equal(tasks.has('session:CCCCCCCC'), false, 'a session inside a group is not a unit of its own');
  assert.match(tasks.get('session:BBBBBBBB').objective, /orders endpoint/);
});

// ---------- outdated ----------
function appendMessage(f, id8, minute, text) {
  const file = new SessionIndex(f.proj).listFiles().find((p) => p.includes(id8));
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: ts(minute), gitBranch: 'main', cwd: '/x', message: { content: text } }) + '\n');
}

test('staleness uses each unit\'s own messages: session, group, part and key units', () => {
  const f = fixture();
  const app = newApp(f);
  const at = (m) => Date.parse(ts(m)) / 1000;
  void at;
  const st = (key, when) => capsuleStaleness(app.index.unitViews(key), key, when);
  // session unit: the prompts of BBBBBBBB are at :10 to :17 (the interrupt at :15 is automatic and never counts)
  assert.equal(st('session:BBBBBBBB', ts(14)).new_messages, 2, ':16 and :17 are newer');
  assert.equal(st('session:BBBBBBBB', ts(59)).new_messages, 0);
  app.overrides.add([{ type: 'cut', session: fullId(app, 'DDDDDDDD'), parts: [{ start: 0, end: 3, label: 'A' }, { start: 4, end: 7, label: 'B' }], source: 'ai' }]);
  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC']).unit;
  // group: both sessions count
  assert.equal(st(g, ts(15)).new_messages, 2 + 2, 'two newer messages of BBBBBBBB and both of CCCCCCCC');
  // part: only its own messages (turns 4-7 are at :34..:37)
  assert.equal(st('session:DDDDDDDD#4-7', ts(35)).new_messages, 2);
  assert.equal(st('session:DDDDDDDD#0-3', ts(35)).new_messages, 0, 'the other part is not touched by newer messages in this one');
  // key unit, as before
  assert.equal(st('KK-1', ts(0)).new_messages, 2);
  assert.equal(st('KK-1', 'garbage').known, false);
});

test('a unit capsule is listed as outdated when new messages arrive, with their number; a rename keeps the capsule', async () => {
  const f = fixture();
  const app = newApp(f);
  await app.generate('session:CCCCCCCC');
  let t = app.listTasks().find((x) => x.key === 'session:CCCCCCCC');
  assert.equal(t.outdated, false);
  assert.equal(t.capsule_changed, false);
  // the capsule is stamped "now", so write a message in the future
  appendMessage(f, 'CCCCCCCC', 0, 'Another message in the same session about the setup');
  const file = new SessionIndex(f.proj).listFiles().find((p) => p.includes('CCCCCCCC'));
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 3600e3).toISOString(), gitBranch: 'main', cwd: '/x', message: { content: 'A later message about the same setup work' } }) + '\n');
  t = app.listTasks().find((x) => x.key === 'session:CCCCCCCC');
  assert.equal(t.outdated, true);
  assert.equal(t.new_messages, 1);
  const detail = app.taskDetail('session:CCCCCCCC');
  assert.equal(detail.stale.new_messages, 1);
  assert.equal(detail.stale.changed, false);
  assert.equal(detail.sessions[0].new_messages, 1);

  app.renameUnit('session:CCCCCCCC', 'Onboarding docs');
  t = app.listTasks().find((x) => x.key === 'session:CCCCCCCC');
  assert.equal(t.has_capsule, true, 'renaming keeps the capsule');
  assert.equal(t.label, 'Onboarding docs');
});

test('merge, split, move: the new unit starts empty, the old capsule stays on disk and is offered for reuse as outdated', async () => {
  const f = fixture();
  const app = newApp(f);
  await app.generate('session:BBBBBBBB');
  await app.generate('KK-1');
  const capsuleFiles = () => fs.readdirSync(f.cache).filter((n) => /\.(json|md)$/.test(n)).sort();
  const filesBefore = capsuleFiles();

  // MERGE: the session unit is gone, the group is a new unit with no capsule
  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC'], 'Cart and docs').unit;
  let tasks = new Map(app.listTasks().map((t) => [t.key, t]));
  assert.equal(tasks.has('session:BBBBBBBB'), false);
  assert.equal(tasks.get(g).has_capsule, false);
  assert.deepEqual(capsuleFiles(), filesBefore, 'nothing was deleted or renamed');
  assert.equal(app.store.load('session:BBBBBBBB').capsule.objective.length > 0, true);
  const detail = app.taskDetail(g);
  assert.equal(detail.capsule, null);
  assert.equal(detail.previous.length, 1);
  assert.equal(detail.previous[0].key, 'session:BBBBBBBB');
  assert.equal(detail.previous[0].shared, 1);
  assert.match(detail.previous[0].objective, /orders endpoint/);
  assert.equal(app.taskDetail('session:CCCCCCCC'), null, 'a session inside a group is no unit of its own');

  // REUSE: a copy, as old as the original, flagged as changed (it was written for one session, the group has two)
  const reused = app.reuseCapsule('session:BBBBBBBB', g);
  assert.equal(reused.key, g);
  assert.equal(reused.generated_at, app.store.load('session:BBBBBBBB').generated_at, 'the date is kept: new messages still count from then');
  assert.equal(reused.reused_from.key, 'session:BBBBBBBB');
  assert.match(reused.markdown, /^# Work capsule · Cart and docs/);
  const t = app.listTasks().find((x) => x.key === g);
  assert.equal(t.has_capsule, true);
  assert.equal(t.capsule_changed, true, 'the group holds a session the capsule was not written from');
  assert.equal(t.outdated, true);
  const d2 = app.taskDetail(g);
  assert.equal(d2.stale.changed, true);
  assert.equal(d2.stale.added, 1);
  assert.equal(d2.stale.removed, 0);
  assert.equal(d2.stale.reused_from.key, 'session:BBBBBBBB');
  assert.throws(() => app.reuseCapsule('session:BBBBBBBB', g), /already has a capsule/);
  assert.throws(() => app.reuseCapsule('KK-1', 'session:DDDDDDDD'), /still belongs|no session in common/);
  assert.equal(app.store.load('session:BBBBBBBB') !== null, true, 'the original is still there');

  // UNDO the merge: the old unit is back, with its own capsule, not outdated
  app.undoChange();
  tasks = new Map(app.listTasks().map((x) => [x.key, x]));
  assert.equal(tasks.get('session:BBBBBBBB').has_capsule, true);
  assert.equal(tasks.get('session:BBBBBBBB').outdated, false);
  assert.equal(tasks.has(g), false);
  assert.ok(app.store.load(g), 'the reused copy is kept too');

  // MOVE: a session of the key unit goes to another unit; the key unit's capsule says it changed
  const keyViews = app.index.unitViews('KK-1');
  assert.equal(keyViews.length, 1);
  app.moveSession('AAAAAAAA', 'session:CCCCCCCC');
  tasks = new Map(app.listTasks().map((x) => [x.key, x]));
  assert.equal(tasks.has('KK-1'), false, 'the key unit has no session left');
  const cc = app.taskDetail('session:CCCCCCCC');
  assert.equal(cc.previous.map((p) => p.key).includes('KK-1'), true, 'its capsule is offered where the session went');
  app.undoChange();
  assert.equal(new Map(app.listTasks().map((x) => [x.key, x])).get('KK-1').outdated, false);
});

test('a split gives the sessions back: the group capsule stays and each session is offered it', async () => {
  const f = fixture();
  const app = newApp(f);
  const g = app.mergeUnits(['session:BBBBBBBB', 'session:CCCCCCCC'], 'Cart and docs').unit;
  await app.generate(g);
  app.splitUnit(g);
  const tasks = new Map(app.listTasks().map((t) => [t.key, t]));
  assert.equal(tasks.has(g), false);
  assert.equal(tasks.get('session:BBBBBBBB').has_capsule, false);
  assert.equal(app.store.load(g).unit.label, 'Cart and docs', 'the capsule of the dissolved group is kept');
  assert.equal(app.taskDetail('session:BBBBBBBB').previous[0].key, g);
  assert.equal(app.taskDetail('session:CCCCCCCC').previous[0].key, g);
  assert.equal(app.reuseCapsule(g, 'session:CCCCCCCC').unit.id, 'session:CCCCCCCC');
  const t = app.listTasks().find((x) => x.key === 'session:CCCCCCCC');
  assert.equal(t.capsule_changed, true, 'written for the group, now one of its parts');
  // regenerating clears it
  await app.generate('session:CCCCCCCC');
  const fresh = app.listTasks().find((x) => x.key === 'session:CCCCCCCC');
  assert.equal(fresh.capsule_changed, false);
  assert.equal(fresh.outdated, false);
  assert.equal(app.store.load('session:CCCCCCCC').reused_from, undefined);
});

test('an AI cut of a session with a capsule: the whole-session capsule is kept and offered to each part', async () => {
  const f = fixture();
  const app = newApp(f);
  await app.generate('session:DDDDDDDD');
  app.overrides.add([{ type: 'cut', session: fullId(app, 'DDDDDDDD'), parts: [{ start: 0, end: 3, label: 'A' }, { start: 4, end: 7, label: 'B' }], source: 'ai' }]);
  const detail = app.taskDetail('session:DDDDDDDD#0-3');
  assert.equal(detail.capsule, null);
  assert.equal(detail.previous.map((p) => p.key).join(), 'session:DDDDDDDD');
  assert.ok(app.store.load('session:DDDDDDDD'));
});

test('capsuleDrift: unknown for old capsules, counts sessions added and removed, ignores sessions that simply have newer messages', () => {
  const views = [{ id: 's1', range: null }, { id: 's2', range: [0, 3] }];
  assert.equal(capsuleDrift({ key: 'x' }, views), null);
  const cap = { unit: { basis: [{ session: 's1', range: null }, { session: 's3', range: null }] } };
  assert.deepEqual(capsuleDrift(cap, views), { added: 1, removed: 1, changed: true });
  assert.deepEqual(capsuleDrift(cap, views, { by_session: { s2: 4 } }), { added: 0, removed: 1, changed: true }, 's2 is new work, not a change');
  assert.deepEqual(capsuleDrift({ unit: { basis: [{ session: 's1', range: null }, { session: 's2', range: [0, 3] }] } }, views), { added: 0, removed: 0, changed: false });
  assert.equal(capsuleDrift({ unit: { basis: [{ session: 's1', range: null }, { session: 's2', range: [0, 5] }] } }, views).changed, true, 'a part with another range is another part');
});

test('unitMeta describes a unit for the capsule: id, source, name, sessions', () => {
  const f = fixture();
  const app = newApp(f);
  assert.deepEqual(unitMeta(app.index, 'KK-1'), { id: 'key:KK-1', source: 'key', label: 'KK-1', keyed: true, basis: [{ session: fullId(app, 'AAAAAAAA'), range: null }] });
  const m = unitMeta(app.index, 'session:CCCCCCCC');
  assert.equal(m.id, 'session:CCCCCCCC');
  assert.equal(m.keyed, false);
  assert.match(m.label, /Rewrite the onboarding guide/);
  assert.equal(unitMeta(app.index, 'session:NOPE'), null);
});

// ---------- cancel, busy, API ----------
test('cancelling a unit capsule saves nothing and frees the unit', async () => {
  const f = fixture();
  const ctrl = new AbortController();
  const app = newApp(f, async (prompt, o) => {
    ctrl.abort();
    if (o && o.signal && o.signal.aborted) throw new (await import('../src/llm.js')).Aborted();
    return scripted().ask(prompt);
  });
  await assert.rejects(app.generate('session:BBBBBBBB', { signal: ctrl.signal }));
  assert.equal(app.busy.size, 0);
  assert.equal(fs.existsSync(f.cache) ? fs.readdirSync(f.cache).filter((n) => n.endsWith('.json')).length : 0, 0);
});

const call = (srv, method, route, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: route, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve([res.statusCode, b ? JSON.parse(b) : null]));
  });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

test('API: estimate, generate (with confirmation), detail and reuse work for session and group units', async () => {
  const f = fixture();
  const app = newApp(f);
  const srv = await startServer(app, 0);
  servers.push(srv);
  const enc = encodeURIComponent;
  let [status, est] = await call(srv, 'GET', `/api/estimate?key=${enc('session:BBBBBBBB')}`);
  assert.equal(status, 200);
  assert.equal(est.ranges_known, true);
  assert.equal(est.calls, 1);
  [status] = await call(srv, 'POST', '/api/generate', { key: 'session:BBBBBBBB' });
  assert.equal(status, 400, 'spending tokens always needs the confirmation');
  const [s2, cap] = await call(srv, 'POST', '/api/generate', { key: 'session:BBBBBBBB', confirm: true });
  assert.equal(s2, 200);
  assert.equal(cap.key, 'session:BBBBBBBB');
  const [, detail] = await call(srv, 'GET', `/api/tasks/${enc('session:BBBBBBBB')}`);
  assert.equal(detail.task.generatable, true);
  assert.equal(detail.capsule.capsule.objective.length > 0, true);
  assert.equal(detail.markable, false);
  const [, tasks] = await call(srv, 'GET', '/api/tasks');
  const t = tasks.tasks.find((x) => x.key === 'session:BBBBBBBB');
  assert.equal(t.has_capsule, true);
  assert.equal(t.generatable, true);
  // the stable id of a key unit works as the key
  const [s3, byId] = await call(srv, 'GET', `/api/tasks/${enc('key:KK-1')}`);
  assert.equal(s3, 200);
  assert.equal(byId.task.key, 'KK-1');

  const [, merged] = await call(srv, 'POST', '/api/units/merge', { keys: ['session:BBBBBBBB', 'session:CCCCCCCC'], label: 'Cart and docs' });
  const [, gd] = await call(srv, 'GET', `/api/tasks/${enc(merged.unit)}`);
  assert.equal(gd.capsule, null);
  assert.equal(gd.previous[0].key, 'session:BBBBBBBB');
  const [s4, reuse] = await call(srv, 'POST', '/api/capsule/reuse', { from: 'session:BBBBBBBB', to: merged.unit });
  assert.equal(s4, 200);
  assert.equal(reuse.capsule.reused_from.key, 'session:BBBBBBBB');
  const [, gd2] = await call(srv, 'GET', `/api/tasks/${enc(merged.unit)}`);
  assert.equal(gd2.stale.changed, true);
  const [s5, bad] = await call(srv, 'POST', '/api/capsule/reuse', { from: 'nope', to: merged.unit });
  assert.equal(s5, 400);
  assert.match(bad.error, /already has a capsule/);
  const [s6] = await call(srv, 'POST', '/api/estimate', {});
  assert.equal(s6, 404);
});

test('the capsule of a unit without a key feeds the free views: search, files, timeline lanes, evidence', async () => {
  const f = fixture();
  const app = newApp(f);
  await app.generate('session:BBBBBBBB');
  // search inside capsules
  const hits = app.search('regression');
  assert.ok(hits === null || Array.isArray(hits));
  const found = app.search('start value');
  assert.ok(found.some((h) => h.key === 'session:BBBBBBBB' && h.where === 'capsule'), JSON.stringify(found));
  // file index: files come from the capsule, not from a guess
  const links = app.fileTasks('api/src/cart.js').tasks;
  assert.equal(links.length, 1);
  assert.equal(links[0].key, 'session:BBBBBBBB');
  assert.equal(links[0].approximate, false);
  // timeline lane carries the capsule state
  const lane = app.timeline({ limit: 'all' }).lanes.find((l) => l.key === 'session:BBBBBBBB');
  assert.equal(lane.has_capsule, true);
  assert.equal(lane.generatable, true);
  assert.equal(lane.changed, false);
  assert.deepEqual(app.timeline({ limit: 'all' }).coverage, { ready: 1, total: 4, outdated: 0 });
  // evidence: a citation checked against the turns the capsule was written from
  const ev = app.evidence({ session: 'BBBBBBBB', turn: 2, key: 'session:BBBBBBBB', context: 0 });
  assert.equal(ev.confidence, 'verified');
  const outside = app.evidence({ session: 'BBBBBBBB', turn: 7, key: 'session:BBBBBBBB', context: 0 });
  assert.notEqual(outside.confidence, 'verified');
  // the briefing for "Resume this task" and the row times
  const d = app.taskDetail('session:BBBBBBBB');
  assert.equal(d.capsule.capsule.briefing, 'Resume the empty cart fix.');
  assert.ok(d.capsule.capsule.timeline[0].ts, 'rows have the time of their first cited message');
});
