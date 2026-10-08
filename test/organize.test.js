import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.js';
import { Aborted } from '../src/llm.js';
import {
  MAX_BATCH_CHARS, OrganizeStore, buildPrompt, makeBatches, sessionDigest, validateAnswer,
} from '../src/organize.js';
import { startServer } from '../src/server.js';
import { buildUnits, cleanParts, emptyState, foldOps } from '../src/units.js';
import { makeSession, tmpDir } from './helpers.js';

const at = (h, m = 0, d = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const META = { cost_usd: 0.01, input_tokens: 1000, output_tokens: 200 };

/** Four unsorted sessions (two about the same work, one unrelated, one long that mixes two jobs) + a session without content. */
function fixture(extra = {}) {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'projects');
  makeSession(proj, 'S1AAAAAA-0001', [
    [at(9), 'Add pagination to the orders list endpoint please', 'ok', [['Edit', { file_path: '/x/api/src/orders.js' }, null]]],
    [at(9, 20), 'The pagination needs a limit and an offset parameter', 'ok'],
    [at(9, 40), 'Now write the tests for the pagination of orders', 'ok'],
  ], { proj: 'api', cwd: '/x/api' });
  makeSession(proj, 'S2BBBBBB-0002', [
    [at(10, 0, 10), 'Continue the orders pagination work from yesterday', 'ok'],
    [at(10, 20, 10), 'Handle an offset larger than the number of orders', 'ok'],
    [at(10, 40, 10), 'Document the pagination parameters in the readme', 'ok'],
  ], { proj: 'api', cwd: '/x/api' });
  makeSession(proj, 'S3CCCCCC-0003', [
    [at(14, 0, 11), 'Why does the checkout test fail only on the CI server', 'ok'],
    [at(14, 30, 11), 'Try pinning the node version in the workflow file', 'ok'],
  ], { proj: 'web', cwd: '/x/web' });
  const long = [];
  for (let i = 0; i < 8; i++) long.push([at(8, i * 5, 12), `Fix typo number ${i} in the documentation of the install guide`, 'ok']);
  for (let i = 0; i < 8; i++) long.push([at(11, i * 5, 12), `Add an in memory cache for the price lookup step ${i} please`, 'ok', i === 0 ? [['Edit', { file_path: '/x/docs/cache.js' }, null]] : []]);
  makeSession(proj, 'S4DDDDDD-0004', long, { proj: 'docs', cwd: '/x/docs' });
  makeSession(proj, 'S5EEEEEE-0005', [[at(15, 0, 12), 'hola', 'ok']], { proj: 'misc', cwd: '/x/misc' });
  if (extra.secret) makeSession(proj, 'S6FFFFFF-0006', [[at(16, 0, 12), 'Rotate the key password=hunter2 used by the billing job today', 'sk-abcdefghijklmnopqrstuvwx is the old one']], { proj: 'billing', cwd: '/x/billing' });
  return { tmp, proj, cache: path.join(tmp, 'cache') };
}

const shortsOf = (prompt) => [...prompt.matchAll(/^SESSION (\S+) \|/gm)].map((m) => m[1]);

/** A model that answers in a fixed way for the fixture above and records every call. */
function fakeOrganizer(log, answer) {
  return async (prompt, opts = {}) => {
    if (opts.signal && opts.signal.aborted) throw new Aborted();
    log.push(prompt);
    const ids = shortsOf(prompt);
    const full = answer || {
      titles: ids.map((id) => ({ session: id, title: `Title of ${id}` })),
      groups: [{ sessions: ['S1AAAAAA', 'S2BBBBBB'], title: 'Orders pagination', reason: 'Both continue the pagination of the orders endpoint.', confidence: 'high', evidence: [{ session: 'S1AAAAAA', turn: 0 }, { session: 'S2BBBBBB', turn: 0 }] }],
      splits: [{ session: 'S4DDDDDD', reason: 'It switches from documentation typos to a cache.', parts: [
        { start: 0, end: 7, title: 'Docs typos', evidence: [{ session: 'S4DDDDDD', turn: 2 }] },
        { start: 8, end: 15, title: 'Price cache', evidence: [{ session: 'S4DDDDDD', turn: 9 }] },
      ] }],
    };
    return [JSON.stringify(full), META];
  };
}

