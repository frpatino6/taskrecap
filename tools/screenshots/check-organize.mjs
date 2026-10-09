// Maintainer check (not published): "Organize with AI" in a real browser, driving the WHOLE real stack against a stand-in `claude`
// (fake-claude.mjs): no network, no spend. Demo data only, temporary home folder. Run: npm run check-organize
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-organize-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8796'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: path.join(tmp, 'home'), TASKRECAP_CLAUDE: path.join(HERE, 'fake-claude.mjs') }, stdio: ['ignore', 'pipe', 'pipe'],
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });

const api = (p, init) => page.evaluate(([path_, init_]) => fetch(path_, init_).then((r) => r.json()), [p, init]);
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const goHome = async () => {
  await page.goto(base + '#/');
  await page.evaluate(() => { try { localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });
  await page.reload();
  await page.waitForSelector('.card');
  await page.waitForSelector('#organize .organizepanel');
};
const DEMO_BATCH = '9c1d4e7a-2b5f-4a38-8d60-1e3f5a7b9c20'; // the demo's own sample correction (two docs sessions grouped): not something a check did
const resetAll = async () => {
  for (let i = 0; i < 30; i++) {
    const last = (await api('/api/units/history')).last;
    if (!last || last.batch === DEMO_BATCH) break;
    await post('/api/units/undo');
  }
};
const openProposals = async () => { // the list keeps its open/closed state between redraws: open it only when it is closed
  const open = await page.locator('#org-details').evaluate((d) => d.open);
  if (!open) await page.locator('#org-details > summary').click();
  await page.waitForSelector('.orgprop');
};
const toast = () => page.locator('#toast');

await goHome();

await check('the home page offers "Organize with AI" and the sample proposals, closed until opened', async () => {
  const text = await page.locator('#organize').innerText();
  assert.match(text, /Organize your unsorted sessions with AI/);
  assert.match(text, /Proposals \(5\)/);
  assert.equal(await page.locator('#org-run').isEnabled(), true);
  assert.equal(await page.locator('.orgprop:visible').count(), 0, 'the list stays folded');
  await openProposals();
  assert.equal(await page.locator('.orgprop').count(), 5);
  const kinds = await page.locator('.orgprop .orgmeta .chip.ai').allInnerTexts();
  assert.deepEqual(kinds.sort(), ['Name', 'Name', 'Name', 'Same work', 'Split session']);
});

await check('a group shows why, the sessions that would join and evidence that opens the original message', async () => {
  const g = page.locator('.orgprop[data-type="group"]');
  const text = await g.innerText();
  assert.match(text, /Pagination of the products listing/);
  assert.match(text, /Why:/);
  assert.match(text, /High confidence/);
  assert.equal(await g.locator('.orgsessions li').count(), 2);
  await g.locator('button.cite').first().click();
  await page.waitForSelector('#evidence:not([hidden]) .evturn.cited');
  assert.match(await page.locator('#ev-panel').innerText(), /pagination/i);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#evidence', { state: 'hidden' });
});

await check('a cut lists the message ranges with their own evidence and no confidence chip', async () => {
  const s = page.locator('.orgprop[data-type="split"]');
  const text = await s.innerText();
  assert.match(text, /messages 0–7/);
  assert.match(text, /messages 8–15/);
  assert.match(text, /2\.4 release notes/);
  assert.equal(await s.locator('.orgparts > li').count(), 2);
  assert.equal(await s.locator('.chip[class*="conf-"]').count(), 0);
  assert.equal(await s.locator('.orgedit-btn').count(), 0, 'parts are renamed later with Rename, not here');
});

await check('"Accept all high-confidence" is one change with an Undo that brings the proposal back', async () => {
  await page.locator('.orgall').click();
  await page.waitForFunction(() => /accepted/i.test(document.getElementById('toast').innerText));
  assert.match(await toast().innerText(), /1 proposal\(s\) accepted/);
  await page.waitForSelector('.card .chip.ai');
  const card = page.locator('.card', { hasText: 'Pagination of the products listing' });
  assert.equal(await card.count(), 1);
  assert.match(await card.innerText(), /AI-organized/);
  assert.match(await card.innerText(), /Your group/);
  await page.locator('#toast-undo').click();
  await page.waitForFunction(() => document.querySelectorAll('.card .chip.ai').length === 0);
  await openProposals();
  await page.waitForSelector('.orgprop[data-type="group"]');
});

await check('Edit title accepts the user\'s own wording, and Reject is remembered after a reload', async () => {
  const t = page.locator('.orgprop[data-type="title"]').filter({ hasText: 'onboarding guide' });
  await t.locator('.orgedit-btn').click();
  const input = t.locator('.orgedit input');
  await input.fill('Onboarding guide v2');
  assert.match(await t.locator('.orgaccept').innerText(), /Accept with this title/);
  await t.locator('.orgaccept').click();
  await page.waitForSelector('.card:has-text("Onboarding guide v2") .chip.ai');
  const rej = page.locator('.orgprop[data-type="title"]').filter({ hasText: 'Node version' });
  await rej.locator('.orgreject').click();
  await page.waitForFunction(() => /rejected/i.test(document.getElementById('toast').innerText));
  await page.reload();
  await page.waitForSelector('#organize .organizepanel');
  await openProposals();
  assert.equal(await page.locator('.orgprop').filter({ hasText: 'Node version' }).count(), 0, 'a rejected proposal does not come back');
});

await check('accepting the cut makes each range its own unit with only its messages', async () => {
  await page.locator('.orgprop[data-type="split"] .orgaccept').click();
  await page.waitForSelector('.card:has-text("messages 8–15")');
  const part = page.locator('.card', { hasText: 'Write the 2.4 release notes' });
  assert.match(await part.innerText(), /AI-organized/);
  assert.match(await part.innerText(), /messages 8–15/);
  await part.locator('.card').count();
  await part.click();
  await page.waitForSelector('#sesslist .sessitem');
  const row = await page.locator('#sesslist .sessitem').first().innerText();
  assert.match(row, /8 messages/);
  assert.equal(await page.locator('#sesslist .sessmenu').count(), 0, 'a range has no per-session menu');
  await page.locator('#sesslist .sessrow').first().click();
  await page.waitForSelector('#sesslist .msg');
  assert.equal(await page.locator('#sesslist .msg').count(), 8);
  assert.match(await page.locator('#sesslist .msglist').innerText(), /release notes/i);
  await page.goBack();
  await page.waitForSelector('.card');
});

await check('Organize with AI: estimate, confirmation, live progress with real stages, then proposals; nothing is spent before the click', async () => {
  await resetAll();
  await goHome();
  await page.locator('#org-run').click();
  await page.waitForSelector('#orgdlg:not([hidden])');
  await page.waitForSelector('#org-show'); // the demo sessions were already analysed: no tokens needed
  assert.match(await page.locator('#orgdlg').innerText(), /already analysed/);
  await page.locator('#org-again').click();
  await page.waitForSelector('#org-ok');
  const est = await page.locator('#orgdlg').innerText();
  assert.match(est, /Estimated: about .* tokens/);
  assert.match(est, /never the whole conversation/);
  assert.equal((await api('/api/usage')).session.calls, 0, 'asking for the estimate spent nothing');
  await page.locator('#org-ok').click();
  await page.waitForSelector('.pg-stages li[data-id="org_ask"]');
  const stages = await page.locator('.pg-stages li').evaluateAll((els) => els.map((e) => e.dataset.id));
  assert.deepEqual(stages, ['org_scan', 'org_ask', 'org_validate', 'org_save']);
  await page.waitForSelector('.pg-cancel');
  await page.waitForFunction(() => document.getElementById('orgdlg').hidden, null, { timeout: 15000 });
  const used = await api('/api/usage');
  assert.equal(used.session.calls, 1);
  assert.ok(used.session.usd > 0.01);
  assert.match(await toast().innerText(), /proposal\(s\) to review/);
});

await check('cancelling a running organize stops it and leaves the proposals untouched', async () => {
  await resetAll();
  await goHome();
  const before = (await api('/api/organize/proposals')).proposals.length;
  await page.locator('#org-run').click();
  await page.waitForSelector('#org-again, #org-ok');
  if (await page.locator('#org-again').count()) { await page.locator('#org-again').click(); await page.waitForSelector('#org-ok'); }
  await page.locator('#org-ok').click();
  await page.waitForSelector('.pg-cancel');
  await page.locator('.pg-cancel').click();
  await page.waitForSelector('.pg-end');
  assert.match(await page.locator('.pg-end').innerText(), /cancel/i);
  assert.equal((await api('/api/organize/proposals')).proposals.length, before);
  await page.locator('.pg-close').click();
  await page.waitForSelector('#orgdlg', { state: 'hidden' });
  assert.equal(await page.locator('#org-run').isEnabled(), true, 'the button is free again');
});

await check('"Name with AI" on one unsorted session: estimate, progress, then Accept / Edit / Reject right in the dialog', async () => {
  await resetAll();
  await goHome();
  const key = 'session:d4e5f6a7';
  await page.locator(`.cardmenu[data-menu="${key}"]`).first().click();
  await page.waitForSelector('#unitmenu button');
  await page.locator('#unitmenu button', { hasText: 'Name with AI' }).click();
  await page.waitForSelector('#org-ok, #org-show');
  if (await page.locator('#org-again').count()) { await page.locator('#org-again').click(); await page.waitForSelector('#org-ok'); }
  assert.match(await page.locator('#orgdlg').innerText(), /for one title/);
  await page.locator('#org-ok').click();
  await page.waitForSelector('#orgdlg .orgprop[data-type="title"]', { timeout: 15000 }).catch(async (e) => { throw new Error(e.message.split('\n')[0] + ' | dialog: ' + (await page.locator('#orgdlg').innerText()).replace(/\s+/g, ' ').slice(0, 300)); });
  assert.match(await page.locator('#orgdlg').innerText(), /Named by the stand-in model: d4e5f6a7/);
  await page.locator('#orgdlg .orgaccept').click();
  await page.waitForSelector('#orgdlg', { state: 'hidden' });
  await page.waitForSelector(`.card[data-key="${key}"] .chip.ai`);
  assert.match(await page.locator(`.card[data-key="${key}"]`).innerText(), /Named by the stand-in model/);
});

await check('the dialog is a real dialog: labelled, Escape closes it when nothing runs, focus returns', async () => {
  await resetAll();
  await goHome();
  await page.locator('#org-run').focus();
  await page.locator('#org-run').click();
  await page.waitForSelector('#orgdlg:not([hidden]) [role="dialog"], #orgdlg[hidden]');
  assert.equal(await page.locator('#orgdlg .udpanel').getAttribute('role'), 'dialog');
  assert.equal(await page.locator('#orgdlg .udpanel').getAttribute('aria-modal'), 'true');
  await page.waitForSelector('#org-no, #org-show');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#orgdlg', { state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'org-run');
  assert.equal(await page.locator('#org-run').isEnabled(), true);
});

await check('with Claude Code unavailable the organize button is off with an explanation, free review still works', async () => {
  await goHome();
  await page.evaluate(() => { INFO.ai = { available: false, reason: 'not-found', tried: [] }; applyAiGate(); });
  assert.equal(await page.locator('#org-run').isDisabled(), true);
  assert.ok((await page.locator('#org-run').getAttribute('title')).length > 10);
  await openProposals();
  assert.ok(await page.locator('.orgprop').count() >= 1, 'proposals can still be reviewed');
  await page.evaluate(() => { INFO.ai = { available: true }; applyAiGate(); });
  assert.equal(await page.locator('#org-run').isEnabled(), true);
});

await check('Spanish strings exist for every organize key and the page renders in Spanish', async () => {
  const en = await api('/api/strings?lang=en'), es = await api('/api/strings?lang=es');
  const keys = Object.keys(en).filter((k) => /^(org_|stage_org_|ev_organize_|chip_range|range_tip|menu_name_ai|change_cut)/.test(k));
  assert.ok(keys.length >= 50);
  for (const k of keys) assert.ok(es[k] && es[k] !== en[k] || /^(chip_range|org_part_range)$/.test(k) || es[k], k);
  await resetAll();
  await page.evaluate(() => { try { localStorage.setItem('tr-lang', 'es'); } catch (e) { /* ignore */ } });
  await page.reload();
  await page.waitForSelector('#organize .organizepanel');
  assert.match(await page.locator('#organize').innerText(), /Organiza con IA tus sesiones sin clasificar/);
  await page.evaluate(() => { try { localStorage.removeItem('tr-lang'); } catch (e) { /* ignore */ } });
});

await check('phone width: the proposals and the dialog do not overflow the page', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await goHome();
  await openProposals();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on the page');
  await page.locator('#org-run').click();
  await page.waitForSelector('#orgdlg:not([hidden])');
  assert.ok(await page.evaluate(() => { const p = document.querySelector('#orgdlg .udpanel').getBoundingClientRect(); return p.left >= 0 && p.right <= window.innerWidth; }));
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 1000 });
});

await check('no console errors and no failed requests during the whole run', async () => {
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  const unexpected = badResponses.filter((r) => !/^400 \/api\/organize\/accept/.test(r));
  assert.deepEqual(unexpected, []);
});

await browser.close();
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
