export class EvidencePanel {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#evidence');
    this.panel = page.locator('#ev-panel');
    this.title = page.locator('#ev-title');
    this.cited = page.locator('#ev-panel .evturn[data-cited="1"]');
    this.close = page.locator('#ev-close');
  }
}
