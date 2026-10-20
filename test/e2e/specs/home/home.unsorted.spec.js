import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';

const PAGINATION = 'session:f3a3b3c3'; // "Add pagination to the products listing endpoint ...", no key, no branch
const TESTS = 'session:f4a4b4c4'; // "Write tests for the products pagination edge cases ..."
const NO_CONTENT = 'session:f6a6b6c6'; // only a greeting

test.describe('home: unsorted sessions and sessions without content', () => {
  let home;
  test.beforeEach(async ({ page }) => { home = new HomePage(page); await home.goto(); });

  test('should show a session without key or branch as its own card with the Unsorted chip @regression', async () => {
    const card = home.card(PAGINATION);
    await expect(card).toContainText('Unsorted');
    await expect(card).toContainText('Add pagination to the products listing endpoint');
    await expect(home.card('unassigned')).toHaveCount(0);
  });

  test('should hint at a related session (same repo, close in time) as plain text @regression', async () => {
    const card = home.card(PAGINATION);
    await expect(card).toContainText(/Related: .*Write tests for the products pagination/);
    await expect(card.locator('button')).toHaveCount(0);
    await expect(home.card(TESTS)).toContainText('Related:');
  });

  test('should fold the sessions without content into ONE closed group with their count @regression', async () => {
    await expect(home.emptyGroup.locator('summary')).toHaveText('Sessions without content (4)');
    await expect(home.page.locator('#emptydet')).not.toHaveAttribute('open', '');
    await expect(home.card(NO_CONTENT)).toHaveCount(0);
  });

  test('should list the folded sessions and still let me open one @regression', async ({ page }) => {
    await home.emptyGroup.locator('summary').click();
    await expect(home.emptyGroup.locator('.emptyrow')).toHaveCount(4);
    await home.emptyGroup.locator('.emptyopen').first().click();
    await expect(page.locator('#detail h1')).toBeVisible();
    await expect(page).toHaveURL(/#\/task\/session/);
  });
});
