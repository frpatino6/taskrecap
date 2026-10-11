import { expect } from '@playwright/test';
import { UnitMenu, UnitDialog, Toast } from './components.js';

export class HomePage {
  constructor(page) {
    this.page = page;
    this.banner = page.locator('#banner');
    this.title = page.locator('#home-title');
    this.search = page.locator('#q');
    this.cards = page.locator('#grid .card');
    this.msgHits = page.locator('#msghits');
    this.noResults = page.locator('#nonewrap');
    this.noResultsAi = page.locator('#none-ai');
    this.emptyGroup = page.locator('#emptygroup');
    this.hiddenBox = page.locator('#hiddenbox');
    this.coverage = page.locator('#coverage-text');
    this.menu = new UnitMenu(page);
    this.dialog = new UnitDialog(page);
    this.toast = new Toast(page);
  }
  async goto() {
    await this.page.goto('/#/');
    await expect(this.cards.first()).toBeVisible();
  }
  card(key) { return this.page.locator(`.card[data-key="${key}"]`); }
  cardMenuButton(key) { return this.page.locator(`.cardmenu[data-menu="${key}"]`).first(); }
  async openCardMenu(key) { await this.cardMenuButton(key).click(); await expect(this.menu.items.first()).toBeVisible(); }
  async openTask(key) { await this.card(key).click(); await expect(this.page.locator('#detail h1')).toBeVisible(); }
  async searchFor(text) { await this.search.fill(text); }
}