function makeApp(fx, ask) {
  return new App({ projectsDir: fx.proj, cacheDir: fx.cache, usageFile: path.join(fx.tmp, 'usage.json'), ask });
}

// ---------- what the model reads ----------
test('the skeleton is redacted, short, has message numbers and files, and never carries the assistant text', () => {
  const fx = fixture({ secret: true });
  const app = makeApp(fx, async () => { throw new Error('no call'); });
  const eligible = app.organizer.eligible();
  const s6 = eligible.find((e) => e.short === 'S6FFFFFF');
  assert.ok(s6, 'a session with content is eligible');
  assert.ok(!s6.digest.text.includes('hunter2') && !s6.digest.text.includes('sk-abcdefghijklmnopqrstuvwx'), s6.digest.text);
  assert.match(s6.digest.text, /\[REDACTED\]/);
  assert.ok(!s6.digest.text.includes('old one'), 'assistant text is never sent');
  const s1 = eligible.find((e) => e.short === 'S1AAAAAA').digest;
  assert.match(s1.text, /^SESSION S1AAAAAA \| repo=api /);
  assert.match(s1.text, /files: .*orders\.js/);
  assert.match(s1.text, /\nt0 09:00 \| Add pagination/);
  assert.equal(eligible.some((e) => e.short === 'S5EEEEEE'), false, 'a session without content is not sent');
  assert.equal(s1.long, false);
  assert.equal(eligible.find((e) => e.short === 'S4DDDDDD').digest.long, true);
});

test('batches stay under the size limit and keep sessions in time order', () => {
  const fake = (n, len) => Array.from({ length: n }, (_, i) => ({ first: `2026-01-${String(i + 1).padStart(2, '0')}`, digest: { text: 'x'.repeat(len) } }));
  const batches = makeBatches(fake(10, Math.floor(MAX_BATCH_CHARS / 3)));
  assert.ok(batches.length > 1);
  for (const b of batches) assert.ok(b.reduce((n, x) => n + x.digest.text.length, 0) <= MAX_BATCH_CHARS);
  assert.deepEqual(batches.flat().map((x) => x.first), fake(10, 1).map((x) => x.first));
  assert.match(buildPrompt([{ digest: { text: 'SESSION a | x' } }], { titlesOnly: true }), /Give each session a clear title/);
});

// ---------- strict validation ----------
function ctx() {
  const mk = (short, turns, shown, long = false) => ({ id: `${short}-full`, short, shown: new Set(shown), turns, real: turns, realIdx: [...Array(turns).keys()], long });
  const list = [mk('aaaaaaaa', 4, [0, 1, 3]), mk('bbbbbbbb', 3, [0, 1, 2]), mk('cccccccc', 20, [0, 1, 2, 10, 19], true), mk('dddddddd', 3, [0, 1, 2])];
  return new Map(list.map((d) => [d.short, d]));
}

test('validation drops invented sessions and message numbers, and groups without evidence in two sessions', () => {
  const r = validateAnswer({
    groups: [
      { sessions: ['aaaaaaaa', 'bbbbbbbb'], title: 'Same work', reason: 'r', confidence: 'high', evidence: [{ session: 'aaaaaaaa', turn: 0 }, { session: 'bbbbbbbb', turn: 1 }] },
      { sessions: ['aaaaaaaa', 'zzzzzzzz'], title: 'Invented id', evidence: [{ session: 'aaaaaaaa', turn: 0 }] },
      { sessions: ['cccccccc', 'dddddddd'], title: 'One side only', evidence: [{ session: 'cccccccc', turn: 0 }, { session: 'dddddddd', turn: 99 }] },
      { sessions: ['cccccccc', 'dddddddd'], title: 'Not shown turn', evidence: [{ session: 'cccccccc', turn: 5 }, { session: 'dddddddd', turn: 0 }] },
    ],
  }, ctx());
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].title, 'Same work');
  assert.deepEqual(r.proposals[0].sessions, ['aaaaaaaa-full', 'bbbbbbbb-full']);
  assert.equal(r.dropped, 3);
});

