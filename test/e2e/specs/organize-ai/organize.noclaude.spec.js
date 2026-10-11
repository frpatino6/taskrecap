import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';
import { OrganizePanel } from '../../pages/organize.panel.js';

test.use({ serverConfig: presets.noClaude });

test.describe('organize with AI: without claude', () => {
  test('should disable Organize with AI with an explanation and still allow reviewing proposals @regression', async ({ page }) => {
    const home = new HomePage(page); const org = new OrganizePanel(page);
    await home.goto();
    await expect(org.run).toBeDisabled();
    expect(((await org.run.getAttribute('title')) || '').length).toBeGreaterThan(10);
    await org.openProposals();
    expect(await org.proposals.count()).toBeGreaterThan(0);
  });
});
