import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';

test.describe('home: filters', () => {
  test('should narrow the timeline to one repository and reset it @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await page.locator('#view-timeline').click();
    const lanes = page.locator('.vz-label');
    await expect(lanes.first()).toBeVisible();
    const before = await lanes.count();
    await page.locator('#vz-repo').selectOption({ label: 'acme-docs' });
    await expect.poll(() => lanes.count()).toBeLessThan(before);
    expect(await lanes.count()).toBeGreaterThan(0);
    await page.locator('#vz-reset').click();
    await expect.poll(() => lanes.count()).toBe(before);
  });

  test('should show only the tasks WITHOUT a capsule when the coverage badge is pressed, and show all again @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    const all = await home.cards.count();
    await page.locator('#coverage').click();
    await expect(page.locator('#capfilter')).toBeVisible();
    await expect(page.locator('#capfilter-text')).toHaveText('Showing only tasks without a capsule');
    await expect(home.card('SHOP-106')).toBeVisible();
    await expect(home.card('SHOP-101')).toHaveCount(0);
    await page.locator('#capfilter-clear').click();
    await expect(home.cards).toHaveCount(all);
  });
});