test('a session joins a group only if it has evidence of its own, and a session is in at most one group', () => {
  const r = validateAnswer({
    groups: [
      { sessions: ['aaaaaaaa', 'bbbbbbbb', 'dddddddd'], title: 'Three', confidence: 'medium', evidence: [{ session: 'aaaaaaaa', turn: 0 }, { session: 'bbbbbbbb', turn: 0 }] },
      { sessions: ['aaaaaaaa', 'dddddddd'], title: 'Overlaps', evidence: [{ session: 'aaaaaaaa', turn: 0 }, { session: 'dddddddd', turn: 0 }] },
    ],
  }, ctx());
  assert.equal(r.proposals.length, 1);
  assert.deepEqual(r.proposals[0].shorts, ['aaaaaaaa', 'bbbbbbbb'], 'the member without evidence did not join');
});

test('a cut needs a long session, non-overlapping ranges and evidence INSIDE each range', () => {
  const part = (s, e, t, turn) => ({ start: s, end: e, title: t, evidence: [{ session: 'cccccccc', turn }] });
  const ok = validateAnswer({ splits: [{ session: 'cccccccc', reason: 'two jobs', parts: [part(0, 9, 'First job', 1), part(10, 19, 'Second job', 19)] }] }, ctx());
  assert.equal(ok.proposals.length, 1);
  assert.deepEqual(ok.proposals[0].parts.map((p) => [p.start, p.end]), [[0, 9], [10, 19]]);
  const overlap = validateAnswer({ splits: [{ session: 'cccccccc', parts: [part(0, 10, 'A', 1), part(10, 19, 'B', 19)] }] }, ctx());
  assert.equal(overlap.proposals.length, 0, 'overlapping ranges are rejected as a whole');
  const outside = validateAnswer({ splits: [{ session: 'cccccccc', parts: [part(0, 9, 'A', 10), part(10, 19, 'B', 19)] }] }, ctx());
  assert.equal(outside.proposals.length, 0, 'the evidence of a range lies outside it: the range is dropped, one range is not a cut');
  const beyond = validateAnswer({ splits: [{ session: 'cccccccc', parts: [part(0, 9, 'A', 1), part(10, 25, 'B', 19)] }] }, ctx());
  assert.equal(beyond.proposals.length, 0, 'a range beyond the last message is dropped');
  const short = validateAnswer({ splits: [{ session: 'aaaaaaaa', parts: [part(0, 1, 'A', 0), part(2, 3, 'B', 3)].map((p) => ({ ...p, evidence: [{ session: 'aaaaaaaa', turn: p.evidence[0].turn }] })) }] }, ctx());
  assert.equal(short.proposals.length, 0, 'a short session is never cut');
});

test('titles: empty ones, invented sessions, names the user chose and unchanged names give no proposal', () => {
  const r = validateAnswer({
    titles: [
      { session: 'aaaaaaaa', title: 'A good title' }, { session: 'aaaaaaaa', title: 'Second for the same session' },
      { session: 'bbbbbbbb', title: '' }, { session: 'nope', title: 'Whatever' }, { session: 'cccccccc', title: 'User chose a name' }, { session: 'dddddddd', title: 'Same Title!' },
    ],
  }, ctx(), { renamed: new Set(['cccccccc']), current: new Map([['dddddddd', 'same title']]) });
  assert.deepEqual(r.proposals.map((p) => p.title), ['A good title']);
});

