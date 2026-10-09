// Maintainer tool (not published): README screenshots of the work-unit views. Demo data only, temporary home folder, no model call.
// Run: npm run units-shots
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-units-shots-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8795'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
  server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'light' });
const page = await ctx.newPage();
const A = 'session:f3a3b3c3';
const B = 'session:f4a4b4c4';
await page.goto(base);
await page.evaluate(() => { try { localStorage.setItem('tr-view', 'cards'); localStorage.setItem('wc-theme', 'light'); } catch (e) { /* ignore */ } });
await page.reload();
await page.waitForSelector('.card');
const shot = (name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });

// 1. cards: unsorted sessions with the Related hint, and the folded group under them
await page.locator('.card[data-key="session:f3a3b3c3"]').scrollIntoViewIfNeeded();
await page.evaluate(() => document.getElementById('grid').scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -12));
await shot('units-cards-light.png');

// 2. the folded group, opened
await page.locator('#emptygroup summary').click();
await page.locator('#emptygroup').scrollIntoViewIfNeeded();
await page.evaluate(() => document.getElementById('emptygroup').scrollIntoView({ block: 'center' }));
await shot('units-empty-group-light.png');
await page.locator('#emptygroup summary').click();

// 3. a card menu
await page.evaluate(() => window.scrollTo(0, 0));
await page.evaluate(() => document.getElementById('grid').scrollIntoView({ block: 'start' }));
await page.locator(`.cardmenu[data-menu="${A}"]`).click();
await page.waitForSelector('#unitmenu button');
await shot('units-menu-light.png');
await page.keyboard.press('Escape');

// 4. merge dialog
await page.locator(`.cardmenu[data-menu="${A}"]`).click();
await page.waitForSelector('#unitmenu button');
await page.locator('#unitmenu button', { hasText: 'Merge with' }).click();
await page.locator('#ud-target').selectOption({ value: B });
await page.locator('#ud-name').fill('Products pagination');
await shot('units-merge-dialog-light.png');
await page.locator('#ud-ok').click();
await page.waitForSelector('.card[data-key^="user:"]:has-text("Products pagination")');

// 5. the page of a unit
await page.locator('.card[data-key^="user:"]:has-text("Products pagination")').click(); // not the demo's own sample group
await page.waitForSelector('#detail h1');
await page.locator('#sess-jump').click();
await page.waitForSelector('#sesslist .sessrow');
await page.evaluate(() => window.scrollTo(0, 0));
await shot('units-detail-light.png');

await browser.close();
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('screenshots written to', OUT);
