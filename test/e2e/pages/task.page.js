import { expect } from '@playwright/test';
import { UnitMenu, UnitDialog, Toast } from './components.js';

export class TaskPage {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#detail');
    this.heading = page.locator('#detail h1');
    this.back = page.locator('#back');
    this.timelineRows = page.locator('#detail table.tl2 tbody tr');
    this.cites = page.locator('#detail button.cite');
    this.fileLinks = page.locator('#detail button.filelink');
    this.briefing = page.locator('#briefing');
    this.stale = page.locator('#detail .stale');
    this.actions = page.locator('#unit-menu');
    this.related = page.locator('.relbox');
    this.generate = page.locator('#gen');
    this.sessions = page.locator('#sesslist .sessitem');
    this.menu = new UnitMenu(page);
    this.dialog = new UnitDialog(page);
    this.toast = new Toast(page);
  }
  async goto(key) {
    await this.page.goto('/#/task/' + encodeURIComponent(key));
    await expect(this.heading).toBeVisible();
  }
  /** A section of the capsule by its heading ("Timeline", "Decisions and why", ...). */
  section(title) { return this.page.locator('section.block', { has: this.page.getByRole('heading', { name: title, exact: true }) }); }
}