test('the same proposal gets the same id whatever the title, so a rejected one is recognised later', () => {
  const body = (title) => ({ groups: [{ sessions: ['aaaaaaaa', 'bbbbbbbb'], title, evidence: [{ session: 'aaaaaaaa', turn: 0 }, { session: 'bbbbbbbb', turn: 0 }] }] });
  assert.equal(validateAnswer(body('One'), ctx()).proposals[0].id, validateAnswer(body('Another'), ctx()).proposals[0].id);
});

// ---------- the run: estimate, cache, cancel ----------
test('estimate tells the cost first, and a run over the same sessions is never asked twice', async () => {
  const fx = fixture();
  const log = [];
  const app = makeApp(fx, fakeOrganizer(log));
  const e = app.organizeEstimate({});
  assert.equal(e.cached, false);
  assert.ok(e.calls >= 1 && e.usd > 0 && e.input_tokens > 0 && e.sessions === 4, JSON.stringify(e));
  assert.equal(log.length, 0, 'an estimate calls nothing');
  const first = await app.organize({});
  assert.equal(log.length, 1);
  assert.equal(first.cached, false);
  assert.ok(first.proposals.length >= 3);
  assert.equal(app.usageSnapshot().session.calls, 1, 'the call is counted');
  const again = await app.organize({});
  assert.equal(log.length, 1, 'same sessions: no second call');
  assert.equal(again.cached, true);
  const e2 = app.organizeEstimate({});
  assert.equal(e2.cached, true);
  assert.equal(e2.usd, 0);
  assert.ok(e2.usd_if_again > 0);
  await app.organize({ force: true });
  assert.equal(log.length, 2, 'force asks again');
  makeSession(fx.proj, 'S7GGGGGG-0007', [[at(17, 0, 12), 'A brand new unrelated piece of work to look at', 'ok']], { proj: 'new', cwd: '/x/new' });
  assert.equal(app.organizeEstimate({}).cached, false, 'a new session changes the input');
});

test('the cache survives a restart (the proposals and what was asked are stored on disk)', async () => {
  const fx = fixture();
  const log = [];
  await makeApp(fx, fakeOrganizer(log)).organize({});
  const app2 = makeApp(fx, fakeOrganizer(log));
  assert.ok(app2.organizeProposals().proposals.length >= 3);
  await app2.organize({});
  assert.equal(log.length, 1, 'a new process does not ask again');
});

