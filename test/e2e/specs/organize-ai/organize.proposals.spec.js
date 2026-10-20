// Review of the AI proposals (the demo ships sample proposals). Everything here mutates the store: freshPage.
import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { OrganizePanel } from '../../pages/organize.panel.js';
import { EvidencePanel } from '../../pages/evidence.panel.js';

test.describe('organize with AI: reviewing proposals', () => {
  let home; let org;
  test.beforeEach(async ({ freshPage }) => { home = new HomePage(freshPage); org = new OrganizePanel(freshPage); await home.goto(); });

  test('should list the sample proposals folded until opened, nothing applied yet @smoke', async () => {
    await expect(org.root).toContainText('Organize your unsorted sessions with AI');
    await expect(org.root).toContainText('Proposals (5)');
    await expect(org.run).toBeEnabled();
    await expect(org.proposals.first()).toBeHidden();
    await expect(home.cards.locator('.chip.ai')).toHaveCount(0);
    await org.openProposals();
    await expect(org.proposals).toHaveCount(5);
    expect((await org.proposals.locator('.orgmeta .chip.ai').allInnerTexts()).sort()).toEqual(['Name', 'Name', 'Name', 'Same work', 'Split session']);
  });

  test('should show a group with its reason, confidence, sessions and evidence that opens the message @regression', async ({ freshPage }) => {
    const evidence = new EvidencePanel(freshPage);
    await org.openProposals();
    const group = org.proposal('group');
    await expect(group).toContainText('Pagination of the products listing');
    await expect(group).toContainText('Why:');
    await expect(group).toContainText('High confidence');
    await expect(group.locator('.orgsessions li')).toHaveCount(2);
    await group.locator('button.cite').first().click();
    await expect(evidence.cited).toHaveCount(1);
    await expect(evidence.panel).toContainText(/pagination/i);
  });

  test('should show a cut with the message ranges and no confidence chip @regression', async () => {
    await org.openProposals();
    const cut = org.proposal('split');
    await expect(cut).toContainText('messages 0–7');
    await expect(cut).toContainText('messages 8–15');
    await expect(cut.locator('.orgparts > li')).toHaveCount(2);
    await expect(cut.locator('.chip[class*="conf-"]')).toHaveCount(0);
    await expect(cut.locator('.orgedit-btn')).toHaveCount(0);
  });

  test('should accept one proposal, mark the card as AI-organized and undo it from the toast @regression', async () => {
    await org.openProposals();
    await org.proposal('group').locator('.orgaccept').click();
    const card = home.cards.filter({ hasText: 'Pagination of the products listing' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('AI-organized');
    await expect(card).toContainText('Your group');
    await home.toast.undo.click();
    await expect(home.cards.filter({ hasText: 'Pagination of the products listing' })).toHaveCount(0);
    await org.openProposals();
    await expect(org.proposal('group')).toHaveCount(1);
  });

  test('should accept all high-confidence proposals as one change that can be undone @regression', async () => {
    await org.openProposals();
    await org.acceptAll.click();
    await expect(home.toast.root).toContainText('1 proposal(s) accepted');
    const card = home.cards.filter({ hasText: 'Pagination of the products listing' });
    await expect(card).toContainText('AI-organized');
    await home.toast.undo.click();
    await expect(home.cards.locator('.chip.ai')).toHaveCount(0);
  });

  test('should keep a rejected proposal rejected after a reload @regression', async ({ freshPage }) => {
    await org.openProposals();
    await org.proposal('title', 'Node version').locator('.orgreject').click();
    await expect(home.toast.root).toContainText(/rejected/i);
    await freshPage.reload();
    await org.openProposals();
    await expect(org.proposal('title', 'Node version')).toHaveCount(0);
  });

  test('should apply the user\'s own wording from Edit title @regression', async () => {
    await org.openProposals();
    const p = org.proposal('title', 'onboarding guide');
    await p.locator('.orgedit-btn').click();
    await p.locator('.orgedit input').fill('Onboarding guide v2');
    await expect(p.locator('.orgaccept')).toHaveText(/Accept with this title/);
    await p.locator('.orgaccept').click();
    const card = home.cards.filter({ hasText: 'Onboarding guide v2' });
    await expect(card.locator('.chip.ai')).toBeVisible();
  });

  test('should make each range of an accepted cut its own unit with only its messages @regression', async ({ freshPage }) => {
    await org.openProposals();
    await org.proposal('split').locator('.orgaccept').click();
    const part = home.cards.filter({ hasText: 'Write the 2.4 release notes' });
    await expect(part).toContainText('AI-organized');
    await expect(part).toContainText('messages 8–15');
    await part.click();
    await expect(freshPage.locator('#sesslist .sessitem').first()).toContainText('8 messages');
    await expect(freshPage.locator('#sesslist .sessmenu')).toHaveCount(0);
  });
});
