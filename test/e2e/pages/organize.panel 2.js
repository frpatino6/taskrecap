import { expect } from '@playwright/test';

/** The "Organize with AI" panel on the home and its dialog (#orgdlg). */
export class OrganizePanel {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#organize');
    this.run = page.locator('#org-run');
    this.details = page.locator('#org-details');
    this.proposals = page.locator('.orgprop');
    this.acceptAll = page.locator('.orgall');
    this.dialog = page.locator('#orgdlg');
    this.confirm = page.locator('#org-ok');
    this.again = page.locator('#org-again');
    this.stages = page.locator('.pg-stages li');
    this.cancel = page.locator('.pg-cancel');
    this.end = page.locator('.pg-end');
    this.close = page.locator('.pg-close');
  }
  proposal(type, text) {
    const p = this.page.locator(`.orgprop[data-type="${type}"]`);
    return text ? p.filter({ hasText: text }) : p;
  }
  /** The list keeps its open/closed state between redraws: open it only when it is closed. */
  async openProposals() {
    await expect(this.root.locator('.organizepanel')).toBeVisible();
    if (!(await this.details.evaluate((d) => d.open))) await this.details.locator('> summary').click();
    await expect(this.proposals.first()).toBeVisible();
  }
  /** Click "Organize with AI" and arrive at the estimate (re-running if the demo says "already analysed"). */
  async openEstimate() {
    await this.run.click();
    await expect(this.dialog).toBeVisible();
    await expect(this.confirm.or(this.again)).toBeVisible();
    if (await this.again.isVisible()) await this.again.click();
    await expect(this.confirm).toBeVisible();
  }
}