test('cancelling stops the call, saves no proposal and leaves the app free to run again', async () => {
  const fx = fixture();
  const log = [];
  const app = makeApp(fx, fakeOrganizer(log));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => app.organize({}, { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(app.organizeProposals().proposals.length, 0);
  assert.equal(app.organizer.busy, false);
  const events = [];
  await app.organize({}, { emit: (e) => events.push(e) });
  assert.deepEqual(events.find((e) => e.type === 'start').stages, ['org_scan', 'org_ask', 'org_validate', 'org_save']);
  assert.ok(events.some((e) => e.type === 'stage' && e.id === 'org_save' && e.status === 'done'));
  assert.ok(events.some((e) => e.type === 'log' && e.code === 'organize_proposal'));
});

test('an answer that cannot be read changes nothing and is not remembered as done', async () => {
  const fx = fixture();
  let n = 0;
  const app = makeApp(fx, async () => { n += 1; return ['this is not json', META]; });
  await assert.rejects(() => app.organize({}), /could not be read/);
  assert.equal(app.organizeProposals().proposals.length, 0);
  assert.equal(app.organizeEstimate({}).cached, false);
  assert.equal(n, 1);
});

test('"Name with AI" asks for a title only, for one session', async () => {
  const fx = fixture();
  const log = [];
  const app = makeApp(fx, async (prompt, o) => { log.push(prompt); return [JSON.stringify({ titles: [{ session: 'S1AAAAAA', title: 'Orders pagination endpoint' }] }), META]; });
  const full = app.index.sessions().find((s) => s.id.startsWith('S1AAAAAA')).id;
  const e = app.organizeEstimate({ sessions: [full], titlesOnly: true });
  assert.equal(e.sessions, 1);
  const res = await app.organize({ sessions: [full], titlesOnly: true });
  assert.match(log[0], /Give each session a clear title/);
  assert.doesNotMatch(log[0], /"groups"/);
  assert.deepEqual(res.proposals.map((p) => [p.type, p.title]), [['title', 'Orders pagination endpoint']]);
});

// ---------- the lifecycle of a proposal ----------
test('accepting a title renames the unit through the corrections (source ai) and Undo brings the proposal back', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const p = app.organizeProposals().proposals.find((x) => x.type === 'title' && x.sessions[0].short === 'S3CCCCCC');
  assert.ok(p, 'there is a title proposal for S3CCCCCC');
  const res = app.acceptProposal(p.id);
  assert.ok(res.ok && res.undo);
  const unit = app.listTasks().find((t) => t.key === 'session:S3CCCCCC');
  assert.equal(unit.label, 'Title of S3CCCCCC');
  assert.equal(unit.ai, true, 'labelled AI-organized');
  assert.ok(app.overrides.ops().some((o) => o.source === 'ai' && o.proposal === p.id));
  assert.equal(app.organizeProposals().proposals.some((x) => x.id === p.id), false, 'no longer pending');
  app.undoChange(res.undo.batch);
  assert.equal(app.listTasks().find((t) => t.key === 'session:S3CCCCCC').ai, false);
  assert.ok(app.organizeProposals().proposals.some((x) => x.id === p.id), 'undone: it can be reviewed again');
});

test('the user can edit the title when accepting, and a name the user chose is never overwritten by a later proposal', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const p = app.organizeProposals().proposals.find((x) => x.type === 'title' && x.sessions[0].short === 'S3CCCCCC');
  app.acceptProposal(p.id, { title: '  CI failure   hunt ' });
  assert.equal(app.listTasks().find((t) => t.key === 'session:S3CCCCCC').label, 'CI failure hunt');
  app.renameUnit('session:S3CCCCCC', 'My own name');
  await app.organize({ force: true });
  assert.equal(app.organizeProposals().proposals.some((x) => x.type === 'title' && x.sessions[0].short === 'S3CCCCCC'), false, 'no title proposal over the user name');
  assert.equal(app.listTasks().find((t) => t.key === 'session:S3CCCCCC').label, 'My own name');
});

test('rejecting is remembered: the proposal does not come back after another run or a restart', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const g = app.organizeProposals().proposals.find((x) => x.type === 'group');
  app.rejectProposal(g.id);
  assert.equal(app.organizeProposals().proposals.some((x) => x.id === g.id), false);
  await app.organize({ force: true });
  assert.equal(app.organizeProposals().proposals.some((x) => x.id === g.id), false, 'same proposal again: still rejected');
  const app2 = makeApp(fx, fakeOrganizer([]));
  assert.equal(app2.organizeProposals().proposals.some((x) => x.id === g.id), false, 'rejection persisted');
  assert.throws(() => app2.acceptProposal(g.id), /not available/);
});

test('accepting a group joins the sessions into one AI-organized unit; Undo separates them again', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const g = app.organizeProposals().proposals.find((x) => x.type === 'group');
  assert.deepEqual(g.sessions.map((s) => s.short), ['S1AAAAAA', 'S2BBBBBB']);
  assert.ok(g.evidence.every((e) => e.quote), 'the evidence carries the message it points at');
  const res = app.acceptProposal(g.id);
  const joined = app.listTasks().find((t) => t.kind === 'user');
  assert.equal(joined.label, 'Orders pagination');
  assert.equal(joined.sessions, 2);
  assert.equal(joined.ai, true);
  assert.equal(app.listTasks().some((t) => t.key === 'session:S1AAAAAA'), false);
  app.undoChange(res.undo.batch);
  assert.equal(app.listTasks().some((t) => t.key === 'session:S1AAAAAA'), true);
  assert.equal(app.listTasks().some((t) => t.kind === 'user'), false);
});

