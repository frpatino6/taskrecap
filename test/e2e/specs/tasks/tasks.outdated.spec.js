import { test, expect } from '../../fixtures/app.js';
import { TaskPage } from '../../pages/task.page.js';

test.describe('tasks: an outdated capsule', () => {
  test('should show the outdated banner with the new messages and an update button @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto('SHOP-105');
    await expect(task.stale).toBeVisible();
    await expect(task.stale).toContainText(/Outdated: 3 new messages since/);
    await expect(page.locator('#stale-see')).toBeVisible();
    await expect(task.generate).toHaveText('Update with AI…');
  });

  test('should still show the old capsule content under the banner @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto('SHOP-105');
    await expect(task.section('Timeline')).toBeVisible();
    await expect(task.timelineRows.first()).toBeVisible();
  });
});
