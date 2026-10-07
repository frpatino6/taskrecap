// Maintainer tooling (not published to npm): builds the GitHub social preview image (1280x640) from the SYNTHETIC demo.
//   cd tools/screenshots && npm install && npx playwright install chromium && npm run social
// Output: docs/social-preview.png. Upload it by hand: repo Settings > General > Social preview > Edit > Upload an image.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'social-preview.png');
const TASK = 'SHOP-101';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-social-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8793'], {
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

const browser = await chromium.launch();
try {
  // 1. A crop of the real UI (evidence panel, dark, demo data)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForSelector('.card');
  await page.locator(`.card[data-key="${TASK}"]`).click();
  await page.waitForSelector('#detail:not([hidden]) h1, #detail:not([hidden]) h2');
  await page.locator('#detail button.cite').first().scrollIntoViewIfNeeded();
  await page.locator('#detail button.cite').first().click();
  await page.waitForSelector('#evidence:not([hidden]) .evturn.cited');
  await page.addStyleTag({ content: '#banner{display:none!important}' }); // the demo banner would show up as a clipped fragment
  await page.waitForTimeout(900);
  const crop = (await page.screenshot({ clip: { x: 700, y: 40, width: 580, height: 760 } })).toString('base64');
  await ctx.close();

  // 2. The 1280x640 composition
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:1280px;height:640px;overflow:hidden;position:relative;color:#f2f3fb;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
      background:radial-gradient(900px 520px at 85% 10%,rgba(124,92,255,.40),transparent 60%),
                 radial-gradient(700px 420px at 0% 100%,rgba(60,90,220,.22),transparent 60%),#0b0e17}
    .copy{position:absolute;left:72px;top:0;bottom:0;width:640px;display:flex;flex-direction:column;justify-content:center}
    .brand{display:flex;align-items:center;gap:20px;margin-bottom:30px}
    .mark{width:76px;height:76px;border-radius:20px;background:linear-gradient(135deg,#9a85ff,#6f55f5);display:grid;place-items:center;box-shadow:0 10px 30px rgba(124,92,255,.45)}
    .mark svg{width:42px;height:42px}
    h1{font-size:92px;line-height:1;letter-spacing:-2.5px;font-weight:800;margin-bottom:22px}
    p.tag{font-size:38px;line-height:1.28;color:#c9cbe6;font-weight:500;max-width:610px}
    .pills{display:flex;gap:12px;margin-top:34px}
    .pill{font-size:23px;font-weight:600;padding:9px 20px;border-radius:999px;border:2px solid rgba(255,255,255,.2);color:#e6e7f7;background:rgba(255,255,255,.05)}
    .shot{position:absolute;right:56px;top:56px;width:440px;height:720px;border-radius:22px;overflow:hidden;
      border:2px solid rgba(255,255,255,.14);box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(124,92,255,.35)}
    .shot img{width:100%;display:block}
  </style>
  <div class="copy">
    <div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#0b0e17" stroke-width="2.2" stroke-linejoin="round"><path d="M12 2 22 12 12 22 2 12Z"/><path d="M12 7 17 12 12 17 7 12Z" fill="#0b0e17"/></svg></div></div>
    <h1>taskrecap</h1>
    <p class="tag">One recap per task, built from your Claude Code sessions.</p>
    <div class="pills"><span class="pill">Every claim cites its source</span><span class="pill">Local-first</span></div>
  </div>
  <div class="shot"><img src="data:image/png;base64,${crop}"></div>`;
  const out = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  const p2 = await out.newPage();
  await p2.setContent(html);
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: OUT });
  await out.close();
  console.log('wrote', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
