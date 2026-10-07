import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, test } from 'node:test';
import { App, listLangs, loadStrings } from '../src/app.js';
import { startServer } from '../src/server.js';
import { js, WEB } from './web_assets.js';
import { tmpDir } from './helpers.js';

const readStrings = (code) => JSON.parse(fs.readFileSync(path.join(WEB, `strings.${code}.json`), 'utf8'));
const en = readStrings('en'), es = readStrings('es');
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// ---- translations ----
test('es has exactly the same keys as en, in the same order', () => {
  assert.deepEqual(Object.keys(es), Object.keys(en));
});

test('es keeps every {placeholder} of its en string, and no string is empty', () => {
  for (const k of Object.keys(en)) {
    assert.ok(String(es[k]).trim(), `${k} is empty`);
    assert.deepEqual(placeholders(es[k]), placeholders(en[k]), `${k}: placeholders differ`);
  }
});

test('each language names itself and the model language matches', () => {
  assert.equal(en.lang_name, 'English');
  assert.equal(es.lang_name, 'Español');
  assert.equal(es.llm_language, 'Spanish');
});

test('the Spanish file keeps the no-emoji rule of the English one', () => {
  assert.doesNotMatch(JSON.stringify(es), /[\u{1F300}-\u{1FAFF}✨]/u);
});

test('listLangs finds en first and es, and loadStrings merges over English', () => {
  assert.deepEqual(listLangs().map((l) => l.code).slice(0, 2), ['en', 'es']);
  assert.equal(listLangs().find((l) => l.code === 'es').name, 'Español');
  assert.equal(loadStrings('es').back, es.back);
});

// ---- server: /api/langs and /api/strings?lang= ----
let srv;
before(async () => {
  const tmp = tmpDir();
  const app = new App({ projectsDir: path.join(tmp, 'projects'), cacheDir: path.join(tmp, 'cache'), usageFile: path.join(tmp, 'usage.json'), ask: async () => '{}' });
  srv = await startServer(app, 0);
});
after(() => srv.server.close());

const getJson = (route) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.port, path: route }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
  }).on('error', reject);
});

test('/api/langs lists the offered languages', async () => {
  const r = await getJson('/api/langs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.langs.map((l) => l.code), ['en', 'es']);
});

test('/api/strings?lang=es serves Spanish; no lang keeps the server language', async () => {
  assert.equal((await getJson('/api/strings?lang=es')).body.back, es.back);
  assert.equal((await getJson('/api/strings?lang=en')).body.back, en.back);
  assert.equal((await getJson('/api/strings')).body.back, en.back);
});

test('/api/strings?lang= only accepts the whitelist: unknown codes and traversal fall back to the server language', async () => {
  for (const l of ['xx', '../package', '..%2fpackage', 'es.json', 'ES', 'e', 'es%00', '__proto__', '']) {
    const r = await getJson('/api/strings?lang=' + l);
    assert.equal(r.status, 200, l);
    assert.equal(r.body.back, en.back, l);
    assert.equal(r.body.name, undefined, l); // never the contents of another file
  }
});

// ---- front end: choosing the language ----
const ctx = vm.createContext({ document: {}, window: {}, fetch() {}, location: {}, localStorage: {} });
vm.runInContext(fs.readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8'), ctx);
const pick = (...a) => vm.runInContext('pickLang', ctx)(...a);
const langs = [{ code: 'en' }, { code: 'es' }];

test('pickLang: saved choice first, then the browser language, then the server default', () => {
  assert.equal(pick(langs, 'es', 'en-US', 'en'), 'es');
  assert.equal(pick(langs, null, 'es-CO', 'en'), 'es');
  assert.equal(pick(langs, null, 'fr-FR', 'en'), 'en');
  assert.equal(pick(langs, 'xx', 'fr', 'en'), 'en'); // a saved language that is no longer offered is ignored
  assert.equal(pick(langs, null, undefined, 'es'), 'es');
});

test('the page wires the language selector, persists it and sets <html lang>', () => {
  assert.match(js, /localStorage\.setItem\("tr-lang"/);
  assert.match(js, /document\.documentElement\.lang = LANG/);
  assert.match(js, /\/api\/strings\?lang=/);
});

// ---- html`` migration: what is left on manual esc() is listed on purpose ----
test('only the task detail template still builds innerHTML from a plain template string', () => {
  const left = js.split('\n').filter((l) => /innerHTML = `/.test(l));
  assert.equal(left.length, 1, left.join('\n'));
  assert.match(left[0], /class="back" id="back"/);
});

test('no innerHTML assignment of the migrated sites goes through esc() any more', () => {
  for (const l of js.split('\n').filter((l) => /innerHTML = html`/.test(l))) assert.doesNotMatch(l, /\besc\(/, l.slice(0, 80));
});

// ---- AI action feedback ----
test('error messages are announced (role=alert) and the estimate failures offer a retry', () => {
  const errs = js.match(/<p class="err"[^>]*>/g);
  for (const e of errs) assert.match(e, /role="alert"/, e);
  assert.match(js, /id="gen-retry"/);
  assert.match(js, /id="ai-retry"/);
  assert.match(js, /id="detail-retry"/);
  assert.ok(en.error_retry && es.error_retry);
});

test('the AI search confirms success in its live region, and no English is hard-coded in the stream error', () => {
  assert.match(js, /<p class="okmsg" role="status">\$\{fmt\(S\.progress_done_generate/);
  assert.doesNotMatch(js, /new Error\("The connection closed/);
  assert.ok(en.progress_closed);
});
