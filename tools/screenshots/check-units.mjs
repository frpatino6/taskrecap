// Maintainer check (not published): the work-unit views and corrections in a real browser. Demo data only; the server runs on a
// temporary home folder and no model is ever called. Run: npm run check-units
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-units-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8794'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
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
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
let aiCalls = 0;
await page.route('**/api/generate', (r) => { aiCalls += 1; return r.abort(); });
await page.route('**/api/ai-search', (r) => { aiCalls += 1; return r.abort(); });

const A = 'session:f3a3b3c3'; // "Add pagination to the products listing endpoint ..."
const B = 'session:f4a4b4c4'; // "Write tests for the products pagination edge cases ..."
const C = 'session:f2a2b2c2'; // "Why does the /orders endpoint return a 500 ..."
const card = (key) => page.locator(`.card[data-key="${key}"]`);
const cardMenu = (key) => page.locator(`.cardmenu[data-menu="${key}"]`).first();
const goHome = async (view = 'cards') => {
  await page.goto(base + '#/');
  await page.evaluate((v) => { try { localStorage.setItem('tr-view', v); } catch (e) { /* ignore */ } }, view);
  await page.reload();
  await page.waitForSelector(view === 'cards' ? '.card' : '.vz-lane');
};
const openMenu = async (button) => { await button.click(); await page.waitForSelector('#unitmenu button'); }; // the menu fills in a moment later: it asks for the Undo label
const menuItems = () => page.locator('#unitmenu button').allInnerTexts();
const clickMenu = async (text) => { await page.locator('#unitmenu button', { hasText: text }).first().click(); };
const toast = () => page.locator('#toast');
const resetAll = async () => { // undo everything the checks did, so each one starts from the automatic state
  for (let i = 0; i < 20; i++) {
    const last = await page.evaluate(() => fetch('/api/units/history').then((x) => x.json()).then((h) => h.last));
    if (!last) break;
    await page.evaluate(() => fetch('/api/units/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  }
};

await goHome('cards');

await check('unsorted sessions are their own cards with the Unsorted chip and a fallback-free title', async () => {
  assert.ok(await card(A).count(), 'a card for the pagination session');
  const text = await card(A).innerText();
  assert.match(text, /Unsorted/);
  assert.match(text, /Add pagination to the products listing endpoint/);
  assert.equal(await card('unassigned').count(), 0);
  assert.ok((await page.locator('.cardwrap').count()) >= 18);
});

await check('related hint on the card (same repo, within 2 hours) and no merge button on it', async () => {
  const t = await card(A).innerText();
  assert.match(t, /Related: .*Write tests for the products pagination/);
  assert.equal(await card(A).locator('button').count(), 0, 'the hint is plain text, not a control');
});

await check('sessions without content are folded into ONE group, closed by default, with the count', async () => {
  const group = page.locator('#emptygroup');
  assert.ok(await group.isVisible());
  assert.match(await group.locator('summary').innerText(), /Sessions without content \(4\)/);
  assert.equal(await page.locator('#emptydet').evaluate((d) => d.open), false);
  assert.equal(await page.locator('.card[data-key="session:f6a6b6c6"]').count(), 0, 'no card for a greeting');
  await group.locator('summary').click();
  assert.equal(await page.locator('#emptygroup .emptyrow').count(), 4);
  await page.locator('#emptygroup .emptyopen').first().click();
  await page.waitForSelector('#detail h1');
  assert.ok(/#\/task\/session/.test(page.url()), 'still inspectable: it opens its own page');
  await page.goBack();
});

await check('card menu: Rename, Merge, Move, Hide and a disabled Undo; Esc closes and returns focus; arrows move', async () => {
  await goHome();
  await openMenu(cardMenu(A));
  const items = await menuItems();
  assert.deepEqual(items.map((s) => s.replace(/\(.*\)/, '').trim()), ['Rename…', 'Merge with…', 'Move session…', 'Hide', 'Nothing to undo']);
  assert.equal(await page.locator('#unitmenu button:last-child').isDisabled(), true);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Rename…');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Merge with…');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#unitmenu').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'cardmenu');
});

await check('rename: dialog, Enter saves, toast with Undo, new title; Undo restores; the name survives a reload', async () => {
  await goHome();
  await openMenu(cardMenu(A));
  await clickMenu('Rename');
  assert.ok(await page.locator('#unitdlg').isVisible());
  await page.locator('#ud-name').fill('Products pagination');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#toast:not([hidden])');
  assert.match(await toast().innerText(), /Name saved/);
  assert.match(await card(A).innerText(), /Products pagination/);
  await page.reload();
  await page.waitForSelector('.card');
  assert.match(await card(A).innerText(), /Products pagination/, 'persisted on the server');
  await openMenu(cardMenu(A));
  assert.match((await menuItems()).at(-1), /Undo last change \(rename\)/);
  await clickMenu('Undo last change');
  await page.waitForFunction((k) => !document.querySelector(`.card[data-key="${k}"]`).innerText.includes('Products pagination'), A);
  assert.match(await card(A).innerText(), /Add pagination to the products listing endpoint/);
});

await check('dialogs: Escape and Cancel close them without changing anything', async () => {
  await goHome();
  await openMenu(cardMenu(A));
  await clickMenu('Rename');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#unitdlg').isHidden(), true);
  await openMenu(cardMenu(A));
  await clickMenu('Hide');
  assert.ok(await page.locator('#unitdlg').isVisible());
  await page.locator('#ud-cancel').click();
  assert.equal(await page.locator('#unitdlg').isHidden(), true);
  assert.equal(await card(A).count(), 1);
});

await check('merge: two cards become one group of yours; Undo and Split bring them back', async () => {
  await goHome();
  await openMenu(cardMenu(A));
  await clickMenu('Merge with');
  await page.locator('#ud-target').selectOption({ value: B });
  await page.locator('#ud-name').fill('Pagination work');
  await page.locator('#ud-ok').click();
  await page.waitForFunction(() => !document.querySelector('#unitdlg') || document.querySelector('#unitdlg').hidden);
  await page.waitForSelector('.card:has-text("Pagination work")');
  assert.equal(await card(A).count(), 0);
  assert.equal(await card(B).count(), 0);
  const groupCard = page.locator('.card:has-text("Pagination work")');
  assert.match(await groupCard.innerText(), /Your group/);
  assert.match(await groupCard.innerText(), /2 sessions/);
  const key = await groupCard.getAttribute('data-key');
  await openMenu(page.locator(`.cardmenu[data-menu="${key}"]`));
  assert.ok((await menuItems()).some((t) => /Split group/.test(t)));
  await clickMenu('Split group');
  await page.locator('#ud-ok').click();
  await page.waitForSelector(`.card[data-key="${A}"]`);
  assert.equal(await page.locator(`.card[data-key="${key}"]`).count(), 0);
  await page.locator('#toast-undo').click(); // undo the split: the group is back
  await page.waitForSelector(`.card[data-key="${key}"]`);
  await resetAll();
});

await check('hide: confirmation, the card leaves, "Hidden (1)" lists it, Show again brings it back', async () => {
  await goHome();
  await openMenu(cardMenu(C));
  await clickMenu('Hide');
  assert.match(await page.locator('#ud-title').innerText(), /Hide “/);
  await page.locator('#ud-ok').click();
  await page.waitForFunction((k) => !document.querySelector(`.card[data-key="${k}"]`), C);
  const hidden = page.locator('#hiddenbox');
  assert.ok(await hidden.isVisible());
  assert.match(await hidden.locator('summary').innerText(), /Hidden \(1\)/);
  await hidden.locator('summary').click();
  await hidden.locator('[data-unhide-unit]').click();
  await page.waitForSelector(`.card[data-key="${C}"]`);
  assert.ok(await hidden.isHidden());
});

await check('unit page: Actions menu, related sessions as links, no capsule button but a clear note, Sessions list works', async () => {
  await goHome();
  await card(A).click();
  await page.waitForSelector('#detail h1');
  assert.match(await page.locator('#detail h1').innerText(), /Add pagination/);
  assert.ok(await page.locator('#unit-menu').isVisible());
  assert.match(await page.locator('.relbox').innerText(), /Related/);
  assert.ok(await page.locator('.relbox .relopen').count());
  assert.equal(await page.locator('#gen').count(), 0, 'no generate button for a session unit');
  assert.match(await page.locator('#detail .note').first().innerText(), /later step/);
  await page.locator('#sess-jump').click(); // jumps to the Sessions section and opens its first session
  assert.equal(await page.locator('#sesslist .sessitem').count(), 1);
  await page.waitForSelector('#sesslist .msg');
  assert.ok(await page.locator('#sesslist .sessmenu').isVisible());
});

await check('move a session from the unit page into a new group, then Undo', async () => {
  await goHome();
  await card(C).click();
  await page.waitForSelector('#detail h1');
  await openMenu(page.locator('#sesslist .sessmenu'));
  await clickMenu('Move to another unit');
  await page.locator('#ud-target').selectOption({ value: 'new' });
  assert.ok(await page.locator('#ud-name').isVisible());
  await page.locator('#ud-name').fill('Orders bug');
  await page.locator('#ud-ok').click();
  await page.waitForFunction(() => /#\/task\/user/.test(location.hash));
  await page.waitForSelector('#detail h1:has-text("Orders bug")');
  await page.locator('#toast-undo').click();
  await page.waitForFunction(() => /Change undone/.test(document.getElementById('toast').innerText));
  await resetAll();
});

await check('timeline: unsorted lanes carry a marker and a menu; sessions without content are counted, not drawn', async () => {
  await goHome('timeline');
  const lane = page.locator(`.vz-label[data-key="${A}"]`);
  assert.ok(await lane.count());
  assert.match(await lane.innerText(), /Unsorted/); assert.match(await lane.locator('.vz-sub').innerText(), /^Unsorted/);
  assert.match(await lane.innerText(), /Related:/);
  assert.equal(await page.locator('.vz-label[data-key="session:f6a6b6c6"]').count(), 0);
  assert.match(await page.locator('.vz-foot').innerText(), /4 sessions without content are folded below/);
  assert.ok(await page.locator('#emptygroup').isVisible(), 'the folded group is also under the timeline');
  await openMenu(page.locator(`.lanemenu[data-menu="${A}"]`));
  assert.ok((await menuItems()).some((t) => /Rename/.test(t)));
  await page.keyboard.press('Escape');
});

await check('phone width: no horizontal overflow on the home (cards, group) and the dialogs fit', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await goHome('cards');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'home overflows');
  await openMenu(cardMenu(A));
  await clickMenu('Rename');
  const box = await page.locator('.udpanel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'dialog fits the screen');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
});

await check('dark theme: the new controls keep readable contrast (menu, dialog, chips use theme colours)', async () => {
  await goHome('cards');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.cardmenu')).backgroundColor);
  assert.notEqual(bg, 'rgb(255, 255, 255)', 'the menu button follows the dark surface');
  await openMenu(cardMenu(A));
  const menuBg = await page.evaluate(() => getComputedStyle(document.getElementById('unitmenu')).backgroundColor);
  assert.notEqual(menuBg, 'rgb(255, 255, 255)');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
});

await check('nothing called the AI and the console stayed clean', async () => {
  assert.equal(aiCalls, 0);
  assert.deepEqual(errors, [], errors.join(' | ') + ' :: ' + badResponses.join(' | '));
});

await browser.close();
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
