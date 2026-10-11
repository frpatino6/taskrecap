import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeInline, inlineAssets, jsonForScript } from '../tools/snapshot.js';

test('escapeInline neutralises closing tags of the given element only', () => {
  assert.equal(escapeInline('a</script>b</SCRIPT>', 'script'), 'a<\\/script>b<\\/SCRIPT>');
  assert.equal(escapeInline('x</style>', 'script'), 'x</style>');
});

test('jsonForScript never emits a literal "<" and round-trips', () => {
  const v = { a: '</script><!--', b: 'xy' };
  const s = jsonForScript(v);
  assert.ok(!s.includes('<') && !s.includes(''));
  assert.deepEqual(JSON.parse(s), v);
});

test('inlineAssets leaves no external references and puts the fetch stub first', () => {
  const page = '<link rel="stylesheet" href="/app.css">\n<script src="/js/core.js"></script>\n<script src="/js/main.js"></script>\n';
  const out = inlineAssets(page, 'b{}', { core: 'var a="</script>";', main: 'var b=1;' }, { '/api/info': { title: 'T' } });
  assert.ok(!out.includes('/app.css') && !out.includes('src="/js'));
  assert.ok(out.indexOf('window.fetch') < out.indexOf('var a='));
  assert.ok(out.includes('<style>'));
  assert.equal(out.match(/<\/script>/g).length, 3); // stub + 2 scripts: the one inside the JS was escaped
});
