import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { EvidencePanel } from '../../pages/evidence.panel.js';

test.describe('home: free search', () => {
  let home;
  test.beforeEach(async ({ page }) => { home = new HomePage(page); await home.goto(); });

  test('should return the task whose capsule contains the words, highlighted @smoke', async () => {
    await home.searchFor('integer cents');
    await expect(home.card('SHOP-101')).toBeVisible();
    await expect(home.card('SHOP-101').locator('mark').first()).toBeVisible();
    await expect(home.card('SHOP-101')).toContainText('Found in');
    await expect(home.card('API-212')).toHaveCount(0);
  });

  test('should find a unit that has no task key by what its capsule says @regression', async () => {
    await home.searchFor('highlighted');
    await expect(home.card('user:3f2b6c1e-8d4a-4b7e-9a51-0c6d2e7f1a90')).toContainText('Found in');
  });

  test('should bring every card back when the search is cleared @regression', async () => {
    await home.searchFor('integer cents');
    await expect(home.card('API-212')).toHaveCount(0);
    await home.search.fill('');
    await expect(home.card('API-212')).toBeVisible();
    await expect(home.cards).toHaveCount(21);
  });

  test('should show an "In messages" section for words that exist only inside a message, and open it in the evidence panel @regression', async () => {
    const evidence = new EvidencePanel(home.page);
    await home.searchFor('tombstone');
    await expect(home.msgHits.locator('h2')).toHaveText(/In messages/);
    await expect(home.msgHits.locator('.msghit mark').first()).toBeVisible();
    await expect(home.noResults).toBeHidden();
    await home.msgHits.locator('.msghit').first().click();
    await expect(evidence.cited).toContainText(/tombstone/);
  });

  test('should show the empty state and suggest AI search by meaning when nothing matches @regression', async () => {
    await home.searchFor('zzqqxxnonexistent');
    await expect(home.noResults).toBeVisible();
    await expect(home.cards).toHaveCount(0);
    await expect(home.page.locator('#none-hint')).toContainText('Free search is literal');
    await expect(home.noResultsAi).toHaveText('Try AI search by meaning…');
  });
});
