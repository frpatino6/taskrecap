// Maintainer tool (not published): README screenshots of "Organize with AI". Demo data only, temporary home folder; the stand-in
// `claude` (fake-claude.mjs) answers, so nothing is sent anywhere and nothing is spent. Run: npm run organize-shots
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-organize-shots-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8798'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home'), TASKRECAP_CLAUDE: path.join(HERE, 'fake-claude.mjs') }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
  server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});
const browser = await chromium.launch();

async function session(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate((t) => { try { localStorage.setItem('tr-view', 'cards'); localStorage.setItem('wc-theme', t); } catch (e) { /* ignore */ } }, theme);
  await page.reload();
  await page.waitForSelector('#organize .organizepanel');
  return { ctx, page };
}

for (const theme of ['light', 'dark']) {
  const { ctx, page } = await session(theme);
  // the proposals, opened: a group, a cut and the names, each with its evidence
  if (!(await page.locator('#org-details').evaluate((d) => d.open))) await page.locator('#org-details > summary').click();
  await page.waitForSelector('.orgprop');
  await page.evaluate(() => { const el = document.getElementById('organize'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70); });
  await page.screenshot({ path: path.join(OUT, `organize-proposals-${theme}.png`) });
  await ctx.close();
}

{ // "Name with AI": the dialog with the proposed name and Accept / Edit / Reject
  const { ctx, page } = await session('light');
  await page.locator('.cardmenu[data-menu="session:d4e5f6a7"]').first().click();
  await page.waitForSelector('#unitmenu button');
  await page.locator('#unitmenu button', { hasText: 'Name with AI' }).click();
  await page.waitForSelector('#org-ok, #org-show');
  if (await page.locator('#org-again').count()) { await page.locator('#org-again').click(); await page.waitForSelector('#org-ok'); }
  await page.screenshot({ path: path.join(OUT, 'organize-estimate-light.png') });
  await page.locator('#org-ok').click();
  await page.waitForSelector('#orgdlg .orgprop[data-type="title"]', { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, 'organize-name-light.png') });
  await ctx.close();
}
await browser.close();
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote organize-proposals-{light,dark}.png, organize-estimate-light.png, organize-name-light.png');
