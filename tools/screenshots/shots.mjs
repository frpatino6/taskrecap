// Maintainer tooling (not published to npm): drives the UI with Playwright against the SYNTHETIC demo data,
// asserts the basics and saves README screenshots to docs/screenshots/.
//   cd tools/screenshots && npm install && npx playwright install chromium && npm run shots
// It never touches real sessions and never calls the real LLM: the AI progress panel is fed by a scripted stream.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log('FAIL', name, '-', e.message.split('\n')[0]); }
};

// --- isolated demo server: its own cache dir, its own port, demo sessions only ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shots-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8791'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
  server.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (m) { clearTimeout(t); resolve(m[0]); }
  });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});
console.log('demo server at', base, '(cache:', home + ')');

const browser = await chromium.launch();
const consoleErrors = [];
async function newPage(scheme = 'light', init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'en-US' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  if (init) await page.addInitScript(init);
  return page;
}
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const openHome = async (page) => { await page.goto(base); await page.waitForSelector('.card'); await settle(page); };
const openTask = async (page, key) => { await page.locator(`.card[data-key="${key}"]`).click(); await page.waitForSelector('#detail:not([hidden]) h1, #detail:not([hidden]) h2'); await settle(page); };

// ---------- light theme ----------
let page = await newPage('light');
await openHome(page);

await check('home: page loads and cards render', async () => {
  assert.ok((await page.locator('.card').count()) >= 3, 'expected at least 3 task cards');
  assert.ok(await page.locator('#banner').innerText(), 'demo banner text');
  await shot(page, '01-home-light.png');
});

await check('search: free search inside capsules shows a highlighted match and the "found in" badge', async () => {
  await page.fill('#q', 'rounding');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card mark').length > 0, null, { timeout: 8000 });
  const hits = await page.locator('#grid .card').count();
  assert.ok(hits >= 1, 'search returned no hits');
  assert.match(await page.locator('#grid').innerText(), /Found in/i, 'missing "Found in" badge');
  await settle(page);
  await shot(page, '02-search-inside-capsules-light.png', { fullPage: true });
  await page.fill('#q', '');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length >= 3);
});

await check('capsule view: timeline and decisions render', async () => {
  await openTask(page, 'SHOP-101');
  const text = await page.locator('#detail').innerText();
  assert.match(text, /Timeline/i);
  assert.match(text, /Decisions/i);
  assert.ok((await page.locator('#detail button.cite').count()) > 0, 'no clickable citations');
  await shot(page, '03-capsule-view-light.png', { fullPage: false });
  await shot(page, '03b-capsule-full-light.png', { fullPage: true });
});

await check('evidence panel opens from a citation and highlights the cited turn', async () => {
  await page.locator('#detail button.cite').first().scrollIntoViewIfNeeded();
  await page.locator('#detail button.cite').first().click();
  await page.waitForSelector('#evidence:not([hidden]) .evturn.cited', { timeout: 8000 });
  assert.equal(await page.locator('#evidence .evturn.cited').count(), 1, 'exactly one cited turn expected');
  assert.ok((await page.locator('#evidence .evturn.dim').count()) >= 1, 'context turns missing');
  assert.match(await page.locator('#evidence').innerText(), /claude --resume/);
  await settle(page);
  await shot(page, '04-evidence-panel-light.png');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#evidence', { state: 'hidden' });
});