test('accepting a cut makes each range its own unit with its own messages; Undo restores the session', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const sp = app.organizeProposals().proposals.find((x) => x.type === 'split');
  assert.deepEqual(sp.parts.map((x) => [x.start, x.end]), [[0, 7], [8, 15]]);
  const res = app.acceptProposal(sp.id);
  const parts = app.listTasks().filter((t) => t.range);
  assert.deepEqual(parts.map((t) => t.key).sort(), ['session:S4DDDDDD#0-7', 'session:S4DDDDDD#8-15']);
  const docs = parts.find((t) => t.range[0] === 0);
  assert.equal(docs.label, 'Docs typos');
  assert.equal(docs.ai, true);
  assert.equal(docs.prompts, 8);
  assert.deepEqual(docs.session_ids, [], 'a message range cannot be moved as a session');
  assert.equal(app.listTasks().some((t) => t.key === 'session:S4DDDDDD'), false);
  const detail = app.taskDetail('session:S4DDDDDD#8-15');
  assert.deepEqual(detail.sessions[0].range, [8, 15]);
  const msgs = app.sessionMessages({ key: 'session:S4DDDDDD#8-15', session: 'S4DDDDDD' });
  assert.equal(msgs.total, 8);
  assert.ok(msgs.messages.every((m) => m.turn >= 8 && m.turn <= 15));
  assert.ok(msgs.messages[0].text.includes('cache'));
  const other = app.sessionMessages({ key: 'session:S4DDDDDD#0-7', session: 'S4DDDDDD' });
  assert.ok(other.messages.every((m) => m.turn <= 7));
  app.undoChange(res.undo.batch);
  assert.equal(app.listTasks().some((t) => t.key === 'session:S4DDDDDD'), true);
  assert.equal(app.listTasks().some((t) => t.range), false);
});

test('"accept all high-confidence" is one change: a single Undo reverts all of it', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const before = app.organizeProposals().proposals.length;
  const res = app.acceptProposals('high');
  assert.equal(res.accepted, 1, 'only the group says high; titles and cuts are medium');
  assert.ok(app.organizeProposals().proposals.length < before, 'the group and the titles of the sessions it joined are no longer pending');
  assert.equal(app.overrides.ops().filter((o) => !o.undone && o.source === 'ai').length, 1);
  assert.throws(() => app.acceptProposals('high'), /nothing to accept/i, 'nothing high is left');
  app.undoChange(res.undo.batch);
  assert.equal(app.organizeProposals().proposals.length, before);
});

test('a proposal stops applying when the user already moved or hid its sessions', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const g = app.organizeProposals().proposals.find((x) => x.type === 'group');
  const full = g.sessions[0].id;
  app.hideSession(full);
  assert.equal(app.organizeProposals().proposals.some((x) => x.id === g.id), false);
  assert.throws(() => app.acceptProposal(g.id), /not available|no longer applies/);
});

test('user corrections still win: a cut session that is then merged by hand keeps the user merge', async () => {
  const fx = fixture();
  const app = makeApp(fx, fakeOrganizer([]));
  await app.organize({});
  const sp = app.organizeProposals().proposals.find((x) => x.type === 'split');
  app.acceptProposal(sp.id);
  const res = app.mergeUnits(['session:S4DDDDDD#0-7', 'session:S4DDDDDD#8-15'], 'Whole thing again');
  const user = app.listTasks().find((t) => t.kind === 'user');
  assert.equal(user.label, 'Whole thing again');
  assert.equal(user.sessions, 1, 'two ranges of one session are that session again');
  assert.equal(user.prompts, 16, 'the whole session, not one range');
  assert.equal(user.range, null);
  app.undoChange(res.undo.batch);
  assert.equal(app.listTasks().filter((t) => t.range).length, 2, 'Undo gives the two ranges back');
});

// ---------- the store ----------
test('a damaged store file is moved aside and the app starts clean', () => {
  const tmp = tmpDir();
  const file = path.join(tmp, 'organize.json');
  fs.writeFileSync(file, '{ not json');
  const store = new OrganizeStore(file);
  assert.deepEqual(store.all(), []);
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('organize.json.corrupt-')));
  store.upsert([{ id: 'p1', type: 'title', sessions: ['s1'], title: 'x' }], new Set(['s1']));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).proposals.p1.status, 'pending');
});

