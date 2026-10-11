import { test, expect } from '../../fixtures/app.js';
import { TaskPage } from '../../pages/task.page.js';
import { EvidencePanel } from '../../pages/evidence.panel.js';

test.describe('tasks: the capsule of a task', () => {
  let task;
  test.beforeEach(async ({ page }) => { task = new TaskPage(page); await task.goto('SHOP-101'); });

  test('should show the objective under the task title @smoke', async () => {
    await expect(task.heading).toHaveText('SHOP-101');
    await expect(task.root.locator('.hero .t').first()).toContainText('Find and fix why the checkout total is sometimes one cent higher');
  });

  test('should list the decisions with the reason of each @regression', async () => {
    const decisions = task.section('Decisions and why');
    await expect(decisions.locator('.decision')).toHaveCount(6);
    await expect(decisions).toContainText('Use integer cents everywhere in the cart instead of rounding in the UI.');
  });

  test('should list the files touched as final edits @regression', async () => {
    const files = task.section('Files touched');
    await expect(files.locator('summary').first()).toHaveText('Final (4)');
    await expect(files.locator('details[open] button.filelink')).toHaveCount(4);
    await expect(files).toContainText('acme-shop/src/cart/total.js');
  });

  test('should list the confirmed commits with their message @regression', async () => {
    const commits = task.section('Commits');
    await expect(commits).toContainText('3f9a2c1');
    await expect(commits).toContainText('SHOP-101: use integer cents in cart totals');
    await expect(commits).toContainText('7be4d90');
  });

  test('should show the timeline as a table with date, repo, result and evidence @regression', async ({ page }) => {
    const table = task.section('Timeline').locator('table.tl2');
    await expect(table.locator('thead th')).toHaveText(['Date and time', 'Repo', 'Result', 'Evidence']);
    await expect(task.timelineRows).toHaveCount(6);
    await expect(task.timelineRows.first().locator('td').nth(1)).toHaveText('acme-shop');
  });

  test('should show the briefing to resume and the resume button @regression', async ({ page }) => {
    await expect(task.briefing).not.toBeEmpty();
    await expect(page.locator('#resume')).toBeVisible();
  });

  test('should show no outdated notice on an up-to-date capsule @regression', async () => {
    await expect(task.stale).toHaveCount(0);
  });

  test('should open the evidence panel at the cited message when a citation is clicked @smoke', async ({ page }) => {
    const evidence = new EvidencePanel(page);
    const cite = task.section('Decisions and why').locator('button.cite').first();
    const session = await cite.getAttribute('data-session');
    const turn = await cite.getAttribute('data-turn');
    await cite.click();
    await expect(evidence.root).toBeVisible();
    await expect(evidence.title).toContainText(session);
    await expect(evidence.cited).toHaveCount(1);
    await expect(evidence.cited.locator('h3')).toContainText(`${turn}`);
  });

  test('should close the evidence panel with Escape @regression', async ({ page }) => {
    const evidence = new EvidencePanel(page);
    await task.cites.first().click();
    await expect(evidence.root).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(evidence.root).toBeHidden();
  });
});
