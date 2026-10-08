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
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: home, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
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
// The home now opens on the timeline; every flow below that starts from the cards asks for the cards view (view: null = untouched).
async function newPage(scheme = 'light', init, { view = 'cards', viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  if (view) await page.addInitScript((v) => { try { localStorage.setItem('tr-view', v); } catch (e) { /* ignore */ } }, view);
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

await check('capsule timeline: first column shows date and local time with a tooltip, in the browser timezone; the page does not overflow on a phone', async () => {
  const expectedLabel = (tz, iso) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  for (const [tz, width] of [['UTC', 1440], ['America/Bogota', 1440], ['Asia/Kolkata', 390]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', timezoneId: tz });
    const p = await ctx.newPage();
    await p.addInitScript(() => { try { localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    p.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await p.goto(base);
    await p.waitForSelector('.card');
    await p.locator('.card[data-key="SHOP-101"]').click();
    await p.waitForSelector('table.tl2 tbody tr');
    const detail = await (await p.request.get(new URL('api/tasks/SHOP-101', base).href)).json();
    const rows = detail.capsule.capsule.timeline;
    const shown = await p.locator('table.tl2 tbody tr td:first-child').allInnerTexts();
    assert.deepEqual(shown.map((t) => t.trim()), rows.map((r) => expectedLabel(tz, r.ts)), `first column in ${tz}`);
    assert.match((await p.locator('table.tl2 th').first().innerText()).trim(), /date and time/i);
    assert.match(await p.locator('table.tl2 tbody tr td:first-child span').first().getAttribute('title'), /first message this row cites/i);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page overflows horizontally by ${overflow}px at ${width}px wide`);
    await ctx.close();
  }
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
  await p.addInitScript(() => { try { localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });
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

// ---------- home timeline (default view): checks + docs/screenshots/timeline-{light,dark}.png ----------
// Screenshot-only CSS (never shipped): drop the demo banner, the long notes and the page title so the chart fills the frame.
const TIMELINE_CSS = '#banner, #search-note, #filesearch, .lead, main#home h1, .controls, .vz-head p { display: none !important; } .viewbar { margin-top: 18px; }';
async function timelineShot(scheme, name) {
  const p = await newPage(scheme, null, { view: null, viewport: { width: 1600, height: 900 } });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  await p.addStyleTag({ content: TIMELINE_CSS });
  await settle(p, 800);
  await shot(p, name);
  await p.context().close();
}
await check('timeline: opens by default with one lane per task, legend, coverage and "show more"', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  assert.equal(await p.locator('.vz-lane').count(), 12, 'default limit is 12 lanes');
  assert.ok((await p.locator('.vz-mark').count()) >= 12, 'dots drawn');
  assert.equal(await p.locator('.vz-legend li').count(), 3, 'three repos in the legend');
  assert.match(await p.locator('#vz-more').innerText(), /Show 6 more/);
  assert.match(await p.locator('#coverage-text').innerText(), /6 of 13 tasks have a capsule/);
  assert.equal(await p.locator('#grid .card').count(), 0, 'cards are not shown in the timeline view');
  assert.ok((await p.locator('.sr table tbody tr').count()) === 12, 'text alternative has a row per lane');
  await p.context().close();
});
await check('timeline: hover tooltip, click opens the capsule, keyboard works on lane labels', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  await p.locator('.vz-label[data-key="SHOP-104"]').hover();
  await p.waitForSelector('#vz-tip:not([hidden])');
  assert.match(await p.locator('#vz-tip').innerText(), /SHOP-104[\s\S]*acme-shop[\s\S]*prompts/);
  await p.locator('.vz-lane:has(.vz-label[data-key="SHOP-104"]) .vz-mark').first().hover();
  assert.match(await p.locator('#vz-tip').innerText(), /Sep 1[67], 2026/);
  await p.locator('.vz-lane:has(.vz-label[data-key="SHOP-104"]) .vz-mark').first().click();
  await p.waitForSelector('#detail:not([hidden]) h1');
  assert.match(await p.locator('#detail').innerText(), /SHOP-104/);
  await p.goBack();
  await p.waitForSelector('.vz-lane');
  await p.locator('.vz-label[data-key="DOCS-33"]').focus();
  await p.waitForSelector('#vz-tip:not([hidden])');
  await p.keyboard.press('Enter');
  await p.waitForSelector('#detail:not([hidden]) h1');
  assert.match(await p.locator('#detail').innerText(), /DOCS-33/);
  await p.context().close();
});
await check('timeline: repo filter, show more, capsule coverage filter and Cards/Timeline toggle that persists', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  await p.selectOption('#vz-repo', 'acme-api');
  await p.waitForFunction(() => [...document.querySelectorAll('.vz-label')].every((b) => /^(API-|session:f[234]a)/.test(b.dataset.key)) && document.querySelectorAll('.vz-label').length >= 6);
  assert.equal(await p.locator('.vz-lane').count(), 6, 'API-212, API-214, API-216 and the three sessions of the acme-api repo');
  await p.click('#vz-reset');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 12);
  await p.click('#vz-more');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 18);
  await p.click('#coverage');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 7 && !document.getElementById('capfilter').hidden);
  assert.equal(await p.locator('#coverage').getAttribute('aria-pressed'), 'true');
  await p.click('#capfilter-clear');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length >= 12);
  await p.click('#view-cards');
  await p.waitForSelector('#grid .card');
  assert.equal(await p.locator('#timeline').isHidden(), true);
  await p.reload();
  await p.waitForSelector('#grid .card');
  assert.equal(await p.evaluate(() => localStorage.getItem('tr-view')), 'cards', 'the choice is remembered');
  await p.click('#view-timeline');
  await p.waitForSelector('.vz-lane');
  await p.context().close();
});
await check('timeline: a search narrows the lanes to the matching tasks', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  await p.fill('#q', 'rate limit');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 1);
  assert.equal(await p.locator('.vz-label').first().getAttribute('data-key'), 'API-212');
  await p.context().close();
});
await check('timeline: the footer counts every unit with content; the coverage ring counts those that can have a capsule; sessions without content are named apart', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  assert.match(await p.locator('#coverage-text').innerText(), /of 13 tasks/);
  assert.equal((await p.locator('.vz-foot span').first().innerText()).trim(), 'Showing 12 of 18 tasks · 4 sessions without content are folded below');
  await p.click('#vz-more');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 18);
  assert.equal((await p.locator('.vz-foot span').first().innerText()).trim(), 'Showing 18 of 18 tasks · 4 sessions without content are folded below');
  await p.context().close();
});
await check('timeline: date boxes only appear for a custom period, a reversed range is swapped, an empty result offers a reset', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  assert.equal(await p.locator('#vz-period option').count(), 5);
  assert.equal(await p.locator('#vz-from').isHidden(), true, 'date boxes hidden until "Custom range"');
  await p.selectOption('#vz-period', 'custom');
  assert.equal(await p.locator('#vz-from').isVisible(), true);
  await p.fill('#vz-from', '2026-09-10');
  await p.fill('#vz-to', '2026-09-02');
  await p.waitForFunction(() => document.getElementById('vz-from').value === '2026-09-02');
  assert.equal(await p.inputValue('#vz-to'), '2026-09-10');
  assert.match(await p.locator('#vz-msg').innerText(), /swapped/);
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length > 0);
  await p.fill('#vz-from', '2000-01-01');
  await p.fill('#vz-to', '2000-01-02');
  await p.waitForSelector('#vz-empty-reset');
  await p.click('#vz-empty-reset');
  await p.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 12);
  assert.equal(await p.inputValue('#vz-period'), 'all');
  assert.equal(await p.locator('#vz-custom').isHidden(), true);
  await p.context().close();
});
await check('timeline: a search with no hits hides the chart and offers the AI search instead', async () => {
  const p = await newPage('light', null, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  await p.fill('#q', 'zzzzqqqq');
  await p.waitForFunction(() => !document.getElementById('nonewrap').hidden);
  assert.equal(await p.locator('#timeline').isHidden(), true, 'no empty chart under a failed search');
  assert.match(await p.locator('#none').innerText(), /No tasks match/);
  assert.equal(await p.locator('#none-extra').isVisible(), true);
  await p.fill('#q', '');
  await p.waitForSelector('.vz-lane');
  await p.context().close();
});
await check('timeline: keeps working when localStorage is blocked', async () => {
  const p = await newPage('light', () => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } }); }, { view: null });
  await p.goto(base);
  await p.waitForSelector('.vz-lane');
  await p.click('#view-cards');
  await p.waitForSelector('#grid .card');
  await p.click('#view-timeline');
  await p.waitForSelector('.vz-lane');
  await p.context().close();
});
await check('timeline screenshots (light and dark)', async () => {
  await timelineShot('light', 'timeline-light.png');
  await timelineShot('dark', 'timeline-dark.png');
});

// ---------- sessions section (free) and outdated capsules ----------
await check('sessions: a task WITHOUT a capsule lists its sessions; a session expands and a message opens the evidence panel', async () => {
  const p = await newPage('light');
  await p.goto(base + '#/task/SHOP-106');
  await p.waitForSelector('#sesslist .sessitem');
  assert.match(await p.locator('#detail').innerText(), /You can read what was said in this task for free/i, "the no-capsule hint is missing");
  assert.ok(await p.locator('#detail #gen').count(), 'the generate button must stay');
  const row = p.locator('#sesslist .sessrow').first();
  assert.equal(await row.getAttribute('aria-expanded'), 'false');
  await row.click();
  assert.equal(await row.getAttribute('aria-expanded'), 'true');
  await p.waitForSelector('#sesslist .msg');
  assert.ok((await p.locator('#sesslist .msg').count()) >= 1, 'no messages listed');
  await p.locator('#sess-jump').scrollIntoViewIfNeeded();
  await settle(p);
  await p.locator('#sesslist').scrollIntoViewIfNeeded();
  await shot(p, 'sessions-no-capsule-light.png');
  await p.locator('#sesslist .msg').first().click();
  await p.waitForSelector('#evidence:not([hidden]) .evturn.cited', { timeout: 8000 });
  assert.match(await p.locator('#evidence').innerText(), /claude --resume/);
  assert.equal(await p.locator('#evidence .evwarn').count(), 0, 'a listed message must not be flagged as unverified');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#evidence', { state: 'hidden' });
  const focused = await p.evaluate(() => document.activeElement && document.activeElement.className);
  assert.match(focused, /\bmsg\b/, 'focus returns to the message that was opened');
  await p.context().close();
});

await check('sessions: a session shared by several tasks marks the messages that cite the task and can list only those', async () => {
  const p = await newPage('light');
  await p.goto(base + '#/task/SHOP-103');
  await p.waitForSelector('#sesslist .sessitem');
  assert.match(await p.locator('#sesslist').innerText(), /Shared with other tasks/i);
  await p.locator('#sesslist .sessitem[data-mixed="1"] .sessrow').first().click();
  await p.waitForSelector('#sesslist .msgs.marking .msg');
  const mine = await p.locator('#sesslist .msg.mine').count(), others = await p.locator('#sesslist .msg:not(.mine)').count();
  assert.ok(mine >= 1 && others >= 1, `expected marked and unmarked messages, got ${mine}/${others}`);
  assert.match(await p.locator('#sesslist .msg.mine').first().innerText(), /SHOP-103/);
  assert.match(await p.locator('#sesslist .msgs.marking .note').first().innerText(), /Highlighted/i, 'the marking is explained on screen');
  await p.locator('#sesslist').scrollIntoViewIfNeeded();
  await shot(p, 'sessions-shared-light.png');
  await p.locator('#sessscope button[data-scope="mine"]').click();
  await p.waitForFunction(() => document.querySelectorAll('#sesslist .msg').length > 0 && document.querySelectorAll('#sesslist .msg:not(.mine)').length === 0);
  await p.context().close();
});

await check('sessions: the page does not overflow on a phone and the long list stays inside its box', async () => {
  const p = await newPage('light', null, { viewport: { width: 390, height: 800 } });
  await p.goto(base + '#/task/SHOP-103');
  await p.waitForSelector('#sesslist .sessitem');
  await p.locator('#sesslist .sessrow').first().click();
  await p.waitForSelector('#sesslist .msg');
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'horizontal overflow on a phone');
  await p.context().close();
});

await check('outdated capsule (SHOP-105): chip on the card, marker on the timeline lane, coverage ring, badge and Update in the capsule view', async () => {
  const p = await newPage('light', null, { view: 'cards' });
  await openHome(p);
  const chip = p.locator('.card[data-key="SHOP-105"] .chip.warn');
  assert.match(await chip.first().innerText(), /Outdated · 3 new/);
  assert.equal(await p.locator('.card[data-key="SHOP-101"]').innerText().then((t) => /Outdated/.test(t)), false, 'an up-to-date capsule must not be flagged');
  assert.match(await p.locator('#coverage-text').innerText(), /1 outdated/);
  await p.click('#view-timeline');
  await p.waitForSelector('.vz-lane');
  const marker = p.locator('.vz-label[data-key="SHOP-105"] i.vz-stale');
  assert.equal(await marker.count(), 1, 'lane marker for the outdated capsule');
  assert.equal(await p.locator('.vz-label[data-key="SHOP-104"] i.vz-stale').count(), 0);
  assert.equal(await p.locator('.vz-label[data-key="SHOP-104"] i:not(.vz-stale)').count(), 1, 'the ✓ stays for ready capsules');
  assert.equal(await p.locator('.vz-label[data-key="SHOP-105"] i:not(.vz-stale)').count(), 1, 'the ✓ stays for the outdated one too');
  await p.goto(base + '#/task/SHOP-105');
  await p.waitForSelector('#detail .stale');
  const badge = await p.locator('#detail .stale .chip.warn').innerText();
  assert.match(badge, /^Outdated: 3 new messages since /);
  assert.match(await p.locator('#detail .stale .hint').innerText(), /regenerates the whole capsule with AI and uses tokens/i);
  assert.equal(await p.locator('#detail #gen').count(), 1);
  await p.context().close();
});

await check('outdated capsule: "See the new messages" lists only the new ones; Update shows the estimate and spends nothing', async () => {
  const p = await newPage('light', null, { view: 'cards' });
  const generates = [];
  p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/generate/.test(r.url())) generates.push(r.url()); });
  await p.goto(base + '#/task/SHOP-105');
  await p.waitForSelector('#detail .stale');
  await p.click('#stale-see');
  await p.waitForFunction(() => document.querySelectorAll('#sesslist .msg.new').length > 0, null, { timeout: 8000 });
  assert.equal(await p.locator('#sesslist .msg.new').count(), 3);
  assert.equal(await p.locator('#sesslist .msg:not(.new)').count(), 0, 'scope "new" lists only the new messages');
  assert.equal(await p.locator('#sesslist .sessitem:not([hidden])').count(), 1, 'only the session with new messages stays visible');
  assert.equal(await p.locator('#sessscope button[aria-pressed="true"]').getAttribute('data-scope'), 'new');
  await settle(p);
  await shot(p, 'stale-new-messages-light.png');
  await p.locator('#sessscope button[data-scope="all"]').click();
  await p.waitForFunction(() => document.querySelectorAll('#sesslist .sessitem:not([hidden])').length === 2, null, { timeout: 8000 });
  await p.locator('#sesslist .sessitem .sessrow').first().click(); // the older session: all its messages predate the capsule
  await p.waitForFunction(() => document.querySelectorAll('#sesslist .msg:not(.new)').length >= 5, null, { timeout: 8000 });
  await p.locator('#detail .stale').scrollIntoViewIfNeeded();
  await p.click('#gen');
  await p.waitForFunction(() => /estimated|tokens|~\$/i.test(document.getElementById('genbox').innerText), null, { timeout: 8000 });
  assert.ok(await p.locator('#ok').count(), 'the confirmation button must appear');
  await p.click('#no');
  await p.evaluate(() => window.scrollTo(0, 0));
  await settle(p);
  await shot(p, 'stale-capsule-light.png');
  assert.deepEqual(generates, [], 'nothing may be generated before the user confirms');
  await p.context().close();
});

await check('outdated capsule and sessions: dark theme screenshots', async () => {
  const p = await newPage('dark');
  await p.goto(base + '#/task/SHOP-105');
  await p.waitForSelector('#detail .stale');
  await settle(p);
  await shot(p, 'stale-capsule-dark.png');
  await p.goto(base + '#/task/SHOP-106');
  await p.waitForSelector('#sesslist .sessitem');
  await p.locator('#sesslist .sessrow').first().click();
  await p.waitForSelector('#sesslist .msg');
  await p.locator('#sesslist').scrollIntoViewIfNeeded();
  await settle(p);
  await shot(p, 'sessions-no-capsule-dark.png');
  await p.context().close();
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
