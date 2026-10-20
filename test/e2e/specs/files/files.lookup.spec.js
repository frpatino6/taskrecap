// Files view: which tasks touched a file (home "Find by file") and the same lookup from a task page.
import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { TaskPage } from '../../pages/task.page.js';

test.describe('files: file to tasks lookup', () => {
  test('should find a file by part of its path and list the tasks that touched it @smoke', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await page.locator('#filesearch > summary').click();
    await page.locator('#fq').fill('cart/total');
    const rows = page.locator('#filelist .filerows li');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#filelist .note').first()).toHaveText('4 of 4 file(s)');
    const row = rows.filter({ hasText: 'acme-shop/src/cart/total.js' }).filter({ hasNotText: 'total.test.js' });
    await expect(row.locator('button.tasklink')).toHaveText(['SHOP-107 ~', 'SHOP-101']);
  });

  test('should open the task from a file result @regression', async ({ page }) => {
    const home = new HomePage(page); const task = new TaskPage(page);
    await home.goto();
    await page.locator('#filesearch > summary').click();
    await page.locator('#fq').fill('cart/total');
    await page.locator('#filelist button.tasklink[data-key="SHOP-101"]').first().click();
    await expect(task.heading).toHaveText('SHOP-101');
    await expect(page).toHaveURL(/#\/task\/SHOP-101$/);
  });

  test('should say so when no file matches @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await page.locator('#filesearch > summary').click();
    await page.locator('#fq').fill('zzz-no-such-file');
    await expect(page.locator('#filelist')).toContainText('No file matches. Only files edited in Claude sessions are known.');
  });

  test('should list the files touched the most when the query is empty @regression', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await page.locator('#filesearch > summary').click();
    await expect(page.locator('#filelist')).toContainText('Files touched by the most tasks');
    expect(await page.locator('#filelist .filerows li').count()).toBeGreaterThan(3);
  });

  test('should show the other tasks that touched a file of this task, mark approximate ones, and link back @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto('SHOP-101');
    await task.section('Files touched').locator('button.filelink', { hasText: 'acme-shop/src/cart/total.js' }).first().click();
    const box = page.locator('#filebox');
    await expect(box.locator('h3')).toHaveText('Other tasks that touched acme-shop/src/cart/total.js');
    const other = box.locator('button.tasklink[data-key="SHOP-107"]');
    await expect(other).toBeVisible();
    await expect(other).toContainText('Edited, outcome unknown');
    await expect(other).toContainText('Approximate');
    await expect(box.locator('button.tasklink[data-key="SHOP-101"]')).toHaveCount(0); // this task is not listed as "other"
    await other.click();
    await expect(task.heading).toHaveText('SHOP-107');
  });

  test('should offer a capsule-based answer ("From capsule") for a task that has a capsule @regression', async ({ page }) => {
    const task = new TaskPage(page);
    await task.goto('SHOP-103');
    await task.section('Files touched').locator('button.filelink', { hasText: 'total.test.js' }).first().click();
    const row = page.locator('#filebox button.tasklink[data-key="SHOP-101"]');
    await expect(row).toContainText('From capsule');
    await expect(row).toContainText('Final');
  });

  test('should answer the API with approximate false for a capsule and true for a session guess @regression', async ({ request }) => {
    const body = await (await request.get('/api/files/tasks?path=' + encodeURIComponent('acme-shop/src/cart/total.js'))).json();
    expect(body.tasks.map((t) => [t.key, t.approximate])).toEqual([['SHOP-101', false], ['SHOP-107', true]]);
  });
});
