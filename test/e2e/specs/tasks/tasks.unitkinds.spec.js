import { test, expect } from '../../fixtures/app.js';
import { TaskPage } from '../../pages/task.page.js';

const SESSION_UNIT = 'session:c7d7e7f7'; // a session with no key and a ready capsule
const GROUP_UNIT = 'user:3f2b6c1e-8d4a-4b7e-9a51-0c6d2e7f1a90'; // a group of two sessions made by the user

test.describe('tasks: capsules of units without a task key', () => {
  test('should show the capsule of a single unsorted session @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto(SESSION_UNIT);
    await expect(task.heading).toHaveText(/^Prices are shown in three different formats across the shop/);
    await expect(task.timelineRows).toHaveCount(6);
    await expect(task.section('Decisions and why')).toContainText('Use one helper (formatMoney)');
    await expect(task.fileLinks.first()).toBeVisible();
    await expect(task.briefing).toContainText('no task key');
    await expect(task.root).not.toContainText('later step');
    await expect(task.stale).toHaveCount(0);
  });

  test('should show the capsule of a group of two sessions with both sessions listed @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto(GROUP_UNIT);
    await expect(task.heading).toHaveText('Search for the docs site');
    await expect(task.sessions).toHaveCount(2);
    await expect(task.timelineRows).toHaveCount(7);
    const sessions = await task.cites.evaluateAll((bs) => [...new Set(bs.map((b) => b.dataset.session))].sort());
    expect(sessions).toEqual(['c8d8e8f8', 'c9d9e9f9']);
  });

  test('should offer to generate a capsule for a session that has none @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto('session:f2a2b2c2');
    await expect(task.generate).toBeVisible();
    await expect(task.section('Timeline')).toHaveCount(0);
    await expect(task.root).toContainText('No capsule yet');
  });
});
