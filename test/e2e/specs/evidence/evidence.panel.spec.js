// The evidence panel: the original messages behind a citation. Demo session a1b2c3d4 (SHOP-101): message #0 has markdown and paths.
import { test, expect } from '../../fixtures/app.js';
import { TaskPage } from '../../pages/task.page.js';
import { EvidencePanel } from '../../pages/evidence.panel.js';

test.describe('evidence: panel content', () => {
  let task; let evidence;
  test.beforeEach(async ({ page }) => {
    task = new TaskPage(page); evidence = new EvidencePanel(page);
    await task.goto('SHOP-101');
    await evidence.openFromTask(0);
  });

  test('should show the message number, date and the user and Claude texts @smoke', async () => {
    await expect(evidence.title).toContainText('a1b2c3d4');
    await expect(evidence.cited.locator('h3')).toContainText('Message #0');
    await expect(evidence.cited.locator('h3')).toContainText('cited');
    await expect(evidence.cited.locator('.evrole').first()).toHaveText('You');
    await expect(evidence.cited.locator('.evrole').nth(1)).toHaveText('Claude');
    await expect(evidence.cited).toContainText('customers report the checkout total is sometimes one cent higher');
    await expect(evidence.cited).toContainText('The cart sums prices as floats');
  });

  test('should show the session metadata and the context messages around the cited one @regression', async () => {
    await expect(evidence.panel.locator('dl.evmeta')).toContainText('acme-shop');
    expect(await evidence.turns.count()).toBeGreaterThan(1);
    await expect(evidence.panel.locator('.evturn[data-cited="0"]').first()).toBeVisible();
  });

  test('should render markdown: headings, lists and inline code @regression', async () => {
    const user = evidence.cited.locator('.evtext').first();
    await expect(user.locator('h4.mdh')).toHaveText('What to check');
    await expect(user.locator('ul > li')).toHaveCount(3);
    const claude = evidence.cited.locator('.evtext').nth(1);
    await expect(claude.locator('h4.mdh')).toHaveText(['Root cause', 'Plan']);
    await expect(claude.locator('ol > li')).toHaveCount(3);
    await expect(claude.locator('p code').first()).toHaveText('19.99 * 3 = 59.97000000000001');
    await expect(user.locator('strong')).toHaveText('not');
  });

  test('should render known file paths as solid links and unknown ones as dotted links @regression', async () => {
    const known = evidence.cited.locator('button.filelink[data-file="acme-shop/src/cart/total.js"]').first();
    const unknown = evidence.cited.locator('button.filelink.unknown[data-file="src/payments/provider.js"]');
    await expect(known).toBeVisible();
    await expect(known).not.toHaveClass(/unknown/);
    await expect(unknown).toBeVisible();
  });

  test('should go to the files section of the task, with that file, when a known path is clicked @regression', async ({ page }) => {
    await evidence.cited.locator('button.filelink[data-file="acme-shop/src/cart/total.js"]').first().click();
    await expect(evidence.root).toBeHidden();
    await expect(page.locator('#filebox')).toBeVisible();
    await expect(page.locator('#filebox')).toContainText('total.js');
  });

  test('should list "Files Claude created" with created/edited label and the absolute path @regression', async () => {
    await expect(evidence.made.locator('h3')).toHaveText('Files Claude created');
    await expect(evidence.madeRows).toHaveCount(6);
    const notes = evidence.madeRow('SHOP-101-notes.md');
    await expect(notes.locator('.evkind')).toHaveText('created');
    await expect(notes.locator('.evpath')).toHaveText('/home/demo/acme-shop/docs/SHOP-101-notes.md');
    await expect(evidence.madeRow('src/cart/price.js').locator('.evkind')).toHaveText('edited');
    await expect(evidence.madeRows.first().locator('.evkind')).toHaveText('created'); // created first, then edited
  });

  test('should copy the absolute path of a created file and say so @regression', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await evidence.madeRow('SHOP-101-notes.md').getByRole('button', { name: 'Copy path' }).click();
    await expect(evidence.madeMessage).toHaveText('Path copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/home/demo/acme-shop/docs/SHOP-101-notes.md');
  });

  test('should ask the server to open the folder and show the answer, without opening anything in demo mode @regression', async ({ page }) => {
    const request = page.waitForRequest((r) => r.url().endsWith('/api/reveal') && r.method() === 'POST');
    const response = page.waitForResponse((r) => r.url().endsWith('/api/reveal'));
    await evidence.madeRow('SHOP-101-notes.md').getByRole('button', { name: 'Open folder' }).click();
    const body = (await request).postDataJSON();
    expect(body).toEqual({ session: expect.stringMatching(/^a1b2c3d4-/), path: '/home/demo/acme-shop/docs/SHOP-101-notes.md' });
    const answer = await (await response).json();
    expect(answer).toEqual({ ok: true, opened: '/home/demo/acme-shop/docs/SHOP-101-notes.md' });
    await expect(evidence.madeMessage).toHaveText('Opened in your file manager.');
  });

  test('should show the resume command and copy it @regression', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await expect(evidence.resume).toHaveText('claude --resume a1b2c3d4-0101-4101-8101-000000000101');
    await evidence.copyResume.click();
    await expect(evidence.copyResume).toHaveText('Copied!');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('claude --resume a1b2c3d4-0101-4101-8101-000000000101');
  });

  test('should close with the Close button and give the focus back to the citation @regression', async () => {
    await evidence.close.click();
    await expect(evidence.root).toBeHidden();
    await expect(task.cites.first()).toBeFocused();
  });

  test('should close with Escape @regression', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(evidence.root).toBeHidden();
  });

  test('should close when the backdrop is clicked @regression', async ({ page }) => {
    await page.locator('#ev-backdrop').click({ position: { x: 5, y: 300 } });
    await expect(evidence.root).toBeHidden();
  });
});
