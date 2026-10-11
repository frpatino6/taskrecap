export class EvidencePanel {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#evidence');
    this.panel = page.locator('#ev-panel');
    this.title = page.locator('#ev-title');
    this.cited = page.locator('#ev-panel .evturn[data-cited="1"]');
    this.turns = page.locator('#ev-panel .evturn');
    this.close = page.locator('#ev-close');
    this.resume = page.locator('#ev-resume');
    this.copyResume = page.locator('#ev-copy');
    this.made = page.locator('#ev-panel .evmade');
    this.madeRows = page.locator('#ev-panel .evfile');
    this.madeMessage = page.locator('#ev-made-msg');
  }
  /** The row of "Files Claude created" whose short path contains `text`. */
  madeRow(text) { return this.madeRows.filter({ hasText: text }); }
  /** Open the panel from the citation of a task page (`#detail button.cite` with that message number). */
  async openFromTask(turn = 0) {
    await this.page.locator(`#detail button.cite[data-turn="${turn}"]`).first().click();
    await this.cited.first().waitFor();
  }
}