test('a new run replaces pending proposals about the same sessions but never revives accepted or rejected ones', () => {
  const store = new OrganizeStore(null);
  store.upsert([{ id: 'a', type: 'title', sessions: ['s1'] }, { id: 'b', type: 'title', sessions: ['s2'] }], new Set(['s1', 's2']));
  store.setStatus('b', 'rejected');
  store.upsert([{ id: 'c', type: 'title', sessions: ['s1'] }, { id: 'b', type: 'title', sessions: ['s2'] }], new Set(['s1', 's2']));
  assert.deepEqual(store.all().map((p) => [p.id, p.status]).sort(), [['b', 'rejected'], ['c', 'pending']]);
});

// ---------- cuts as corrections ----------
test('cleanParts refuses overlapping, reversed or too few ranges, and foldOps ignores a bad cut', () => {
  assert.equal(cleanParts([{ start: 0, end: 5 }, { start: 5, end: 9 }]), null);
  assert.equal(cleanParts([{ start: 3, end: 1 }, { start: 5, end: 9 }]), null);
  assert.equal(cleanParts([{ start: 0, end: 5 }]), null);
  assert.deepEqual(cleanParts([{ start: 6, end: 9, label: ' B ' }, { start: 0, end: 5, label: 'A' }]).map((p) => [p.start, p.end, p.label]), [[0, 5, 'A'], [6, 9, 'B']]);
  const st = foldOps([{ id: '1', type: 'cut', session: 's1', parts: [{ start: 0, end: 5 }, { start: 3, end: 9 }] }, { id: '2', type: 'cut', session: 's2', parts: [{ start: 0, end: 5 }, { start: 6, end: 9 }], source: 'ai' }, { id: '3', type: 'cut', session: 's3', undone: true, parts: [{ start: 0, end: 5 }, { start: 6, end: 9 }] }]);
  assert.deepEqual([...st.cuts.keys()], ['s2']);
});

test('buildUnits: a cut session becomes one unit per range plus the stretches in between; a session moved by the user is not cut', () => {
  const s = { id: 'abcd1234-0000', key: 'unassigned', project: 'p', branch: '', n_prompts: 12, mentions: {}, has_content: true, unit_title: 'whole', first_ts: 'a', last_ts: 'b' };
  const view = (sess, a, b) => (b - a < 1 ? null : { ...sess, range: [a, b], n_prompts: b - a + 1, has_content: true, unit_title: `msgs ${a}-${b}` });
  const st = emptyState();
  st.cuts.set(s.id, [{ start: 4, end: 7, label: 'Middle job' }]);
  const { units } = buildUnits([s], st, { keyRegex: '\\b[A-Z]{2,5}-\\d+\\b', rangeView: view, turnCount: () => 12 });
  assert.deepEqual([...units.keys()], ['session:abcd1234#0-3', 'session:abcd1234#4-7', 'session:abcd1234#8-11']);
  assert.equal(units.get('session:abcd1234#4-7').sessionTitle, 'Middle job');
  assert.equal(units.get('session:abcd1234#4-7').ai, true);
  assert.equal(units.get('session:abcd1234#0-3').ai, false);
  const moved = emptyState();
  moved.cuts.set(s.id, [{ start: 4, end: 7, label: 'x' }]);
  moved.moves.set(s.id, 'user:u1');
  moved.merges.set('user:u1', { members: [], label: 'G' });
  const m = buildUnits([s], moved, { keyRegex: '\\b[A-Z]{2,5}-\\d+\\b', rangeView: view, turnCount: () => 12 });
  assert.deepEqual([...m.units.keys()], ['user:u1'], 'moving the whole session wins over the cut');
});

