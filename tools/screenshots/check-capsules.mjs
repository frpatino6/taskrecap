// Maintainer check (not published): capsules for units WITHOUT a task key, in a real browser. It drives the WHOLE real stack against a
// stand-in `claude` (fake-claude.mjs): no network, no spend. Demo data only, temporary home folder. Run: npm run check-capsules
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-capsules-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8797'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home'), TASKRECAP_CLAUDE: path.join(HERE, 'fake-claude.mjs'), TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: 'en-US', timezoneId: 'UTC' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });

const api = (p, init) => page.evaluate(([path_, init_]) => fetch(path_, init_).then((r) => r.json()), [p, init]);
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const goHome = async (view = 'cards') => {
  await page.goto(base + '#/');
  await page.evaluate((v) => { try { localStorage.setItem('tr-view', v); } catch (e) { /* ignore */ } }, view);
  await page.reload();
  await page.waitForSelector(view === 'cards' ? '.card' : '.vz-lane');
};
const card = (key) => page.locator(`.card[data-key="${key}"]`);
const open = async (key) => { await page.goto(base + '#/task/' + encodeURIComponent(key)); await page.waitForSelector('#detail h1'); };
const shot = async (name, opts = {}) => { if (SHOTS) await page.waitForTimeout(900); if (SHOTS) await page.screenshot({ path: path.join(OUT, name), ...opts }); };

const SESSION_READY = 'session:c7d7e7f7';
const GROUP_READY = 'user:3f2b6c1e-8d4a-4b7e-9a51-0c6d2e7f1a90';
const ORDERS = 'session:f2a2b2c2'; // "Why does the /orders endpoint return a 500 ...": no capsule yet
const PAG_A = 'session:f3a3b3c3';
const PAG_B = 'session:f4a4b4c4';

await goHome();

await check('home: a session without a key and a group of the user show "Capsule ready"; the ones without show "No capsule yet"', async () => {
  const s = await card(SESSION_READY).innerText();
  assert.match(s, /Capsule ready/);
  assert.match(s, /Unsorted/);
  assert.match(s, /Replace the three hand-written price formats/);
  const g = await card(GROUP_READY).innerText();
  assert.match(g, /Search for the docs site/);
  assert.match(g, /Your group/);
  assert.match(g, /Capsule ready/);
  assert.match(await card(ORDERS).innerText(), /No capsule yet/);
  assert.match(await page.locator('#coverage-text').innerText(), /8 of 21 tasks have a capsule/);
  await shot('capsules-cards-light.png');
});

await check('a session unit: the capsule has timeline, decisions, files, commits and the briefing; no "later step" note', async () => {
  await open(SESSION_READY);
  const text = await page.locator('#detail').innerText();
  assert.doesNotMatch(text, /later step/);
  assert.match(text, /Timeline/);
  assert.match(text, /Decisions/);
  assert.match(text, /Use one helper \(formatMoney\)/);
  assert.ok((await page.locator('#detail table.tl2 tbody tr').count()) === 6);
  assert.ok((await page.locator('#detail button.filelink').count()) >= 3, 'files touched are listed');
  assert.match(await page.locator('#briefing').innerText(), /no task key/);
  assert.equal(await page.locator('#detail .stale').count(), 0, 'up to date: no outdated notice');
  assert.ok(await page.locator('#resume').isVisible(), '"Resume this task" is there');
  assert.match(await page.locator('#detail h1').innerText(), /^Prices are shown in three different formats across the shop/);
  await shot('capsules-session-light.png', { fullPage: true });
});

