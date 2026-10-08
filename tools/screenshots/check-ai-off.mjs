// Maintainer check (not published): what the page does when Claude Code cannot be found, and that "Check again" picks it up
// once it is installed. Synthetic demo data only; never calls a model. Run: npm run check-ai
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ai-off-'));
const fake = path.join(tmp, 'bin', 'claude'); // does not exist yet: "not installed"
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8792'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home'), TASKRECAP_CLAUDE: fake }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
  server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});

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

await check('home: AI buttons are disabled with a tooltip and the note explains how to fix it', async () => {
  await page.goto(base);
  await page.waitForSelector('.card');
  assert.equal(await page.locator('#ai-search').isDisabled(), true);
  assert.match(await page.locator('#ai-search').getAttribute('title'), /Claude Code/);
  const note = await page.locator('#ai-note').innerText();
  for (const re of [/AI actions are unavailable/, /--claude-path/, /TASKRECAP_CLAUDE/, /taskrecap doctor/, /Check again/]) assert.match(note, re);
  await page.screenshot({ path: path.join(tmp, 'ai-off-home.png') });
  await page.locator('#ai-note').screenshot({ path: path.join(tmp, 'ai-off-note.png') });
});

await check('free mode keeps working: search finds a word inside a capsule', async () => {
  await page.fill('#q', 'rounding');
  await page.waitForSelector('.card');
  assert.ok((await page.locator('.card').count()) >= 1);
  await page.fill('#q', '');
});

await check('capsule view: the regenerate button is disabled and the same note is shown', async () => {
  await page.locator('.card[data-key="SHOP-101"]').click();
  await page.waitForSelector('#gen');
  assert.equal(await page.locator('#gen').isDisabled(), true);
  assert.match(await page.locator('#genbox').innerText(), /AI actions are unavailable/);
  await page.locator('#detail').evaluate((el) => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(tmp, 'ai-off-detail.png') });
});

await check('task without a capsule: the generate button is disabled too', async () => {
  await page.goto(base + '#/task/SHOP-106');
  await page.waitForSelector('#gen');
  assert.equal(await page.locator('#gen').isDisabled(), true);
});

await check('"Check again" while it is still missing says so and keeps AI off', async () => {
  await page.locator('#genbox .ai-recheck').click();
  await page.waitForFunction(() => /Still not available/.test(document.querySelector('#genbox .ai-recheck-msg').textContent));
  assert.equal(await page.locator('#gen').isDisabled(), true);
});

await check('after Claude Code is installed, "Check again" turns the AI actions back on without a restart', async () => {
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log('2.0.0 (Claude Code)');\n`);
  fs.chmodSync(fake, 0o755);
  await page.locator('#genbox .ai-recheck').click();
  await page.waitForFunction(() => !document.querySelector('#gen')?.disabled && !document.querySelector('.ai-off'));
  await page.goto(base);
  await page.waitForSelector('.card');
  assert.equal(await page.locator('#ai-search').isDisabled(), false);
  assert.equal((await page.locator('#ai-note').innerText()).trim(), '');
});

await check('phone width: the note does not overflow the page', async () => {
  fs.rmSync(fake);
  await page.request.get(base + 'api/ai?force=1');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(base);
  await page.waitForSelector('.ai-off');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
});

await check('no console errors', async () => { assert.deepEqual(errors, []); });

await browser.close();
server.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed (screenshots for a look: ${tmp})`);
process.exit(failed ? 1 : 0);
