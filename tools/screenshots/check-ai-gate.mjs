// Maintainer check (not published): the AI buttons have ONE source of truth, so a running action and the Claude Code status
// never clobber each other. /api/info, /api/ai and the re-check are stubbed in the browser; demo data only, no model is ever
// called. Run: npm run check-ai-gate
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ai-gate-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8793'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
  server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});

const OFF = { available: false, reason: 'not-found', tried: ['PATH', '~/.local/bin/claude'], message: 'not found' };
const ON = { available: true, path: '~/bin/claude', version: '2.0.0', via: 'path', reason: null, tried: ['PATH'], message: null };
const CHECKING = { available: null, checking: true, tried: [], message: null };
let infoAi = OFF; // what the stubbed /api/info reports
let aiPoll = [CHECKING, ON]; // successive answers of the stubbed GET /api/ai
let recheck = ON; // answer of the stubbed POST /api/ai/recheck
let estimateDelay = 0;
const seen = { estimates: 0, generates: 0, rechecks: 0 };

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(true); console.log('PASS', name); } catch (e) { results.push(false); console.log('FAIL', name, '-', e.message.split('\n')[0]); }
};
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.addInitScript(() => { try { localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });
await page.route('**/api/info', async (route) => {
  const real = await (await route.fetch()).json();
  await route.fulfill({ json: { ...real, ai: infoAi } });
});
await page.route('**/api/ai', (route) => route.fulfill({ json: aiPoll.length > 1 ? aiPoll.shift() : aiPoll[0] }));
await page.route('**/api/ai/recheck', (route) => { seen.rechecks += 1; return route.fulfill({ json: recheck }); });
await page.route('**/api/ai-search/estimate**', async (route) => {
  seen.estimates += 1;
  if (estimateDelay) await new Promise((r) => setTimeout(r, estimateDelay));
  await route.fulfill({ json: { calls: 1, input_tokens: 1000, output_tokens: 100, usd: 0.02, seconds: 5, tasks: 9, model: 'sonnet' } });
});
await page.route('**/api/estimate**', async (route) => {
  if (estimateDelay) await new Promise((r) => setTimeout(r, estimateDelay));
  await route.fulfill({ json: { calls: 3, input_tokens: 5000, output_tokens: 600, usd: 0.17, seconds: 60, sessions: 1, model: 'sonnet' } });
});
await page.route('**/api/ai-search', (route) => { seen.generates += 1; return route.abort(); }); // POST: must never be reached in these checks
const disabled = (sel) => page.locator(sel).isDisabled();

await check('state 1, Claude Code unavailable: both AI buttons are disabled, and no handler can start a request', async () => {
  infoAi = OFF;
  await page.goto(base);
  await page.waitForSelector('.card');
  assert.equal(await disabled('#ai-search'), true);
  assert.equal(await disabled('#none-ai'), true);
  assert.match((await page.locator('#ai-search').getAttribute('title')) || '', /Claude Code/);
  assert.ok(await page.locator('#ai-note .ai-off').count());
  await page.fill('#q', 'rounding');
  await page.evaluate(() => startAiSearch()); // even if a script calls the handler directly
  await page.waitForTimeout(200);
  assert.equal(seen.estimates, 0);
  assert.equal((await page.locator('#aibox').innerHTML()).trim(), '');
});

await check('state 2, "Check again" succeeds: the buttons become usable without reloading the page', async () => {
  recheck = ON;
  await page.locator('#ai-note .ai-recheck').click();
  await page.waitForFunction(() => !document.getElementById('ai-search').disabled && !document.querySelector('.ai-off'));
  assert.equal(seen.rechecks, 1);
  assert.equal(await disabled('#none-ai'), false);
  assert.equal((await page.locator('#ai-search').getAttribute('title')) || '', '');
});

await check('state 3, busy then done: the button is off while the estimate runs and on again when it is closed (Claude Code available)', async () => {
  estimateDelay = 700;
  await page.fill('#q', 'rounding');
  await page.locator('#ai-search').click();
  assert.equal(await disabled('#ai-search'), true); // busy
  await page.waitForSelector('#ai-no');
  assert.equal(await disabled('#ai-search'), true); // still busy: the estimate is waiting for confirmation
  await page.locator('#ai-no').click();
  assert.equal(await disabled('#ai-search'), false);
  assert.equal(await disabled('#none-ai'), false);
});

await check('state 3b, a button disabled by a running action is NOT re-enabled when it ends if Claude Code went away meanwhile', async () => {
  await page.locator('#ai-search').click();
  await page.waitForSelector('#ai-no');
  await page.evaluate(() => { INFO.ai = { available: false, reason: 'not-found', tried: [] }; applyAiGate(); });
  assert.equal(await disabled('#ai-search'), true);
  await page.locator('#ai-no').click(); // the action ends
  assert.equal(await disabled('#ai-search'), true); // ...but AI is unavailable: it must stay off
  await page.evaluate(() => { INFO.ai = { available: true }; applyAiGate(); });
  assert.equal(await disabled('#ai-search'), false);
});

await check('state 4, the server is still checking: buttons wait (with a tooltip), then turn on by themselves, no reload and no error note', async () => {
  estimateDelay = 0;
  infoAi = CHECKING;
  aiPoll = [CHECKING, ON];
  await page.goto(base);
  await page.waitForSelector('.card');
  assert.equal(await disabled('#ai-search'), true);
  assert.match((await page.locator('#ai-search').getAttribute('title')) || '', /Checking/);
  assert.equal(await page.locator('#ai-note .ai-off').count(), 0);
  await page.waitForFunction(() => !document.getElementById('ai-search').disabled, null, { timeout: 8000 });
  assert.equal(await page.locator('#ai-note .ai-off').count(), 0);
});

await check('capsule view: generate is off while the estimate runs, on again after Cancel; and never usable while unavailable', async () => {
  infoAi = ON;
  estimateDelay = 600;
  await page.goto(base + '#/task/SHOP-106');
  await page.waitForSelector('#gen');
  assert.equal(await disabled('#gen'), false);
  await page.locator('#gen').click();
  assert.equal(await disabled('#gen'), true);
  await page.waitForSelector('#no');
  await page.locator('#no').click();
  assert.equal(await disabled('#gen'), false);
  await page.evaluate(() => { INFO.ai = { available: false, reason: 'not-found', tried: [] }; applyAiGate(); });
  assert.equal(await disabled('#gen'), true);
  assert.ok(await page.locator('#genbox .ai-off').count());
  await page.evaluate(() => { INFO.ai = { available: true }; applyAiGate(); });
  assert.equal(await disabled('#gen'), false);
  assert.equal(await page.locator('#genbox .ai-off').count(), 0);
});

await check('no AI request was ever sent while unavailable, and no console errors', async () => {
  assert.equal(seen.generates, 0);
  assert.deepEqual(errors, []);
});

await browser.close();
server.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
