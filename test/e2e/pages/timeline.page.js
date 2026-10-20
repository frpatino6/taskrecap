import { expect } from '@playwright/test';
import { HomePage } from './home.page.js';

/** The timeline view of the home (lanes, filters, coverage ring). */
export class TimelinePage extends HomePage {
  constructor(page) {
    super(page);
    this.lanes = page.locator('.vz-lane');
    this.labels = page.locator('.vz-label');
    this.more = page.locator('#vz-more');
    this.foot = page.locator('.vz-foot');
    this.repo = page.locator('#vz-repo');
    this.period = page.locator('#vz-period');
    this.from = page.locator('#vz-from');
    this.to = page.locator('#vz-to');
    this.reset = page.locator('#vz-reset');
    this.empty = page.locator('.vz-empty');
    this.tip = page.locator('#vz-tip');
    this.ring = page.locator('#cv-fg');
    this.capFilter = page.locator('#capfilter');
  }
  async goto() {
    await this.page.addInitScript(() => { try { localStorage.setItem('tr-view', 'timeline'); } catch (e) { /* ignore */ } });
    await this.page.goto('/#/');
    await expect(this.lanes.first()).toBeVisible();
  }
  label(key) { return this.page.locator(`.vz-label[data-key="${key}"]`); }
  keys() { return this.labels.evaluateAll((els) => els.map((e) => e.dataset.key)); }
}