// ---------- the HTTP API ----------
function call(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; } resolve([res.statusCode, j, t]); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('the API: confirmation, JSON and local-only checks, estimate, streamed run, accept and reject', async () => {
  const fx = fixture();
  const log = [];
  const app = makeApp(fx, fakeOrganizer(log));
  const srv = await startServer(app, 0);
  try {
    const p = srv.port;
    assert.equal((await call(p, 'POST', '/api/organize', { confirm: true }, { Origin: 'http://evil.example' }))[0], 403);
    assert.equal((await call(p, 'POST', '/api/organize', { confirm: true }, { Host: 'evil.example' }))[0], 403);
    assert.equal((await call(p, 'POST', '/api/organize', 'confirm=true', { 'Content-Type': 'application/x-www-form-urlencoded' }))[0], 415);
    assert.equal((await call(p, 'POST', '/api/organize', {}))[0], 400, 'spending needs the explicit confirmation');
    assert.equal((await call(p, 'POST', '/api/organize/accept', 'x=1', { 'Content-Type': 'text/plain' }))[0], 415);
    assert.equal((await call(p, 'POST', '/api/organize/accept', { id: 'x' }, { Origin: 'http://evil.example' }))[0], 403);
    assert.equal((await call(p, 'GET', '/api/organize'))[0], 404, 'running is never a GET');
    assert.equal(log.length, 0, 'nothing above reached the model');

    const [, est] = await call(p, 'GET', '/api/organize/estimate');
    assert.equal(est.cached, false);
    assert.equal(est.sessions, 4);
    assert.equal(log.length, 0);
    assert.equal((await call(p, 'GET', '/api/organize/proposals'))[1].proposals.length, 0);

    const [code, , text] = await call(p, 'POST', '/api/organize', { confirm: true }, { Accept: 'application/x-ndjson' });
    assert.equal(code, 200);
    const events = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events[0].type, 'start');
    assert.deepEqual(events[0].stages, ['org_scan', 'org_ask', 'org_validate', 'org_save']);
    const done = events.find((e) => e.type === 'done');
    assert.ok(done.result.proposals.length >= 3 && done.result.usage.calls === 1);
    assert.equal(log.length, 1);

    const [, listed] = await call(p, 'GET', '/api/organize/proposals');
    const title = listed.proposals.find((x) => x.type === 'title');
    const [ac, accepted] = await call(p, 'POST', '/api/organize/accept', { id: title.id, title: 'Edited over HTTP' });
    assert.equal(ac, 200);
    assert.ok(accepted.undo.batch);
    assert.equal((await call(p, 'POST', '/api/organize/accept', { id: title.id }))[0], 400, 'it is not pending any more');
    const grp = listed.proposals.find((x) => x.type === 'group');
    assert.equal((await call(p, 'POST', '/api/organize/reject', { id: grp.id }))[0], 200);
    assert.equal((await call(p, 'POST', '/api/organize/reject', { id: 'nope' }))[0], 400);
    assert.equal((await call(p, 'POST', '/api/organize/accept-all', { confidence: 'high' }))[0], 400, 'nothing high is left');
    assert.equal((await call(p, 'POST', '/api/organize/nope', {}))[0], 404);
    const [, tasks] = await call(p, 'GET', '/api/tasks');
    assert.ok(tasks.tasks.some((t) => t.label === 'Edited over HTTP' && t.ai));
  } finally {
    srv.server.close();
  }
});

test('digests are cached per file version and follow the file when it grows', () => {
  const fx = fixture();
  const app = makeApp(fx, async () => { throw new Error('no call'); });
  const e = app.organizer.eligible().find((x) => x.short === 'S1AAAAAA');
  const again = sessionDigest(e.s, e.short, app.keyRegex);
  assert.equal(again, e.digest, 'same object: it came from the cache');
  const file = e.s.path;
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: at(10, 0), gitBranch: 'main', cwd: '/x/api', message: { content: 'One more message about the same pagination work' } }) + '\n');
  const grown = sessionDigest(e.s, e.short, app.keyRegex);
  assert.notEqual(grown, e.digest);
  assert.equal(grown.turns, e.digest.turns + 1);
});
