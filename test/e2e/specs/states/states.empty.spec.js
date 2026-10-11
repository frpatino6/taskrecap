// A real (not demo) server pointed at a projects folder with zero sessions.
import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';

test.use({ serverConfig: presets.emptySessions });

test.describe('states: no sessions at all', () => {
  test('should show the empty message with a hint and no crash @smoke', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const home = new HomePage(page);
    await page.goto('/#/');
    await expect(home.noResults).toBeVisible();
    await expect(page.locator('#none')).toHaveText('No Claude Code sessions found. Run Claude Code in a project first, or try --demo.');
    await expect(home.cards).toHaveCount(0);
    await expect(page.locator('#viewbar')).toBeHidden();
    await expect(page.locator('#coverage')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('should answer the APIs with empty lists, not errors @regression', async ({ request }) => {
    expect((await (await request.get('/api/tasks')).json()).tasks).toEqual([]);
    const tl = await request.get('/api/timeline');
    expect(tl.ok()).toBe(true);
    expect((await tl.json()).lanes).toEqual([]);
    const search = await (await request.get('/api/search?q=anything')).json();
    expect(search.hits).toEqual([]);
    expect(search.messages).toEqual([]);
    expect((await (await request.get('/api/files?q=')).json()).files).toEqual([]);
  });

  test('should give a clean message for any task key and keep the home reachable @regression', async ({ page }) => {
    await page.goto('/#/task/ABC-1');
    await expect(page.locator('#detail .err')).toContainText('Unknown task');
    await page.goto('/#/');
    await expect(page.locator('#none')).toBeVisible();
  });
});