await check('file -> tasks: panel lists other tasks that touched the file', async () => {
  const btn = page.locator('#detail button.filelink', { hasText: 'total.test.js' }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForFunction(() => /touched/i.test((document.getElementById('filebox') || {}).innerText || ''), null, { timeout: 8000 });
  await settle(page);
  await page.locator('#filebox').scrollIntoViewIfNeeded();
  await shot(page, '05-file-to-tasks-light.png');
});

await check('AI confirm step: estimate shown, nothing is spent', async () => {
  await page.goto(base + '#/task/SHOP-106');
  await page.waitForSelector('#gen');
  await page.click('#gen');
  await page.waitForSelector('#ok', { timeout: 8000 });
  const usageBefore = await (await fetch(base + 'api/usage')).json();
  assert.equal(usageBefore.total.calls, 0, 'usage counter must still be zero');
  await settle(page);
  await shot(page, '07-ai-confirm-estimate-light.png');
});
await page.context().close();

// AI progress panel mid-run: scripted NDJSON stream replaces /api/generate (no LLM call is made).
const FAKE_STREAM = () => {
  const orig = window.fetch.bind(window);
  let started = false;
  window.fetch = (url, opts) => {
    if (started && String(url).includes('/api/usage')) {
      const u = { calls: 2, input_tokens: 3000, output_tokens: 600, usd: 0.024, tokens: 3600 };
      return Promise.resolve(new Response(JSON.stringify({ session: u, total: u }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (String(url).includes('/api/generate') && opts && opts.method === 'POST') {
      started = true;
      const enc = new TextEncoder();
      const usage = (calls, tokens, cost) => ({ calls, tokens, cost_usd: cost });
      const events = [
        { type: 'start', stages: ['scan', 'redact', 'votes', 'merge', 'evidence', 'write', 'validate', 'save'] },
        { type: 'stage', id: 'scan', status: 'running' },
        { type: 'stage', id: 'scan', status: 'done', code: 'scan_done', vars: { sessions: 1, turns: 2 } },
        { type: 'stage', id: 'redact', status: 'done', code: 'redact_none', vars: { turns: 2 } },
        { type: 'stage', id: 'votes', status: 'running', code: 'votes_start', vars: { session: 'c9d0e1f2', votes: 3, turns: 2 } },
        { type: 'log', code: 'vote_done', vars: { n: 1, of: 3, ranges: 1, turns: 2, session: 'c9d0e1f2' }, level: 'info', usage: usage(1, 1800, 0.012) },
        { type: 'log', code: 'vote_done', vars: { n: 2, of: 3, ranges: 1, turns: 2, session: 'c9d0e1f2' }, level: 'info', usage: usage(2, 3600, 0.024) },
      ];
      let i = 0;
      return Promise.resolve(new Response(new ReadableStream({
        start(c) {
          const push = () => { if (i < events.length) { c.enqueue(enc.encode(JSON.stringify(events[i++]) + '\n')); setTimeout(push, 120); } };
          push();
          if (opts.signal) opts.signal.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
        },
      }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    }
    return orig(url, opts);
  };
};
page = await newPage('light', FAKE_STREAM);
await check('AI progress panel: live stages, activity log and cancel button (scripted stream, no spend)', async () => {
  await page.goto(base + '#/task/SHOP-106');
  await page.waitForSelector('#gen');
  await page.click('#gen');
  await page.waitForSelector('#ok');
  await page.click('#ok');
  await page.waitForSelector('.pg-stages li[data-status="running"]', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.pg-log li').length >= 4, null, { timeout: 8000 });
  assert.ok(await page.locator('.pg-cancel').isVisible(), 'cancel button visible');
  await settle(page, 900);
  await shot(page, '06-ai-progress-light.png', { fullPage: true });
  await page.click('.pg-cancel'); // really aborts the (scripted) stream, leaves the page clean
  await page.waitForSelector('.pg-end');
});
await page.context().close();

// ---------- dark theme ----------
page = await newPage('dark');
await openHome(page);
await check('dark theme: home and capsule view', async () => {
  await shot(page, '01-home-dark.png');
  await openTask(page, 'SHOP-101');
  await shot(page, '03-capsule-view-dark.png');
});
await page.context().close();

// ---------- tweet-ready images: dark, 16:9 (1600x900 @2x), demo data only ----------
// Screenshot-only CSS (never shipped): drop the demo banner and the long explanatory notes so the cards and the search result
// are what you see. The text of the post should say these are fictional demo sessions.
const TWEET_CSS = '#banner, #search-note, #filesearch, .lead { display: none !important; } main#home h1 { margin-top: 8px; }';
// Search terms for the tweet images. `checkout` was tried first but matches only 3 tasks, one of them without a 'Found in' badge.
// `test` fills the frame (4 hits, clean excerpts; the last row is cut like a scrolled page); `payment` gives 2 clean cards with empty space below.
const TWEET_QUERY = 'test';
const TWEET_QUERY_COMPACT = 'payment';
async function tweetShot(name, query) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US' });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await p.goto(base);
  await p.waitForSelector('.card');
  await p.addStyleTag({ content: TWEET_CSS });
  if (query) {
    await p.fill('#q', query);
    await p.waitForFunction(() => document.querySelectorAll('#grid .card mark').length > 0, null, { timeout: 8000 });
  }
  await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(OUT, name) });
  await ctx.close();
}
await check('tweet images: dark home with ready capsules, idle and with a search in progress (two variants)', async () => {
  await tweetShot('tweet-home-dark.png');
  await tweetShot('tweet-home-dark-search.png', TWEET_QUERY);
  await tweetShot('tweet-home-dark-search-compact.png', TWEET_QUERY_COMPACT);
  assert.ok(fs.statSync(path.join(OUT, 'tweet-home-dark-search.png')).size > 50000);
});

await check('no console errors during the whole run', async () => {
  assert.deepEqual(consoleErrors, []);
});

await browser.close();
server.kill('SIGTERM');
fs.rmSync(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(' -', f.name, '\n   ', f.error.split('\n')[0]);
console.log('screenshots in', OUT, ':', fs.readdirSync(OUT).join(', '));
process.exit(failed.length ? 1 : 0);
