// Generating capsules with the stand-in claude (whole real stack, no network, no spend). Every test mutates: freshPage.
import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';
import { TaskPage } from '../../pages/task.page.js';

test.use({ serverConfig: presets.fakeClaude });

const SESSION_NO_CAPSULE = 'session:f2a2b2c2'; // "Why does the /orders endpoint return a 500 ..."
const KEY_NO_CAPSULE = 'SHOP-106';
const PAG_A = 'session:f3a3b3c3';
const PAG_B = 'session:f4a4b4c4';
const calls = async (page) => (await (await page.request.get('/api/usage')).json()).total.calls;

test.describe('capsules: generate', () => {
  test('should estimate, ask for confirmation, show progress and produce a capsule for a session unit @smoke', async ({ freshPage }) => {
    const task = new TaskPage(freshPage);
    await task.goto(SESSION_NO_CAPSULE);
    await expect(task.generate).toBeEnabled();
    const before = await calls(freshPage);
    await task.generate.click();
    await expect(freshPage.locator('#ok')).toBeVisible();
    await expect(freshPage.locator('#genbox')).toContainText('1 Claude call');
    await expect(freshPage.locator('#genbox')).toContainText('already known');
    expect(await calls(freshPage)).toBe(before); // the estimate costs nothing
    await freshPage.locator('#ok').click();
    await expect(freshPage.locator('.pg-stages')).toBeVisible();
    await expect(task.timelineRows.first()).toBeVisible({ timeout: 20_000 });
    await expect(task.root).toContainText('Stand-in capsule: Why does the /orders endpoint return a 500');
    await expect(task.root).toContainText('Stand-in decision about');
    await expect(task.root).not.toContainText('An invented decision'); // a decision with an invalid citation is dropped
    await expect(task.stale).toHaveCount(0);
    expect((await calls(freshPage)) - before).toBe(1);
  });

  test('should say no AI selection was needed for a unit whose turns are known @regression', async ({ freshPage }) => {
    const task = new TaskPage(freshPage);
    await task.goto(SESSION_NO_CAPSULE);
    await task.generate.click();
    await freshPage.locator('#ok').click();
    await expect(freshPage.locator('.pg-log')).toContainText(/No AI selection needed: the \d+ messages of this unit/, { timeout: 15_000 });
  });

  test('should ask the model which turns belong to a key unit and announce 4 calls @regression', async ({ freshPage }) => {
    const task = new TaskPage(freshPage);
    await task.goto(KEY_NO_CAPSULE);
    const before = await calls(freshPage);
    await task.generate.click();
    await expect(freshPage.locator('#genbox')).toContainText('4 Claude calls');
    await expect(freshPage.locator('#genbox')).not.toContainText('already known');
    await freshPage.locator('#ok').click();
    await expect(task.timelineRows.first()).toBeVisible({ timeout: 20_000 });
    expect((await calls(freshPage)) - before).toBe(4); // 3 votes + the capsule
  });

  test('should show the new capsule on the home: card, coverage, search @regression', async ({ freshPage }) => {
    const home = new HomePage(freshPage); const task = new TaskPage(freshPage);
    await task.goto(SESSION_NO_CAPSULE);
    await task.generate.click();
    await freshPage.locator('#ok').click();
    await expect(task.timelineRows.first()).toBeVisible({ timeout: 20_000 });
    await home.goto();
    await expect(home.card(SESSION_NO_CAPSULE)).toContainText('Capsule ready');
    await expect(home.card(SESSION_NO_CAPSULE)).toContainText('Stand-in capsule');
    await expect(home.coverage).toContainText('9 of 21 tasks have a capsule');
    await home.searchFor('stand-in');
    await expect(home.card(SESSION_NO_CAPSULE)).toBeVisible();
  });

  test('should cancel a running generation and keep the unit without a capsule @regression', async ({ freshPage }) => {
    const task = new TaskPage(freshPage);
    await task.goto(SESSION_NO_CAPSULE);
    await task.generate.click();
    await freshPage.locator('#ok').click();
    await expect(freshPage.locator('.pg-cancel')).toBeVisible();
    await freshPage.locator('.pg-cancel').click();
    await expect(freshPage.locator('.pg-end')).toContainText(/cancel/i);
    await expect(task.timelineRows).toHaveCount(0);
    const tasks = (await (await freshPage.request.get('/api/tasks')).json()).tasks;
    expect(tasks.find((t) => t.key === SESSION_NO_CAPSULE).has_capsule).toBeFalsy();
  });

  test('should mark a capsule outdated after the unit changes and offer to reuse the old one on the new unit @regression', async ({ freshPage }) => {
    const home = new HomePage(freshPage); const task = new TaskPage(freshPage);
    const merged = await (await freshPage.request.post('/api/units/merge', { data: { keys: [PAG_A, PAG_B], label: 'Products pagination' } })).json();
    await task.goto(merged.unit);
    await expect(task.timelineRows).toHaveCount(0);
    await task.generate.click();
    await freshPage.locator('#ok').click();
    await expect(task.timelineRows.first()).toBeVisible({ timeout: 20_000 });
    await expect(task.stale).toHaveCount(0);
    await freshPage.request.post('/api/units/split', { data: { key: merged.unit } });
    await task.goto(PAG_A);
    await expect(task.timelineRows).toHaveCount(0); // the new unit starts without a capsule
    const prev = freshPage.locator('.panel.prev');
    await expect(prev).toContainText('A capsule from before the change exists');
    await expect(prev).toContainText('Products pagination');
    await prev.locator('.reuse').click();
    await expect(task.timelineRows.first()).toBeVisible();
    await expect(task.stale).toContainText('Outdated: the sessions of this unit changed since');
    await expect(task.stale).toContainText('Reused from Products pagination');
    await home.goto();
    await expect(home.card(PAG_A)).toContainText('Outdated · unit changed');
  });

  test('should clear the outdated notice when the reused capsule is regenerated @regression', async ({ freshPage }) => {
    const task = new TaskPage(freshPage);
    const merged = await (await freshPage.request.post('/api/units/merge', { data: { keys: [PAG_A, PAG_B], label: 'Products pagination' } })).json();
    await task.goto(merged.unit);
    await task.generate.click();
    await freshPage.locator('#ok').click();
    await expect(task.timelineRows.first()).toBeVisible({ timeout: 20_000 });
    await freshPage.request.post('/api/units/split', { data: { key: merged.unit } });
    await task.goto(PAG_A);
    await freshPage.locator('.panel.prev .reuse').click();
    await expect(task.stale).toBeVisible();
    await task.generate.click();
    await freshPage.locator('#ok').click();
    await expect(task.stale).toHaveCount(0, { timeout: 20_000 });
    await expect(freshPage.locator('#genbox .okmsg')).toBeVisible();
  });
});
