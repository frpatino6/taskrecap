import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { WEB } from './web_assets.js';

// ---- web/js/prompt.js (markdown + file paths of a prompt), loaded on top of core.js like the browser does ----
const ctx = vm.createContext({ document: {}, window: {}, fetch() {}, location: {}, localStorage: {} });
for (const f of ['core.js', 'prompt.js']) vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), ctx);
const call = (fn, ...args) => { ctx.__a = args; return vm.runInContext(`${fn}(...__a)`, ctx); };
const render = (text, files) => call('renderMarkdown', text, files ? call('fileResolver', files) : null);
const paths = (text) => [...call('findPaths', text)].map((p) => p.path);

test('findPaths: absolute, home, relative and bare file names, with :line', () => {
  assert.deepEqual(paths('see /Users/x/app/src/a.js and ~/notes/b.md, then src/foo.js:12:3.'), ['/Users/x/app/src/a.js', '~/notes/b.md', 'src/foo.js']);
  assert.deepEqual(paths('open ./docs/x.md or ../y/z.ts and index.js'), ['./docs/x.md', '../y/z.ts', 'index.js']);
  assert.equal(call('findPaths', 'a src/foo.js:12.')[0].text, 'src/foo.js:12');
});

test('findPaths: ordinary words, versions, dates and urls are not paths', () => {
  assert.deepEqual(paths('hello world, v1.2.3 on 2026-10-09 at 10:30 e.g. fine'), []);
});

test('fileResolver: exact or unique whole-segment match; ambiguous or unknown is null', () => {
  const r = (files, p) => call('fileResolver', files)(p);
  assert.equal(r(['src/a.js', 'docs/x.md'], 'src/a.js'), 'src/a.js');
  assert.equal(r(['src/a.js'], '/Users/x/app/src/a.js'), 'src/a.js');
  assert.equal(r(['src/a.js'], './src/a.js'), 'src/a.js');
  assert.equal(r(['src/a.js', 'lib/src/a.js'], 'src/a.js'), 'src/a.js');
  assert.equal(r(['x/index.js', 'y/index.js'], 'index.js'), null);
  assert.equal(r(['src/a.js'], 'src/b.js'), null);
  assert.equal(r(['src/a.js'], 'rc/a.js'), null);
  assert.equal(r([], 'src/a.js'), null);
});

test('renderMarkdown: only the task files become links; everything else stays text', () => {
  const html = render('edit src/a.js:4 and src/other.js, also `src/a.js`', ['src/a.js']);
  assert.match(html, /<button class="filelink" type="button" data-file="src\/a\.js" title="src\/a\.js">src\/a\.js:4<\/button>/);
  assert.match(html, /<code>src\/a\.js<\/code><\/button>/);
  assert.match(html, /<button class="filelink unknown" type="button" data-file="src\/other\.js" title="src\/other\.js">src\/other\.js<\/button>, /);
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.doesNotMatch(render('edit src/a.js'), /<button/); // no resolver: no links
});

test('renderMarkdown: unknown paths are link-styled, plain words and bare names are not', () => {
  const html = render('open ~/proj/lib/x.ts:3, `./docs/y.md`, node.js and and/or', ['src/a.js']);
  assert.match(html, /class="filelink unknown" type="button" data-file="proj\/lib\/x\.ts"/);
  assert.match(html, /data-file="docs\/y\.md" title="docs\/y\.md"><code>/);
  assert.equal((html.match(/<button/g) || []).length, 2);
});

