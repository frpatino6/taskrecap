// Maintainer tooling (not published to npm): records the README demo GIF with Playwright against the SYNTHETIC demo data.
//   cd tools/screenshots && npm install && npx playwright install chromium && npm run demo-gif
// Needs ffmpeg for the GIF/MP4 conversion (macOS: `brew install ffmpeg`). It never touches real sessions and never calls the LLM.
// Output: docs/demo.gif (README) and docs/demo.mp4 (lighter fallback).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(ROOT, 'docs');
const W = 1280, H = 720;
const SEARCH = 'rounding'; // appears inside the demo capsules, so the 'Found in' badge shows
const TASK = 'SHOP-101';

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg not found. Install it (macOS: `brew install ffmpeg`) and run this again.');
  process.exit(1);
}

// --- isolated demo server: its own cache dir, its own port, demo sessions only ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-gif-home-'));
const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-gif-video-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8792'], {
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

// A subtle cursor, so viewers can follow the clicks in the recording.
const CURSOR = () => {
  const make = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'border:2px solid rgba(255,255,255,.85);background:rgba(124,92,255,.35);box-shadow:0 0 0 1px rgba(0,0,0,.35);' +
      'pointer-events:none;z-index:2147483647;transition:transform .12s ease,background .12s ease;';
    document.documentElement.appendChild(c);
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; c.style.background = 'rgba(124,92,255,.7)'; }, true);
    window.addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; c.style.background = 'rgba(124,92,255,.35)'; }, true);
  };
  if (document.documentElement) make(); else document.addEventListener('DOMContentLoaded', make);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, colorScheme: 'dark', locale: 'en-US',
  recordVideo: { dir: videoDir, size: { width: W, height: H } },
  permissions: ['clipboard-read', 'clipboard-write'],
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
const page = await ctx.newPage();
await page.addInitScript(CURSOR);
// this recording starts from the cards view (the home now opens on the timeline)
await page.addInitScript(() => { try { localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });

let mx = W - 90, my = 160; // start parked in a neutral corner
const pause = (ms) => page.waitForTimeout(ms);
async function glide(locator, { dy = 0 } = {}) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 28) + dy;
  await page.mouse.move(x, y, { steps: 28 });
  mx = x; my = y;
  await pause(250);
}
const smoothScrollTo = async (locator) => {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(900);
};

try {
  // 1. Home: task cards with their objectives
  await page.goto(base);
  await page.waitForSelector('.card');
  await page.mouse.move(mx, my);
  await pause(2200);

  // 2. Free search inside saved capsules, with highlights and the "Found in" badge
  await glide(page.locator('#q'));
  await page.mouse.down(); await page.mouse.up();
  await page.locator('#q').pressSequentially(SEARCH, { delay: 110 });
  await page.waitForFunction(() => document.querySelectorAll('#grid .card mark').length > 0, null, { timeout: 8000 });
  await pause(700);
  await smoothScrollTo(page.locator('#grid .card').first()); // bring the highlighted match + 'Found in' badge into view
  await pause(2800);

  // 3. Open the task and read its capsule
  const card = page.locator(`.card[data-key="${TASK}"]`);
  await glide(card);
  await card.click();
  await page.waitForSelector('#detail:not([hidden]) h1, #detail:not([hidden]) h2');
  await pause(2200);

  // 4. Click a citation in the timeline: the original message opens, highlighted
  const cite = page.locator('#detail button.cite').first();
  await smoothScrollTo(cite);
  await glide(cite);
  await pause(500);
  await cite.click();
  await page.waitForSelector('#evidence:not([hidden]) .evturn.cited', { timeout: 8000 });
  await pause(3000);

  // 5. Copy the command that resumes that exact conversation
  const copy = page.locator('#ev-copy');
  await glide(copy);
  await pause(400);
  await copy.click();
  await page.waitForFunction(() => /Copied/i.test(document.getElementById('ev-copy')?.innerText || document.getElementById('evidence')?.innerText || ''), null, { timeout: 5000 }).catch(() => {});
  await pause(2200);

  // 6. Close the panel
  const close = page.locator('#ev-close');
  await glide(close);
  await close.click();
  await page.waitForSelector('#evidence', { state: 'hidden' });
  await pause(1800);
} finally {
  await ctx.close(); // flushes the video
  await browser.close();
  server.kill();
}

const webm = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm')).map((f) => path.join(videoDir, f))[0];
if (!webm) throw new Error('no video was recorded');
fs.mkdirSync(DOCS, { recursive: true });

const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
};
const TRIM = ['-ss', '0.4']; // drop the blank first frames
const gif = path.join(DOCS, 'demo.gif');
const mp4 = path.join(DOCS, 'demo.mp4');
ff([...TRIM, '-i', webm, '-vf',
  'fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  '-loop', '0', gif]);
ff([...TRIM, '-i', webm, '-vf', `scale=${W}:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', '-an', mp4]);

const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2) + ' MB';
console.log('wrote', gif, mb(gif));
console.log('wrote', mp4, mb(mp4));
fs.rmSync(videoDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
