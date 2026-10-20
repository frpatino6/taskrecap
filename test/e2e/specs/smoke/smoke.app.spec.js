import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { TaskPage } from '../../pages/task.page.js';

test.describe('smoke: the app starts and the main path works', () => {
  test('should load the home with the app title and the demo banner @smoke', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(page).toHaveTitle('taskrecap');
    await expect(home.title).toHaveText('Which task do you want to get back to?');
    await expect(home.banner).toHaveText('Demo mode: fictional sessions, nothing of yours is shown');
  });

  test('should show the task cards of the demo @smoke', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(home.card('SHOP-101')).toBeVisible();
    await expect(home.card('API-212')).toBeVisible();
    expect(await home.cards.count()).toBeGreaterThanOrEqual(18);
  });

  test('should open a task from its card and come back @smoke', async ({ page }) => {
    const home = new HomePage(page);
    const task = new TaskPage(page);
    await home.goto();
    await home.openTask('SHOP-101');
    await expect(page).toHaveURL(/#\/task\/SHOP-101$/);
    await expect(task.heading).toHaveText('SHOP-101');
    await expect(task.section('Timeline')).toBeVisible();
    await task.back.click();
    await expect(home.card('SHOP-101')).toBeVisible();
  });

  test('should answer the API of the running server @smoke', async ({ request }) => {
    const res = await request.get('/api/tasks');
    expect(res.ok()).toBe(true);
    expect((await res.json()).tasks.length).toBeGreaterThan(20);
  });
});
