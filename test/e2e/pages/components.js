// Small shared components: the actions menu, the confirmation/rename dialog and the toast. They are the same on every page.
import { expect } from '@playwright/test';

export class UnitMenu {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#unitmenu');
    this.items = this.root.locator('button');
  }
  item(text) { return this.root.locator('button', { hasText: text }).first(); }
  async labels() { await expect(this.items.first()).toBeVisible(); return this.items.allInnerTexts(); }
  async choose(text) { await this.item(text).click(); }
}

export class UnitDialog {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#unitdlg');
    this.title = page.locator('#ud-title');
    this.name = page.locator('#ud-name');
    this.target = page.locator('#ud-target');
    this.ok = page.locator('#ud-ok');
    this.cancel = page.locator('#ud-cancel');
  }
  async confirm() { await this.ok.click(); await expect(this.root).toBeHidden(); }
}

export class Toast {
  constructor(page) {
    this.root = page.locator('#toast');
    this.undo = page.locator('#toast-undo');
  }
}
