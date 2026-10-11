import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';

test.describe('home: task cards', () => {
  let home;
  test.beforeEach(async ({ page }) => { home = new HomePage(page); await home.goto(); });

  test('should show key, repo, session count and capsule state on a task card @regression', async () => {
    const card = home.card('SHOP-101');
    await expect(card).toContainText('SHOP-101');
    await expect(card).toContainText('acme-shop');
    await expect(card).toContainText('1 session');
    await expect(card).toContainText('Capsule ready');
  });

  test('should count the sessions of a task with several sessions @regression', async () => {
    await expect(home.card('DOCS-31')).toContainText('3 sessions');
    await expect(home.card('API-212')).toContainText('3 sessions');
  });

  test('should say "No capsule yet" on a task that has none @regression', async () => {
    await expect(home.card('SHOP-106')).toContainText('No capsule yet');
    await expect(home.card('SHOP-106')).not.toContainText('Capsule ready');
  });

  test('should flag a capsule that is outdated with the number of new messages @regression', async () => {
    await expect(home.card('SHOP-105')).toContainText('Capsule ready');
    await expect(home.card('SHOP-105')).toContainText('Outdated · 3 new');
    await expect(home.card('SHOP-101')).not.toContainText('Outdated');
  });

  test('should show a branch as its own kind of unit @regression', async () => {
    await expect(home.card('feature/search-autocomplete')).toContainText('acme-shop');
    await expect(home.card('feature/search-autocomplete')).toContainText('Capsule ready');
  });

  test('should report how many tasks have a capsule @regression', async () => {
    await expect(home.coverage).toHaveText('8 of 21 tasks have a capsule · 1 outdated');
  });

  test('should keep the home view the user chose after a reload @regression', async ({ page }) => {
    await page.locator('#view-timeline').click();
    await expect(page.locator('.vz-lane').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.vz-lane').first()).toBeVisible();
    await page.locator('#view-cards').click();
    await expect(home.cards.first()).toBeVisible();
  });
});