await check('its citations open the original message and verify it; the file index finds the unit', async () => {
  await page.locator('#detail button.cite').first().click();
  await page.waitForSelector('#evidence:not([hidden]) .evturn.cited');
  assert.equal(await page.locator('#evidence .evturn.cited').count(), 1);
  assert.match(await page.locator('#evidence').innerText(), /Prices are shown in three different formats/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#evidence', { state: 'hidden' });
  // from another unit's page, the file shows which units touched it, by their names (never by an internal id)
  const files = await api('/api/files/tasks?path=' + encodeURIComponent('acme-shop/src/lib/money.js'));
  assert.deepEqual(files.tasks.map((t) => [t.key, t.approximate]), [[SESSION_READY, false]]);
  await goHome();
  await page.locator('#filesearch > summary').click();
  await page.fill('#fq', 'lib/money.js');
  await page.waitForSelector('#filelist button.tasklink');
  assert.match(await page.locator('#filelist button.tasklink').first().innerText(), /^Prices are shown in three different formats/);
  await page.fill('#fq', '');
});

await check('a group of two sessions: both sessions are listed and cited; the timeline mixes both days', async () => {
  await open(GROUP_READY);
  assert.equal(await page.locator('#detail h1').innerText(), 'Search for the docs site');
  assert.equal(await page.locator('#sesslist .sessitem').count(), 2);
  const rows = await page.locator('#detail table.tl2 tbody tr td:first-child').allInnerTexts();
  assert.equal(rows.length, 7);
  assert.ok(rows.some((r) => /^09-12/.test(r.trim())) && rows.some((r) => /^09-13/.test(r.trim())));
  const cited = await page.locator('#detail button.cite').evaluateAll((bs) => [...new Set(bs.map((b) => b.dataset.session))].sort());
  assert.deepEqual(cited, ['c8d8e8f8', 'c9d9e9f9']);
  await shot('capsules-group-light.png');
});

await check('search inside capsules finds the words of a unit capsule; the files view lists the unit', async () => {
  await goHome();
  await page.fill('#q', 'highlighted');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card mark').length > 0);
  assert.ok(await card(GROUP_READY).count());
  assert.match(await card(GROUP_READY).innerText(), /Found in/);
  await page.fill('#q', '');
  const files = await api('/api/files/tasks?path=' + encodeURIComponent('acme-docs/src/components/SearchBox.js'));
  assert.deepEqual(files.tasks.map((t) => [t.key, t.approximate]), [[GROUP_READY, false]]);
});

await check('timeline view: units without a key have lanes with the capsule mark', async () => {
  await goHome('timeline');
  await page.click('#vz-more'); // the demo shows its 12 newest lanes first
  await page.waitForFunction(() => document.querySelectorAll('.vz-lane').length === 21);
  const lane = page.locator(`.vz-label[data-key="${SESSION_READY}"]`);
  assert.ok(await lane.count());
  assert.ok(await lane.locator('.vz-key i').count(), 'the ready mark is on the lane');
  assert.match(await lane.getAttribute('aria-label'), /Capsule ready/);
  assert.match(await page.locator(`.vz-label[data-key="${ORDERS}"]`).getAttribute('aria-label'), /No capsule yet/);
  await shot('capsules-timeline-light.png');
});

const generate = async (key, { expectKnown }) => {
  await open(key);
  assert.equal(await page.locator('#detail .note:has-text("later step")').count(), 0);
  await page.waitForSelector('#gen:not([disabled])');
  await page.click('#gen');
  await page.waitForSelector('#ok');
  const est = await page.locator('#genbox').innerText();
  if (expectKnown) { assert.match(est, /1 Claude call/); assert.match(est, /already known/); } else { assert.match(est, /4 Claude calls/); assert.doesNotMatch(est, /already known/); }
  const before = (await api('/api/usage')).total.calls;
  await shot(expectKnown ? 'capsules-estimate-light.png' : 'capsules-estimate-key-light.png');
  await page.click('#ok');
  await page.waitForSelector('.pg-stages');
  await page.waitForSelector('#detail table.tl2 tbody tr', { timeout: 20000 });
  const log = await page.locator('.pg-log, #genbox').first().innerText().catch(() => '');
  return { before, log, after: (await api('/api/usage')).total.calls };
};

await check('generate for a session unit: the estimate says the turns are known, the votes are skipped, one AI call is counted', async () => {
  const r = await generate(ORDERS, { expectKnown: true });
  assert.equal(r.after - r.before, 1, 'one call: the capsule itself');
  const text = await page.locator('#detail').innerText();
  assert.match(text, /Stand-in capsule: Why does the \/orders endpoint return a 500/);
  assert.match(text, /Stand-in decision about/);
  assert.doesNotMatch(text, /An invented decision/, 'a decision with an invalid citation is dropped');
  assert.equal(await page.locator('#detail .stale').count(), 0);
  const done = await page.locator('#genbox').innerText();
  assert.match(done, /Done|Capsule|tokens/i);
  await shot('capsules-generated-light.png', { fullPage: true });
});

await check('the progress log of a unit with known turns says no AI selection was needed', async () => {
  await resetOrders();
  await open(ORDERS);
  await page.click('#gen');
  await page.waitForSelector('#ok');
  await page.click('#ok');
  await page.waitForSelector('.pg-log li');
  await page.waitForFunction(() => /No AI selection needed: the \d+ messages of this unit/.test(document.querySelector('.pg-log').innerText), null, { timeout: 15000 });
  await page.waitForSelector('#detail table.tl2 tbody tr', { timeout: 20000 });
});

async function resetOrders() { // regenerate from scratch: delete nothing, the app overwrites the same capsule
  const t = (await api('/api/tasks')).tasks.find((x) => x.key === ORDERS);
  assert.ok(t.has_capsule);
}

await check('the new capsule shows on the home: card, coverage ring, free search and the timeline lane', async () => {
  await goHome();
  assert.match(await card(ORDERS).innerText(), /Capsule ready/);
  assert.match(await card(ORDERS).innerText(), /Stand-in capsule/);
  assert.match(await page.locator('#coverage-text').innerText(), /9 of 21 tasks have a capsule/);
  await page.fill('#q', 'stand-in');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card mark').length > 0);
  assert.ok(await card(ORDERS).count());
  await page.fill('#q', '');
});

await check('a key unit still asks the model which turns are its own (votes) and says how many calls it will make', async () => {
  const r = await generate('SHOP-106', { expectKnown: false });
  assert.equal(r.after - r.before, 4, '3 votes + the capsule');
});

await check('merge two sessions: the group starts empty, generates a capsule from both sessions (turns known)', async () => {
  const merged = await post('/api/units/merge', { keys: [PAG_A, PAG_B], label: 'Products pagination' });
  assert.ok(merged.unit);
  await open(merged.unit);
  assert.equal(await page.locator('#detail table.tl2').count(), 0, 'no capsule yet');
  assert.equal(await page.locator('.panel.prev').count(), 0, 'the sessions had no capsule to offer');
  const r = await generate(merged.unit, { expectKnown: true });
  assert.equal(r.after - r.before, 1);
  assert.match(await page.locator('#detail').innerText(), /Stand-in capsule: Add pagination to the products listing endpoint/);
  assert.equal(await page.locator('#sesslist .sessitem').count(), 2);
  globalThis.GROUP_NEW = merged.unit;
});

await check('rename keeps the capsule; split makes the sessions new units that are offered the old capsule, marked outdated when reused', async () => {
  const g = globalThis.GROUP_NEW;
  await post('/api/units/rename', { key: g, label: 'Pagination work' });
  await open(g);
  assert.ok(await page.locator('#detail table.tl2').count(), 'the capsule is still there after a rename');
  assert.equal(await page.locator('#detail .stale').count(), 0);
  await post('/api/units/split', { key: g });
  await open(PAG_A);
  assert.equal(await page.locator('#detail table.tl2').count(), 0, 'the new unit starts without a capsule');
  const prev = page.locator('.panel.prev');
  await prev.waitFor();
  assert.match(await prev.innerText(), /A capsule from before the change exists/);
  assert.match(await prev.innerText(), /Products pagination/, 'named as it was when the capsule was written');
  await shot('capsules-previous-light.png');
  await prev.locator('.reuse').click();
  await page.waitForSelector('#detail table.tl2 tbody tr');
  const stale = await page.locator('#detail .stale').innerText();
  assert.match(stale, /Outdated: the sessions of this unit changed since/);
  assert.match(stale, /Reused from Products pagination/);
  await shot('capsules-reused-outdated-light.png', { fullPage: true });
  await goHome();
  assert.match(await card(PAG_A).innerText(), /Outdated · unit changed/);
  // the capsule of the dissolved group is still on disk
  const files = fs.readdirSync(path.join(tmp, 'home', 'demo-cache')).filter((n) => /^user_[0-9a-f-]{36}-[0-9a-f]{8}\.json$/.test(n));
  assert.equal(files.length, 2, 'the sample group capsule and the dissolved one are both kept');
});

await check('regenerating the reused unit clears the notice', async () => {
  await open(PAG_A);
  await page.click('#gen');
  await page.waitForSelector('#ok');
  await page.click('#ok');
  await page.waitForFunction(() => !document.querySelector('.stale') && document.querySelector('#genbox .okmsg'), null, { timeout: 20000 });
});

await check('phone width: the capsule page of a unit without a key does not overflow', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(GROUP_READY);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await open(PAG_A);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.setViewportSize({ width: 1280, height: 1000 });
});

await check('no console errors and no failed requests during the whole run', async () => {
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  assert.deepEqual(badResponses, []);
});

await browser.close();
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
