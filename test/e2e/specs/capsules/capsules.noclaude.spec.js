import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';
import { TaskPage } from '../../pages/task.page.js';

test.use({ serverConfig: presets.noClaude });

test.describe('capsules: claude is not installed', () => {
  test('should disable generate with the reason and how to fix it, on a task with and without a capsule @smoke', async ({ page }) => {
    const task = new TaskPage(page);
    for (const key of ['SHOP-101', 'SHOP-106']) {
      await task.goto(key);
      await expect(task.generate).toBeDisabled();
      await expect(page.locator('#genbox')).toContainText('AI actions are unavailable');
    }
    for (const text of ['--claude-path', 'TASKRECAP_CLAUDE', 'taskrecap doctor', 'Check again']) await expect(page.locator('#genbox')).toContainText(text);
  });

  test('should disable the home AI search with a tooltip and an explanation note, free search keeps working @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(page.locator('#ai-search')).toBeDisabled();
    await expect(page.locator('#ai-search')).toHaveAttribute('title', /Claude Code/);
    await expect(page.locator('#ai-note')).toContainText('AI actions are unavailable');
    await home.searchFor('rounding');
    await expect(home.cards.first()).toBeVisible();
  });

  test('should keep AI off when "Check again" still finds nothing @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto('SHOP-106');
    await page.locator('#genbox .ai-recheck').click();
    await expect(page.locator('#genbox .ai-recheck-msg')).toContainText('Still not available');
    await expect(task.generate).toBeDisabled();
  });
});
