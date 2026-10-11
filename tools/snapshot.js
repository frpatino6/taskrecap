// Maintainer tooling (not published): builds ONE self-contained HTML file of the web UI (CSS, JS and the API answers inlined, fetch()
// stubbed) so it renders from a plain file with no server. Uses the FICTIONAL demo data. Home page + one capsule view only.
// Run: node tools/snapshot.js [--out file.html] [--url http://127.0.0.1:8765/]   (without --url a demo server is started)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_FILES = ['core', 'home', 'timeline', 'ai', 'files', 'units', 'organize', 'detail', 'evidence', 'main'];

/** Makes text safe inside an inline <script> or <style>: a literal closing tag would end the element early. */
export function escapeInline(text, tag) {
  return String(text).replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

/** JSON for a <script>: also safe against `</script>` and the U+2028/2029 line separators. */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The script that replaces window.fetch: answers from the embedded map (exact path+query, else path only), else a 404 JSON. */
export function stubScript(responses) {
  return `(function () {
  var MAP = ${jsonForScript(responses)};
  window.fetch = function (input) {
    var u = new URL(typeof input === "string" ? input : input.url, "http://snapshot.invalid/");
    var hit = MAP[u.pathname + u.search];
    if (hit === undefined) hit = MAP[u.pathname];
    var found = hit !== undefined;
    return Promise.resolve(new Response(JSON.stringify(found ? hit : { error: "not in snapshot" }), { status: found ? 200 : 404, headers: { "Content-Type": "application/json" } }));
  };
})();`;
}

/** Turns the served index.html into a single file: stylesheet and scripts inlined, fetch stub first. */
export function inlineAssets(indexHtml, css, scripts, responses) {
  let out = indexHtml.replace(/<link rel="stylesheet" href="\/app\.css">/, () => `<style>\n${escapeInline(css, 'style')}\n</style>`);
  out = out.replace(/<script src="\/js\/([\w-]+)\.js"><\/script>\n?/g, (_, name) => `<script>\n${escapeInline(scripts[name] ?? '', 'script')}\n</script>\n`);
  const stub = `<script>\n${escapeInline(stubScript(responses), 'script')}\n</script>\n`;
  return out.replace(/<script>/, () => stub + '<script>');
}

async function startDemo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-snapshot-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8794'], {
    cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
    server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
  });
  return { base, stop: () => server.kill() };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const out = path.resolve(opt('--out') || path.join(ROOT, 'taskrecap-snapshot.html'));
  const demo = opt('--url') ? null : await startDemo();
  const base = opt('--url') || demo.base;
  try {
    const text = async (p) => (await fetch(new URL(p, base))).text();
    const json = async (p) => { const r = await fetch(new URL(p, base)); return r.ok ? r.json() : null; };
    const indexHtml = await text('/');
    const css = await text('/app.css');
    const scripts = Object.fromEntries(await Promise.all(JS_FILES.map(async (n) => [n, await text(`/js/${n}.js`)])));
    const responses = {};
    const put = async (p) => { const v = await json(p); if (v !== null) responses[p] = v; return v; };
    const info = await put('/api/info');
    await Promise.all(['/api/ai', '/api/usage', '/api/units/hidden', '/api/organize/proposals', '/api/units/history', '/api/timeline?limit=60'].map(put));
    const langs = await put('/api/langs');
    await Promise.all(langs.langs.map((l) => put('/api/strings?lang=' + encodeURIComponent(l.code))));
    const list = await put('/api/tasks');
    const task = list.tasks.find((t) => t.capsule || t.has_capsule) || list.tasks[0];
    if (!task) throw new Error('no task in the demo data');
    await put('/api/tasks/' + encodeURIComponent(task.key));
    await put('/api/estimate?key=' + encodeURIComponent(task.key));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, inlineAssets(indexHtml, css, scripts, responses));
    console.log(`wrote ${out} (demo: ${Boolean(info.demo)}, capsule: ${task.key}, ${Object.keys(responses).length} api answers)`);
  } finally {
    if (demo) demo.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
