// AI search by meaning with the stand-in claude: it asks for an estimate and a confirmation first and never starts by itself.
import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';

test.use({ serverConfig: presets.fakeClaude });

const calls = async (request) => (await (await request.get('/api/usage')).json()).total.calls;

test.describe('search: AI search', () => {
  test('should never run on its own: typing and a no-results page spend nothing @smoke', async ({ page, request }) => {
    const home = new HomePage(page);
    await home.goto();
    await home.searchFor('zzqqxxnonexistent');
    await expect(home.noResultsAi).toBeVisible();
    await expect(page.locator('#aibox')).toBeEmpty();
    expect(await calls(request)).toBe(0);
  });

  test('should ask for a query first when the box is empty @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await page.locator('#ai-search').click();
    await expect(page.locator('#aibox')).toContainText('Type what you are looking for first.');
  });

  test('should show an estimate, let the user cancel it, and spend nothing @regression', async ({ page, request }) => {
    const home = new HomePage(page);
    await home.goto();
    await home.searchFor('checkout rounding');
    await page.locator('#ai-search').click();
    await expect(page.locator('#ai-ok')).toBeVisible();
    await expect(page.locator('#aibox')).toContainText(/tokens/);
    await page.locator('#ai-no').click();
    await expect(page.locator('#aibox')).toBeEmpty();
    expect(await calls(request)).toBe(0);
  });

  test('should run after the confirmation, count one call and show the result block @regression', async ({ page, request }) => {
    const home = new HomePage(page);
    await home.goto();
    await home.searchFor('checkout rounding');
    await page.locator('#ai-search').click();
    await page.locator('#ai-ok').click();
    await expect(page.locator('#airesults h2')).toContainText('checkout rounding', { timeout: 20_000 });
    await expect(page.locator('#aibox .okmsg')).toBeVisible();
    expect(await calls(request)).toBe(1);
    await page.locator('#ai-clear').click();
    await expect(page.locator('#airesults')).toBeEmpty();
  });

  test('should start the same flow from the "Try AI search by meaning" suggestion @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await home.searchFor('zzqqxxnonexistent');
    await home.noResultsAi.click();
    await expect(page.locator('#ai-ok')).toBeVisible();
  });
});
