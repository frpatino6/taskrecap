import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { EvidencePanel } from '../../pages/evidence.panel.js';

test.describe('search: free search', () => {
  let home;
  test.beforeEach(async ({ page }) => { home = new HomePage(page); await home.goto(); });

  test('should find a task by its key @smoke', async () => {
    await home.searchFor('SHOP-101');
    await expect(home.card('SHOP-101')).toBeVisible();
    await expect(home.card('API-212')).toHaveCount(0);
  });

  test('should find a task by words of its title or first prompt and say why @regression', async () => {
    await home.searchFor('orders endpoint');
    const card = home.card('session:f2a2b2c2');
    await expect(card).toBeVisible();
    await expect(card.locator('.hitwhy').first()).toContainText('Matched the task name, repos or first prompt');
  });

  test('should find a task by the text of its capsule, with the "Found in" reason and the highlighted words @smoke', async () => {
    await home.searchFor('integer cents');
    const card = home.card('SHOP-101');
    await expect(card.locator('.hitwhy b').first()).toContainText('Found in');
    await expect(card.locator('mark').first()).toBeVisible();
    await expect(card.locator('mark').first()).toHaveText(/integer|cents/i);
  });

  test('should explain how much free search looked at @regression', async ({ page }) => {
    await home.searchFor('integer cents');
    await expect(page.locator('#search-scope')).toContainText('Free search looked inside');
    await expect(page.locator('#search-scope')).toContainText('The text of your messages is searched too.');
  });

  test('should be case and accent insensitive @regression', async () => {
    await home.searchFor('INTEGER CENTS');
    await expect(home.card('SHOP-101')).toBeVisible();
  });

  test('should show text found only inside messages in the "In messages" section, with highlight @smoke', async () => {
    await home.searchFor('tombstone');
    await expect(home.msgHits.locator('h2')).toHaveText('In messages');
    const hit = home.msgHits.locator('.msghit');
    await expect(hit).toHaveCount(1);
    await expect(hit.locator('mark')).toHaveText(/tombstone/i);
    await expect(hit.locator('.hitwhy').first()).toContainText(/You|Claude/);
    await expect(home.noResults).toBeHidden();
  });

  test('should open the evidence panel on that exact message when a message hit is clicked @smoke', async ({ page }) => {
    const evidence = new EvidencePanel(page);
    await home.searchFor('tombstone');
    const hit = home.msgHits.locator('.msghit').first();
    const session = await hit.getAttribute('data-session');
    const turn = await hit.getAttribute('data-turn');
    expect(session.startsWith('a7b8c9d0')).toBe(true);
    await hit.click();
    await expect(evidence.root).toBeVisible();
    await expect(evidence.title).toContainText('a7b8c9d0');
    await expect(evidence.cited).toHaveCount(1);
    await expect(evidence.cited).toContainText(/tombstone/);
    await expect(evidence.cited.locator('h3')).toContainText(turn);
  });

  test('should show how many more hits the same session has instead of listing them all @regression', async () => {
    await home.searchFor('cart');
    await expect(home.msgHits.locator('.msghit').filter({ hasText: /\+\d+ more in this session/ }).first()).toBeVisible();
    const perSession = await home.msgHits.locator('.msghit').evaluateAll((els) => {
      const n = {}; for (const e of els) { const k = e.dataset.session; n[k] = (n[k] || 0) + 1; } return Math.max(...Object.values(n));
    });
    expect(perSession).toBeLessThanOrEqual(3);
  });

  test('should keep the message index state out of the way once it is ready @regression', async ({ request }) => {
    const body = await (await request.get('/api/search?q=tombstone')).json();
    expect(body.index.state).toBe('ready');
    await expect(home.msgHits).toBeHidden();
  });

  test.fixme('should show "Indexing messages… n/m" while the message index is building', async () => {
    // The demo index is ready within milliseconds of the server start, so the building state cannot be caught reliably.
  });

  test('should show no results and suggest AI search by meaning, without running it @regression', async ({ page, request }) => {
    await home.searchFor('zzqqxxnonexistent');
    await expect(home.noResults).toBeVisible();
    await expect(home.cards).toHaveCount(0);
    await expect(home.msgHits).toBeHidden();
    await expect(page.locator('#none-hint')).toContainText('Free search is literal');
    await expect(home.noResultsAi).toHaveText('Try AI search by meaning…');
    const usage = await (await request.get('/api/usage')).json();
    expect(usage.total.calls).toBe(0);
    await expect(page.locator('#aibox')).toBeEmpty();
  });
});
