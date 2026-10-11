// Running Organize with AI against the stand-in claude (tools/screenshots/fake-claude.mjs): the whole real stack, no network, no spend.
import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';
import { OrganizePanel } from '../../pages/organize.panel.js';

test.use({ serverConfig: presets.fakeClaude });

const usage = async (page) => (await (await page.request.get('/api/usage')).json());

test.describe('organize with AI: running it', () => {
  let home; let org;
  test.beforeEach(async ({ freshPage }) => { home = new HomePage(freshPage); org = new OrganizePanel(freshPage); await home.goto(); });

  test('should show an estimate before spending anything, then run with live stages and new proposals @smoke', async ({ freshPage }) => {
    await org.run.click();
    await expect(org.dialog).toBeVisible();
    await expect(org.dialog).toContainText('already analysed'); // the demo sessions were analysed: no tokens needed
    await org.again.click();
    await expect(org.confirm).toBeVisible();
    await expect(org.dialog).toContainText(/Estimated: about .* tokens/);
    await expect(org.dialog).toContainText('never the whole conversation');
    expect((await usage(freshPage)).session.calls).toBe(0);
    await org.confirm.click();
    await expect(org.stages.first()).toBeVisible();
    await expect.poll(() => org.stages.evaluateAll((els) => els.map((e) => e.dataset.id))).toEqual(['org_scan', 'org_ask', 'org_validate', 'org_save']);
    await expect(org.dialog).toBeHidden({ timeout: 15_000 });
    await expect(home.toast.root).toContainText('proposal(s) to review');
    const used = await usage(freshPage);
    expect(used.session.calls).toBe(1);
    expect(used.session.usd).toBeGreaterThan(0.01);
  });

  test('should apply nothing until a proposal is accepted @regression', async ({ freshPage }) => {
    const before = await home.cards.count();
    await org.openEstimate();
    await org.confirm.click();
    await expect(org.dialog).toBeHidden({ timeout: 15_000 });
    await expect(home.cards.locator('.chip.ai')).toHaveCount(0);
    await expect(home.cards).toHaveCount(before);
    const hist = await (await freshPage.request.get('/api/units/history')).json();
    expect(hist.last.batch).toBe('9c1d4e7a-2b5f-4a38-8d60-1e3f5a7b9c20'); // only the demo's own sample correction
  });

  test('should show the titles, groups and cuts of the stand-in model and accept a title @regression', async () => {
    await org.openEstimate();
    await org.confirm.click();
    await expect(org.dialog).toBeHidden({ timeout: 15_000 });
    await org.openProposals();
    await expect(org.proposal('group', 'Products pagination (stand-in)')).toHaveCount(1);
    await expect(org.proposal('split', 'Anchors (stand-in)')).toContainText('Release notes (stand-in)');
    const title = org.proposal('title', 'Named by the stand-in model').first();
    await expect(title).toBeVisible();
    await title.locator('.orgaccept').click();
    await expect(home.cards.filter({ hasText: 'Named by the stand-in model' }).first().locator('.chip.ai')).toBeVisible();
  });

  test('should never propose a title over a name the user chose @regression', async () => {
    const key = 'session:d4e5f6a7';
    await home.openCardMenu(key);
    await home.menu.choose('Rename');
    await home.dialog.name.fill('My own name');
    await home.dialog.confirm();
    await org.openEstimate();
    await org.confirm.click();
    await expect(org.dialog).toBeHidden({ timeout: 15_000 });
    await org.openProposals();
    await expect(org.proposal('title', 'Named by the stand-in model: d4e5f6a7')).toHaveCount(0);
    await expect(home.card(key)).toContainText('My own name');
  });

  test('should keep a name the user set after the proposal was made when the title is accepted @regression', async () => {
    const key = 'session:d4e5f6a7';
    await org.openEstimate();
    await org.confirm.click();
    await expect(org.dialog).toBeHidden({ timeout: 15_000 });
    await home.openCardMenu(key);
    await home.menu.choose('Rename');
    await home.dialog.name.fill('My own name');
    await home.dialog.confirm();
    await org.openProposals();
    const title = org.proposal('title', 'Named by the stand-in model: d4e5f6a7');
    await expect(title).toHaveCount(1);
    await title.locator('.orgaccept').click();
    await expect(home.toast.root).toContainText('your name was kept');
    await expect(home.card(key)).toContainText('My own name');
    await expect(home.card(key)).not.toContainText('Named by the stand-in model');
    await expect(org.proposal('title', 'Named by the stand-in model: d4e5f6a7')).toHaveCount(0);
  });

  test('should stop a running organize on Cancel and leave the proposals untouched @regression', async ({ freshPage }) => {
    const before = (await (await freshPage.request.get('/api/organize/proposals')).json()).proposals.length;
    await org.openEstimate();
    await org.confirm.click();
    await expect(org.cancel).toBeVisible();
    await org.cancel.click();
    await expect(org.end).toContainText(/cancel/i);
    expect((await (await freshPage.request.get('/api/organize/proposals')).json()).proposals.length).toBe(before);
    await org.close.click();
    await expect(org.dialog).toBeHidden();
    await expect(org.run).toBeEnabled();
  });

  test('should name one unsorted session with "Name with AI" and accept it in the dialog @regression', async () => {
    const key = 'session:d4e5f6a7';
    await home.openCardMenu(key);
    await home.menu.choose('Name with AI');
    await expect(org.confirm.or(org.again)).toBeVisible();
    if (await org.again.isVisible()) await org.again.click();
    await expect(org.dialog).toContainText('for one title');
    await org.confirm.click();
    const proposal = org.dialog.locator('.orgprop[data-type="title"]');
    await expect(proposal).toContainText('Named by the stand-in model: d4e5f6a7', { timeout: 15_000 });
    await proposal.locator('.orgaccept').click();
    await expect(org.dialog).toBeHidden();
    await expect(home.card(key)).toContainText('Named by the stand-in model');
    await expect(home.card(key).locator('.chip.ai')).toBeVisible();
  });

  test('should undo an accepted AI title from the toast @regression', async () => {
    const key = 'session:d4e5f6a7';
    await home.openCardMenu(key);
    await home.menu.choose('Name with AI');
    await expect(org.confirm.or(org.again)).toBeVisible();
    if (await org.again.isVisible()) await org.again.click();
    await org.confirm.click();
    await org.dialog.locator('.orgprop[data-type="title"] .orgaccept').click();
    await expect(home.card(key).locator('.chip.ai')).toBeVisible();
    await home.toast.undo.click();
    await expect(home.card(key).locator('.chip.ai')).toHaveCount(0);
    await expect(home.card(key)).not.toContainText('Named by the stand-in model');
  });
});