test('renderMarkdown: blocks', () => {
  assert.equal(render('# Title\n\ntext\nnext'), '<h4 class="mdh">Title</h4><p>text<br>next</p>');
  assert.equal(render('- a\n- b\n  more\n\n1. x\n2) y'), '<ul><li>a</li><li>b<br>more</li></ul><ol><li>x</li><li>y</li></ol>');
  assert.equal(render('> q1\n> q2'), '<blockquote>q1<br>q2</blockquote>');
  assert.equal(render('---'), '<hr>');
  assert.equal(render('```js\nlet a = "<b>" **x**\n```\nafter'), '<pre><code>let a = &quot;&lt;b&gt;&quot; **x**</code></pre><p>after</p>');
  assert.match(render('```\nno end\nsrc/a.js'), /^<pre><code>no end\nsrc\/a\.js<\/code><\/pre>$/);
  assert.match(render('| a | b |\n|---|:-:|\n| 1 | **2** |'), /<th>a<\/th><th>b<\/th>.*<td>1<\/td><td><strong>2<\/strong><\/td>/);
});

test('renderMarkdown: paths inside fenced code are linked too', () => {
  assert.match(render('```\nsrc/a.js\n```', ['src/a.js']), /<button/);
});

test('renderMarkdown: inline styles and links', () => {
  assert.equal(render('**b** *i* `c` [t](https://e.com/x?a=1&b=2) https://e.com.'), '<p><strong>b</strong> <em>i</em> <code>c</code> <a href="https://e.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">t</a> <a href="https://e.com" target="_blank" rel="noopener noreferrer">https://e.com</a>.</p>');
  assert.match(render('[m](mailto:a@b.co)'), /<a href="mailto:a@b\.co"/);
});

test('renderMarkdown: escapes HTML and refuses unsafe link schemes', () => {
  const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.com) [w](https://e.com/"onmouseover="a)');
  assert.doesNotMatch(html, /<script|<img|href="javascript|href="data|href="\/\/|onmouseover="/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)/);
  assert.equal(render('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
  assert.doesNotMatch(render('| <i> |\n|--|\n| <b> |'), /<i>|<b>/);
  const evil = render('see src/a"onclick="x.js', ['src/a"onclick="x.js']);
  assert.doesNotMatch(evil, /data-file="[^"]*"[^>]*onclick="/);
});

test('renderMarkdown: empty and odd input does not throw or loop', () => {
  assert.equal(render(''), '');
  assert.equal(render(null), '');
  assert.equal(render('\n\n  \n'), '');
  assert.doesNotThrow(() => render('*\n**\n`\n[\n](\n|\n> \n- \n#\n~~~'));
  assert.doesNotThrow(() => render('a'.repeat(50000) + ' ' + '/a'.repeat(5000)));
});

test('paths with dot dirs, absolute paths and quotes link as known or unknown; urls stay urls', () => {
  const html = render('see .claude/commands/x.md, (/Users/q/app/src/a.js:3) and "docs/y.md" at https://x.com/a/b.js', ['src/a.js']);
  assert.match(html, /data-file="\.claude\/commands\/x\.md"/);
  assert.match(html, /class="filelink" type="button" data-file="src\/a\.js"/);
  assert.match(html, /class="filelink unknown" type="button" data-file="docs\/y\.md"/);
  assert.match(html, /<a href="https:\/\/x\.com\/a\/b\.js"/);
  assert.equal((html.match(/<button/g) || []).length, 3);
});

test('paths inside fenced code are linked and escaped; bare names with a known extension are unknown links', () => {
  const html = render('```\ncat src/a.js <b>\n```\nedit index.js and node.js', ['src/a.js']);
  assert.match(html, /<pre><code>cat <button class="filelink" type="button" data-file="src\/a\.js"[^>]*>src\/a\.js<\/button> &lt;b&gt;<\/code><\/pre>/);
  assert.match(html, /data-file="index\.js"/);
  assert.doesNotMatch(html, /data-file="node\.js"/);
});

test('plainHtml links paths inside a command and escapes the rest', () => {
  const html = call('plainHtml', 'git add src/a.js "<x>"', call('fileResolver', ['src/a.js']));
  assert.match(html, /^git add <button class="filelink" type="button" data-file="src\/a\.js"[^>]*>src\/a\.js<\/button> &quot;&lt;x&gt;&quot;$/);
});
