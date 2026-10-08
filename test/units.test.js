import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SessionIndex } from '../src/tasks.js';
import { DEFAULT_KEY_REGEX } from '../src/config.js';
import { UNASSIGNED } from '../src/sessions.js';
import {
  MIN_WORDS, TITLE_MAX, buildUnits, cutTitle, emptyState, foldOps, hasContent, meaningfulText, relatedUnits, sessionTitle, shortIds, stripTags, wordCount,
} from '../src/units.js';
import { makeSession, tmpDir } from './helpers.js';

const at = (h, m = 0, d = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

// ---------- what counts as a real message ----------
test('meaningfulText drops editor tags, slash commands, greetings, "resume" and anything under four words', () => {
  assert.equal(meaningfulText('hola'), '');
  assert.equal(meaningfulText('Hi there!'), '');
  assert.equal(meaningfulText('resume'), '');
  assert.equal(meaningfulText('ok thanks'), '');
  assert.equal(meaningfulText('/code-review high'), '');
  assert.equal(meaningfulText('/clear'), '');
  assert.equal(meaningfulText('<ide_opened_file>The user opened /x/README.md in the IDE.</ide_opened_file>'), '');
  assert.equal(meaningfulText('[Request interrupted by user]'), '');
  assert.equal(meaningfulText('   '), '');
  assert.equal(meaningfulText('tienes el contexto?'), '', 'three words is not a task');
});

test('meaningfulText keeps the real request, also when it follows an editor tag or a command', () => {
  assert.equal(meaningfulText('Fix the checkout total rounding bug please'), 'Fix the checkout total rounding bug please');
  assert.equal(
    meaningfulText('<ide_opened_file>The user opened /x/a.js</ide_opened_file> Refactor the cart module to use integer cents'),
    'Refactor the cart module to use integer cents',
  );
  assert.equal(meaningfulText('/review please check the payment retry logic carefully'), 'please check the payment retry logic carefully');
  assert.equal(meaningfulText('/Users/me/app/src/cart.js has a rounding bug, can you fix it?'), '/Users/me/app/src/cart.js has a rounding bug, can you fix it?', 'a path is not a command');
  assert.equal(meaningfulText('Hola, necesito que revises el módulo de pagos y encuentres el error'), 'Hola, necesito que revises el módulo de pagos y encuentres el error');
  assert.equal(wordCount('a1b2 c3 12 34'), 2, 'only words with a letter count');
  assert.equal(MIN_WORDS, 4);
});

test('cutTitle cuts at a word, adds an ellipsis and never exceeds 80 characters', () => {
  const long = 'Please investigate why the checkout total is sometimes one cent higher than the cart total and fix it';
  const t = cutTitle(long);
  assert.ok(t.length <= TITLE_MAX, t.length);
  assert.ok(t.endsWith('…'));
  assert.ok(!t.slice(0, -1).endsWith(' '));
  assert.equal(cutTitle('short  title \n here'), 'short title here');
  assert.equal(cutTitle('x'.repeat(200)).length, TITLE_MAX);
});

test('sessionTitle: Claude Code title first, then the first meaningful message (redacted), else null', () => {
  assert.equal(sessionTitle({ title: 'Investigate flaky test', prompts: [{ text: 'whatever something longer here' }] }), 'Investigate flaky test');
  assert.equal(sessionTitle({ prompts: [{ text: 'hola' }, { text: '<ide_opened_file>x</ide_opened_file>' }, { text: 'Add pagination to the products endpoint now' }] }), 'Add pagination to the products endpoint now');
  const secret = sessionTitle({ prompts: [{ text: 'Rotate the key sk-abcdefghijklmnopqrstuvwxyz in the config file please' }] });
  assert.ok(!secret.includes('sk-abcdefghijklmnop'), secret);
  assert.equal(sessionTitle({ prompts: [{ text: 'hola' }, { text: 'resume' }] }), null);
  assert.equal(sessionTitle({ title: 'x'.repeat(300), prompts: [] }).length, TITLE_MAX);
});

test('hasContent: a title or a meaningful message among the first 12 is content; greetings and tags are not', () => {
  assert.equal(hasContent({ prompts: [{ text: 'hola' }] }), false);
  assert.equal(hasContent({ prompts: [{ text: '/code-review' }, { text: 'resume' }] }), false);
  assert.equal(hasContent({ prompts: [{ text: 'Write tests for the pagination edge cases' }] }), true);
  assert.equal(hasContent({ title: 'Named by Claude', prompts: [{ text: 'hola' }] }), true);
  const late = Array.from({ length: 12 }, () => ({ text: 'hola' })).concat([{ text: 'A real request that comes far too late' }]);
  assert.equal(hasContent({ prompts: late }), false, 'only the first 12 messages are looked at');
});

// ---------- units out of sessions ----------
function fixture() {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA-1111', [[at(9), 'KK-1 fix the rounding bug', 'ok'], [at(10), 'KK-1 more work on the fix', 'ok']], { branch: 'fix/KK-1-x' });
  makeSession(proj, 'BBBBBBBB-2222', [[at(11), 'Investigate why the orders endpoint fails on empty carts', 'ok']], { branch: 'main', proj: 'p2', cwd: '/x/api' });
  makeSession(proj, 'CCCCCCCC-3333', [[at(12), 'hola', 'ok']], { branch: 'main', proj: 'p3', cwd: '/x/docs' });
  makeSession(proj, 'DDDDDDDD-4444', [[at(13), 'autocomplete work for the search box please', 'ok']], { branch: 'feature/autocomplete', proj: 'p4', cwd: '/x/ui' });
  return proj;
}

test('units: a session with no key and a generic branch is its OWN unit (never lumped), with a title; greetings are noise', () => {
  const idx = new SessionIndex(fixture());
  const tasks = idx.tasks();
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  assert.deepEqual([...byKey.keys()].sort(), ['KK-1', 'feature/autocomplete', 'session:BBBBBBBB', 'session:CCCCCCCC']);
  assert.equal(byKey.get('KK-1').source, 'key');
  assert.equal(byKey.get('KK-1').id, 'key:KK-1');
  assert.equal(byKey.get('feature/autocomplete').id, 'branch:feature/autocomplete');
  const real = byKey.get('session:BBBBBBBB');
  assert.equal(real.id, 'session:BBBBBBBB');
  assert.equal(real.label, 'Investigate why the orders endpoint fails on empty carts');
  assert.equal(real.noise, false);
  assert.equal(real.unsorted, true);
  assert.equal(real.generatable, undefined, 'generatable is decided by the app layer');
  assert.equal(byKey.get('session:CCCCCCCC').noise, true);
  assert.equal(byKey.get('session:CCCCCCCC').label, null, 'no meaningful message: the page writes its own fallback title');
  assert.ok(!byKey.has(UNASSIGNED), '"unassigned" no longer exists');
});

test('unit ids stay the same across rescans and when new sessions arrive', () => {
  const proj = fixture();
  const idx = new SessionIndex(proj);
  const before = idx.tasks().map((t) => t.id).sort();
  makeSession(proj, 'EEEEEEEE-5555', [[at(15), 'A brand new unrelated piece of work to do', 'ok']], { branch: 'main', proj: 'p5', cwd: '/x/new' });
  const after = idx.tasks().map((t) => t.id).sort();
  assert.deepEqual(after.filter((id) => before.includes(id)), before, 'nothing that existed changed its id');
  assert.deepEqual(after.filter((id) => !before.includes(id)), ['session:EEEEEEEE']);
  assert.deepEqual(new SessionIndex(proj).tasks().map((t) => t.id).sort(), after, 'a fresh index gives the same ids');
});

test('shortIds: 8 characters, longer only for sessions that collide', () => {
  const ids = shortIds([{ id: 'abcdef0123-A' }, { id: 'abcdef0123-B' }, { id: 'zzzzzzzz-1' }]);
  assert.equal(ids.get('zzzzzzzz-1'), 'zzzzzzzz');
  assert.notEqual(ids.get('abcdef0123-A'), ids.get('abcdef0123-B'));
  assert.ok(ids.get('abcdef0123-A').length > 8);
});

test('moving a session puts it ONLY in the new unit; an unknown target sends it back home', () => {
  const idx = new SessionIndex(fixture());
  const sessions = idx.sessions();
  const sid = sessions.find((s) => s.id.startsWith('BBBBBBBB')).id;
  const st = foldOps([{ id: '1', type: 'move', session: sid, to: 'feature/autocomplete' }]);
  const { units } = buildUnits(sessions, st, { keyRegex: DEFAULT_KEY_REGEX });
  assert.ok(!units.has('session:BBBBBBBB'), 'its own unit disappears');
  assert.equal(units.get('feature/autocomplete').members.length, 2);
  const view = units.get('feature/autocomplete').members.find(([v]) => v.id === sid)[0];
  assert.equal(view.key, 'feature/autocomplete', 'read as part of the new unit (all its messages count)');
  const orphan = foldOps([{ id: '1', type: 'move', session: sid, to: 'user:gone' }]);
  assert.ok(buildUnits(sessions, orphan, { keyRegex: DEFAULT_KEY_REGEX }).units.has('session:BBBBBBBB'), 'the target does not exist: back to its own unit');
});

test('merging units makes one user unit and hides the members; splitting brings them back', () => {
  const idx = new SessionIndex(fixture());
  const sessions = idx.sessions();
  const merged = foldOps([{ id: '1', type: 'merge', unit: 'user:u1', members: ['session:BBBBBBBB', 'feature/autocomplete'], label: 'API and UI' }]);
  const a = buildUnits(sessions, merged, { keyRegex: DEFAULT_KEY_REGEX }).units;
  assert.ok(!a.has('session:BBBBBBBB') && !a.has('feature/autocomplete'));
  const u = a.get('user:u1');
  assert.equal(u.source, 'user');
  assert.equal(u.members.length, 2);
  assert.equal(u.defaultLabel, 'API and UI');
  assert.deepEqual(u.mergedFrom.sort(), ['feature/autocomplete', 'session:BBBBBBBB']);
  const split = foldOps([
    { id: '1', type: 'merge', unit: 'user:u1', members: ['session:BBBBBBBB', 'feature/autocomplete'] },
    { id: '2', type: 'split', unit: 'user:u1' },
  ]);
  const b = buildUnits(sessions, split, { keyRegex: DEFAULT_KEY_REGEX }).units;
  assert.ok(b.has('session:BBBBBBBB') && b.has('feature/autocomplete') && !b.has('user:u1'));
});

test('hidden sessions and units are left out; renames win over the automatic label; undone operations are ignored', () => {
  const idx = new SessionIndex(fixture());
  const sessions = idx.sessions();
  const sid = sessions.find((s) => s.id.startsWith('BBBBBBBB')).id;
  const hid = foldOps([{ id: '1', type: 'hide', session: sid }, { id: '2', type: 'hide', unit: 'KK-1' }]);
  const { units, hiddenSessions } = buildUnits(sessions, hid, { keyRegex: DEFAULT_KEY_REGEX });
  assert.ok(!units.has('session:BBBBBBBB'));
  assert.equal(hiddenSessions.length, 1);
  assert.equal(units.get('KK-1').hidden, true);
  const undone = foldOps([{ id: '1', type: 'hide', unit: 'KK-1', undone: true }]);
  assert.equal(buildUnits(sessions, undone, { keyRegex: DEFAULT_KEY_REGEX }).units.get('KK-1').hidden, false);
  const renamed = foldOps([{ id: '1', type: 'rename', unit: 'KK-1', label: '  Rounding  bug ' }]);
  assert.equal(buildUnits(sessions, renamed, { keyRegex: DEFAULT_KEY_REGEX }).units.get('KK-1').label, 'Rounding  bug');
  const reset = foldOps([{ id: '1', type: 'rename', unit: 'KK-1', label: 'x' }, { id: '2', type: 'rename', unit: 'KK-1', label: '' }]);
  assert.equal(reset.labels.has('KK-1'), false, 'an empty name goes back to the automatic one');
  assert.equal(emptyState().moves.size, 0);
});

test('foldOps skips malformed operations instead of failing', () => {
  const st = foldOps([null, 7, { type: 'rename' }, { type: 'merge', unit: 'user:x', members: 'nope' }, { type: 'move', session: 5, to: 'x' }, { type: 'bogus' }, { id: 'ok', type: 'hide', unit: 'KK-1' }]);
  assert.deepEqual([...st.hiddenUnits], ['KK-1']);
  assert.equal(st.merges.size + st.moves.size + st.labels.size, 0);
});

// ---------- "Related" is a hint, never a grouping ----------
test('related: same repo and a message within 2 hours, nearest first, at most two; never a different repo', () => {
  const H = 3600000;
  const items = [
    { key: 'a', label: 'A', project: 'api', times: [0] },
    { key: 'b', label: 'B', project: 'api', times: [1.5 * H] },
    { key: 'c', label: 'C', project: 'api', times: [5 * H] },
    { key: 'd', label: 'D', project: 'api', times: [0.5 * H] },
    { key: 'e', label: 'E', project: 'api', times: [1 * H] },
    { key: 'x', label: 'X', project: 'docs', times: [0] },
  ];
  const r = relatedUnits(items);
  assert.deepEqual(r.get('a').map((x) => x.key), ['d', 'e'], 'nearest two');
  assert.ok(!r.has('c'), 'five hours away from everything');
  assert.ok(!r.has('x'), 'another repo is never related');
  assert.deepEqual(relatedUnits([{ key: 'p', label: 'P', project: 'api', times: [0, 10 * H] }, { key: 'q', label: 'Q', project: 'api', times: [9.5 * H] }]).get('p').map((x) => x.key), ['q'], 'any message close enough counts');
});

test('the index reports related session units and does not group them', () => {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA-1', [[at(10), 'Add pagination to the products endpoint now', 'ok']], { branch: 'main', cwd: '/x/api' });
  makeSession(proj, 'BBBBBBBB-2', [[at(11, 20), 'Write tests for the pagination edge cases here', 'ok']], { branch: 'main', cwd: '/x/api' });
  makeSession(proj, 'CCCCCCCC-3', [[at(11, 30), 'Rewrite the onboarding guide for new developers', 'ok']], { branch: 'main', cwd: '/x/docs', proj: 'docs' });
  const tasks = new SessionIndex(proj).tasks();
  assert.equal(tasks.length, 3, 'nothing is merged');
  const a = tasks.find((t) => t.key === 'session:AAAAAAAA');
  assert.deepEqual(a.related.map((r) => r.key), ['session:BBBBBBBB']);
  assert.equal(tasks.find((t) => t.key === 'session:CCCCCCCC').related.length, 0);
});

test('extra ignored branches count as generic: their sessions stay separate units', () => {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA-1', [[at(10), 'Work on something entirely different today', 'ok']], { branch: 'staging', cwd: '/x/api' });
  assert.deepEqual(new SessionIndex(proj).tasks().map((t) => t.key), ['staging'], 'by default a named branch is a task');
  assert.deepEqual(new SessionIndex(proj, DEFAULT_KEY_REGEX, { genericBranches: ['staging'] }).tasks().map((t) => t.key), ['session:AAAAAAAA']);
});

test('a session with several real messages and a Claude title uses the title', () => {
  const proj = tmpDir();
  const file = makeSession(proj, 'AAAAAAAA-1', [[at(10), 'first long message about something', 'ok']], { branch: 'main' });
  fs.writeFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Named by Claude Code' }) + '\n' + fs.readFileSync(file, 'utf8'));
  assert.equal(new SessionIndex(proj).tasks()[0].label, 'Named by Claude Code');
  assert.ok(path.basename(file).startsWith('AAAAAAAA'));
});

test('stripTags removes editor tags and their content; the card snippet never shows them', () => {
  assert.equal(stripTags('<ide_opened_file>The user opened /x/a.js</ide_opened_file>'), '');
  assert.equal(stripTags('<ide_opened_file>x</ide_opened_file>  Fix the   bug <b>now</b>'), 'Fix the bug now');
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA-1', [[at(10), '<ide_opened_file>The user opened /x/a.js</ide_opened_file> Refactor the cart module to use integer cents', 'ok']], { branch: 'main' });
  makeSession(proj, 'BBBBBBBB-2', [[at(11), '<ide_opened_file>The user opened /x/README.md</ide_opened_file>', 'ok']], { branch: 'main', proj: 'p2' });
  const tasks = new SessionIndex(proj).tasks();
  assert.equal(tasks.find((t) => t.key === 'session:AAAAAAAA').snippet, 'Refactor the cart module to use integer cents');
  const note = tasks.find((t) => t.key === 'session:BBBBBBBB');
  assert.equal(note.snippet, '', 'an editor note has no message: the page writes its own label');
  assert.equal(note.noise, true);
});
