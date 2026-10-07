import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, test } from 'node:test';
import { App } from '../src/app.js';
import { WEB_ASSETS, startServer } from '../src/server.js';
import { indexHtml, jsFiles, WEB } from './web_assets.js';
import { tmpDir } from './helpers.js';

// ---- the html`` helper, loaded from the shipped web/js/core.js ----
const ctx = vm.createContext({ document: {}, window: {}, fetch() {}, location: {}, localStorage: {} });
vm.runInContext(fs.readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8'), ctx);
const run = (code) => vm.runInContext(code, ctx);

test('html`` escapes interpolated values by default', () => {
  assert.equal(String(run('html`<p>${"<b>&\\"\'"}</p>`')), '<p>&lt;b&gt;&amp;&quot;&#39;</p>');
  assert.equal(String(run('html`<i>${0}${null}${undefined}${false}${"x"}</i>`')), '<i>0x</i>');
});

test('raw() and nested html`` are not escaped twice; arrays are joined', () => {
  assert.equal(String(run('html`<div>${raw("<b>ok</b>")}</div>`')), '<div><b>ok</b></div>');
  assert.equal(String(run('html`<ul>${["a", "<"].map((x) => html`<li>${x}</li>`)}</ul>`')), '<ul><li>a</li><li>&lt;</li></ul>');
  assert.equal(String(run('html`<ul>${["<a>", raw("<b>")]}</ul>`')), '<ul>&lt;a&gt;<b></ul>');
});

test('esc() still escapes the five HTML characters', () => {
  assert.equal(run('esc(`<>&"\'`)'), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(run('esc(null)'), '');
});

// ---- every web script parses on its own ----
test('every web/js file is valid JavaScript and is whitelisted by the server', () => {
  for (const f of jsFiles) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), { filename: f }), f);
    assert.ok(WEB_ASSETS[`/js/${f}`], `${f} must be listed in WEB_ASSETS`);
  }
});

test('index.html loads the split assets, in order, and has no inline style or script left', () => {
  assert.match(indexHtml, /<link rel="stylesheet" href="\/app\.css">/);
  const srcs = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, Object.keys(WEB_ASSETS).filter((r) => r.startsWith('/js/')));
  assert.equal(srcs[0], '/js/core.js');
  assert.equal(srcs.at(-1), '/js/main.js');
  assert.doesNotMatch(indexHtml, /<style|<script>/);
});

// ---- the server ----
let srv;
before(async () => {
  const tmp = tmpDir();
  const app = new App({ projectsDir: path.join(tmp, 'projects'), cacheDir: path.join(tmp, 'cache'), usageFile: path.join(tmp, 'usage.json'), ask: async () => '{}' });
  srv = await startServer(app, 0);
});
after(() => srv.server.close());

const get = (route, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.port, path: route, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], nosniff: res.headers['x-content-type-options'], body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});

test('server serves each web asset with the right content type', async () => {
  for (const [route, [file, type]] of Object.entries(WEB_ASSETS)) {
    const r = await get(route);
    assert.equal(r.status, 200, route);
    assert.equal(r.type, type, route);
    assert.equal(r.nosniff, 'nosniff', route);
    assert.equal(r.body, fs.readFileSync(path.join(WEB, file), 'utf8'), route);
  }
});

test('server only serves whitelisted files: traversal, other web files and unknown paths are refused', async () => {
  for (const p of ['/js/../strings.en.json', '/js/%2e%2e/strings.en.json', '/..%2fpackage.json', '/js/nope.js', '/strings.en.json', '/index.html', '/js/', '/__proto__', '/constructor']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(r.body, /"name": "taskrecap"|skip_link/, p);
  }
});

test('assets keep the local-host protection', async () => {
  const r = await get('/app.css', { Host: 'evil.example.com' });
  assert.equal(r.status, 403);
});
