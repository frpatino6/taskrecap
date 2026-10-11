import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { TaskPage } from '../../pages/task.page.js';

test.describe('states: unknown routes and API errors', () => {
  test('should show a clean "Unknown task" message with a retry for an unknown task key @regression', async ({ page }) => {
    await page.goto('/#/task/NOPE-999');
    const err = page.locator('#detail .err');
    await expect(err).toBeVisible();
    await expect(err).toContainText('Unknown task');
    await expect(page.locator('#detail-retry')).toBeVisible();
    await expect(page.locator('#detail h1')).toHaveCount(0);
  });

  test('should still reach the home from an unknown task page @regression', async ({ page }) => {
    await page.goto('/#/task/NOPE-999');
    await expect(page.locator('#detail .err')).toBeVisible();
    await page.goto('/#/');
    await expect(new HomePage(page).cards.first()).toBeVisible();
  });

  test('should show the home for an unknown hash route @regression', async ({ page }) => {
    await page.goto('/#/does/not/exist');
    await expect(new HomePage(page).cards.first()).toBeVisible();
  });

  test('should answer an unknown API route with 404 JSON and an unknown file with 404 @regression', async ({ request }) => {
    const api = await request.get('/api/nope');
    expect(api.status()).toBe(404);
    expect((await api.json()).error).toBe('Not found');
    expect((await request.get('/nope.txt')).status()).toBe(404);
  });

  test('should recover with Retry after a transient API failure on a task page @regression', async ({ page }) => {
    let fail = true;
    await page.route('**/api/tasks/SHOP-101', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Boom"}' }) : route.continue()));
    await page.goto('/#/task/SHOP-101');
    await expect(page.locator('#detail .err')).toContainText('Boom');
    fail = false;
    await page.locator('#detail-retry').click();
    await expect(new TaskPage(page).heading).toHaveText('SHOP-101');
  });

  test('should report a failed unit action instead of failing silently @regression', async ({ freshPage }) => {
    const home = new HomePage(freshPage);
    await home.goto();
    await freshPage.route('**/api/units/rename', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Type a name first."}' }));
    await home.openCardMenu('session:f3a3b3c3');
    await home.menu.choose('Rename');
    await home.dialog.name.fill('Whatever');
    await home.dialog.ok.click();
    await expect(freshPage.locator('#ud-err')).toHaveText('Type a name first.');
    await expect(home.dialog.root).toBeVisible();
    await expect(home.dialog.ok).toBeEnabled();
  });

  test('should show the server error in a toast when Undo fails @regression', async ({ freshPage }) => {
    const home = new HomePage(freshPage);
    await home.goto();
    await freshPage.route('**/api/units/undo', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Nothing to undo."}' }));
    await home.openCardMenu('session:f3a3b3c3');
    await home.menu.choose('Undo last change');
    await expect(home.toast.root).toHaveText('Nothing to undo.');
  });

  test('should render the home even if the search API fails @regression', async ({ page }) => {
    await page.route('**/api/search**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
    const home = new HomePage(page);
    await home.goto();
    await home.searchFor('anything');
    await expect(home.cards.first()).toBeVisible();
  });
});
