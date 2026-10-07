import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapsuleSearch, capsuleSections, fold, highlightRanges, queryWords, snippetOf } from '../src/search.js';
import { CapsuleStore } from '../src/tasks.js';
import { tmpDir } from './helpers.js';

const result = (key, capsule, extra = {}) => ({ key, capsule: { timeline: [], decisions: [], dead_ends: [], left_out: [], pending: [], briefing: '', ...capsule }, files: [], commits: { confirmed: [], possible: [] }, markdown: '', ...extra });
const task = (key, snippet = '', projects = ['app']) => ({ key, projects, snippet });

function fixture() {
  const store = new CapsuleStore(tmpDir());
  store.save('KK-1', result('KK-1', {
    objective: 'Fix the checkout rounding',
    decisions: [{ decision: 'Use integer cents everywhere', why: 'floats drift in sums', cites: [] }],
    pending: [{ text: 'Test the sale coupon path', cites: [] }],
    briefing: 'Resume the cart work. Mention of zebra stripes here.',
  }, { files: [{ short: 'app/src/cart/total.js', status: 'final', edits: 2 }], commits: { confirmed: [{ hash: 'abc1234', branch: 'fix/KK-1', msg: 'KK-1: integer cents' }], possible: [] } }));
  store.save('KK-3', result('KK-3', { objective: 'Zebra crossing page', decisions: [{ decision: 'Decisión sobre la cebra', why: 'señal clara', cites: [] }] }));
  return { store, search: new CapsuleSearch(store) };
}

test('fold ignores case and accents and never changes the length of the text', () => {
  assert.equal(fold('Decisión Ñandú'), 'decision nandu');
  for (const s of ['Straße', 'İstanbul', 'ÀÉÎÕÜ ✨ 日本', 'éx']) assert.equal(fold(s).length, s.length, s);
  assert.deepEqual(queryWords('  Cents   FLOATS '), ['cents', 'floats']);
});

test('free search looks inside capsule sections and says where it matched, with the words highlighted', () => {
  const { search } = fixture();
  const hits = search.search('cents', [task('KK-1', 'fix thing'), task('KK-2', 'unrelated')]);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.key, 'KK-1');
  assert.equal(h.where, 'capsule');
  assert.equal(h.section, 'decisions');
  assert.ok(h.excerpt.toLowerCase().includes('cents'));
  assert.ok(h.highlights.length >= 1);
  for (const [a, b] of h.highlights) assert.equal(h.excerpt.slice(a, b).toLowerCase(), 'cents');
});

test('every word must be present (literal AND), in any section of the capsule', () => {
  const { search } = fixture();
  const tasks = [task('KK-1'), task('KK-3')];
  assert.equal(search.search('cents floats', tasks).length, 1); // decision + why
  assert.equal(search.search('cents coupon', tasks).length, 1); // decisions + pending: different sections
  assert.equal(search.search('cents unicorn', tasks).length, 0);
  assert.deepEqual(search.search('', tasks), null);
  assert.deepEqual(search.search('   ', tasks), null);
});

test('accents and case do not matter, in the query or in the capsule', () => {
  const { search } = fixture();
  const hits = search.search('DECISION cebra senal', [task('KK-3')]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, 'KK-3');
  assert.equal(search.search('decisión', [task('KK-3')])[0].section, 'decisions');
});

test('tasks are ranked by BM25: an objective match beats a mention buried in the briefing', () => {
  const { search } = fixture();
  const hits = search.search('zebra', [task('KK-1'), task('KK-3')]);
  assert.deepEqual(hits.map((h) => h.key), ['KK-3', 'KK-1']);
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(hits[1].section, 'briefing');
});

test('a task without a capsule is found only by key, repos and first prompt', () => {
  const { search } = fixture();
  const tasks = [task('KK-2', 'migrate the database', ['billing']), task('KK-1')];
  const byKey = search.search('KK-2', tasks);
  assert.deepEqual(byKey.map((h) => [h.key, h.where]), [['KK-2', 'task']]);
  assert.equal(search.search('billing', tasks)[0].where, 'task');
  assert.equal(search.search('database', tasks)[0].key, 'KK-2');
  assert.equal(search.search('rounding', tasks).map((h) => h.key).join(), 'KK-1'); // capsule text; KK-2 has none
  assert.deepEqual(search.coverage(tasks), { capsules: 1, other_tasks: 1 });
});

test('files and commits of a capsule are searchable too', () => {
  const { search } = fixture();
  assert.equal(search.search('total.js', [task('KK-1')])[0].section, 'files');
  assert.equal(search.search('abc1234', [task('KK-1')])[0].section, 'commits');
});

test('the index follows capsule writes and deletions without being rebuilt by hand', () => {
  const { store, search } = fixture();
  const tasks = [task('KK-1'), task('KK-9')];
  assert.equal(search.search('quokka', tasks).length, 0);
  store.save('KK-9', result('KK-9', { objective: 'Quokka feature' }));
  assert.deepEqual(search.search('quokka', tasks).map((h) => h.key), ['KK-9']);
  store.save('KK-9', result('KK-9', { objective: 'Wombat feature' }));
  assert.equal(search.search('quokka', tasks).length, 0);
  assert.equal(search.search('wombat', tasks).length, 1);
});

test('snippetOf cuts the original text around the first match and reports truncation', () => {
  const text = `${'lorem '.repeat(30)}Needle in the haystack ${'ipsum '.repeat(40)}`;
  const section = { id: 'objective', weight: 1, text, folded: fold(text) };
  const { excerpt, highlights, truncated } = snippetOf(section, ['needle']);
  assert.deepEqual(truncated, [true, true]);
  const [[a, b]] = highlights;
  assert.equal(excerpt.slice(a, b), 'Needle');
  assert.deepEqual(snippetOf(section, ['absent']), { excerpt: '', highlights: [] });
  assert.deepEqual(highlightRanges('aaa bbb aaa', ['aaa', 'a']), [[0, 3], [8, 11]]);
});

test('capsuleSections skips empty sections and tolerates a capsule without files or commits', () => {
  const secs = capsuleSections({ key: 'X', capsule: { objective: 'Only this' } });
  assert.deepEqual(secs.map((s) => s.id), ['objective']);
  assert.deepEqual(capsuleSections(null), []);
});
