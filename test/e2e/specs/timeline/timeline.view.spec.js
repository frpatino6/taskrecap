// The timeline view of the home. Demo dates: 2026-09-01 .. 2026-10-07 (fixed), so filters use custom ranges, never "last N days".
import { test, expect } from '../../fixtures/app.js';
import { TimelinePage } from '../../pages/timeline.page.js';
import { TaskPage } from '../../pages/task.page.js';

const NEWEST_12 = ['SHOP-105', 'session:f5a5b5c5', 'DOCS-33', 'session:fa1a1a1a', 'session:f4a4b4c4', 'session:f3a3b3c3', 'DOCS-31', 'API-214', 'API-216', 'session:f2a2b2c2', 'SHOP-107', 'SHOP-104'];

test.describe('timeline: lanes', () => {
  let tl;
  test.beforeEach(async ({ page }) => { tl = new TimelinePage(page); await tl.goto(); });

  test('should show the newest tasks first and only 12 lanes at the start @smoke', async () => {
    await expect(tl.lanes).toHaveCount(12);
    expect(await tl.keys()).toEqual(NEWEST_12);
    await expect(tl.foot).toContainText('Showing 12 of 21 tasks');
  });

  test('should show 9 more lanes with the "more" control and then hide it @regression', async () => {
    await expect(tl.more).toHaveText('Show 9 more');
    await tl.more.click();
    await expect(tl.lanes).toHaveCount(21);
    await expect(tl.more).toHaveCount(0);
    await expect(tl.foot).toContainText('Showing 21 of 21 tasks');
  });

  test('should open the task when a lane is clicked @smoke', async ({ page }) => {
    await tl.label('SHOP-105').click();
    await expect(new TaskPage(page).heading).toHaveText('SHOP-105');
    await expect(page).toHaveURL(/#\/task\/SHOP-105$/);
  });

  test('should open the task when a day mark is clicked @regression', async ({ page }) => {
    await tl.lanes.filter({ has: page.locator('.vz-label[data-key="DOCS-33"]') }).locator('.vz-mark').click();
    await expect(page).toHaveURL(/#\/task\/DOCS-33$/);
  });

  test('should describe a lane and a mark for assistive technology @regression', async ({ page }) => {
    await expect(tl.label('SHOP-105')).toHaveAttribute('aria-label', /Open SHOP-105, acme-shop, .*8 prompts.*Capsule ready/);
    await expect(tl.label('session:f2a2b2c2')).toHaveAttribute('aria-label', /No capsule yet/);
    const mark = page.locator('.vz-mark[data-key="DOCS-33"]');
    await expect(mark).toHaveAttribute('aria-label', /^DOCS-33, acme-docs, .*Sep 29, 2026, 3 prompts/);
    await expect(mark).toHaveAttribute('data-n', '3');
  });

  test('should show a tooltip with repo, dates, prompts and capsule status on hover @regression', async () => {
    await tl.label('SHOP-105').hover();
    await expect(tl.tip).toBeVisible();
    await expect(tl.tip).toContainText('SHOP-105');
    await expect(tl.tip).toContainText('acme-shop');
    await expect(tl.tip).toContainText('8 prompts');
    await expect(tl.tip).toContainText('Capsule ready');
  });

  test('should hide the tooltip with Escape @regression', async ({ page }) => {
    await tl.label('SHOP-105').hover();
    await expect(tl.tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tl.tip).toBeHidden();
  });

  test('should show the capsule marks: ready, outdated and none @regression', async ({ page }) => {
    await expect(tl.label('SHOP-105').locator('.vz-key i').first()).toBeVisible();
    await expect(tl.label('SHOP-105').locator('.vz-stale')).toHaveCount(1);
    await expect(tl.label('SHOP-104').locator('.vz-key i')).toHaveCount(1);
    await expect(tl.label('SHOP-104').locator('.vz-stale')).toHaveCount(0);
    await expect(tl.label('DOCS-33').locator('.vz-key i')).toHaveCount(0);
    await expect(page.locator('.vz-legend li')).toHaveText(['acme-api', 'acme-docs', 'acme-shop']);
  });

  test('should flag units without a task key as unsorted @regression', async () => {
    await expect(tl.label('session:f5a5b5c5')).toHaveClass(/unsorted/);
    await expect(tl.label('session:f5a5b5c5')).toContainText('Unsorted');
    await expect(tl.label('DOCS-33')).not.toHaveClass(/unsorted/);
  });

  test('should fold sessions without content into a note instead of lanes @regression', async ({ page }) => {
    await expect(tl.foot).toContainText('4 sessions without content are folded below');
    for (const k of ['session:f6a6b6c6', 'session:f7a7b7c7', 'session:f8a8b8c8', 'session:f9a9b9c9']) await expect(page.locator(`.vz-label[data-key="${k}"]`)).toHaveCount(0);
  });

  test('should draw the coverage ring with the share of tasks that have a capsule @regression', async () => {
    await expect(tl.coverage).toHaveText('8 of 21 tasks have a capsule · 1 outdated');
    const [filled, total] = (await tl.ring.getAttribute('stroke-dasharray')).split(' ').map(Number);
    expect(filled / total).toBeCloseTo(8 / 21, 2);
  });
});

test.describe('timeline: filters', () => {
  let tl;
  test.beforeEach(async ({ page }) => { tl = new TimelinePage(page); await tl.goto(); });

  test('should filter by repo and offer every repo @smoke', async () => {
    await expect(tl.repo.locator('option')).toHaveText(['All repos', 'acme-api', 'acme-docs', 'acme-shop']);
    await tl.repo.selectOption('acme-docs');
    await expect.poll(() => tl.keys()).toEqual(['session:f5a5b5c5', 'DOCS-33', 'session:fa1a1a1a', 'DOCS-31', 'user:3f2b6c1e-8d4a-4b7e-9a51-0c6d2e7f1a90']);
    await expect(tl.more).toHaveCount(0);
  });

  test('should filter by a custom date range @regression', async () => {
    await tl.period.selectOption('custom');
    await tl.from.fill('2026-09-26');
    await tl.to.fill('2026-09-30');
    await expect.poll(() => tl.keys()).toEqual(['session:f5a5b5c5', 'DOCS-33', 'session:fa1a1a1a', 'session:f4a4b4c4', 'session:f3a3b3c3']);
  });

  test('should swap a reversed date range and say so @regression', async ({ page }) => {
    await tl.period.selectOption('custom');
    await tl.from.fill('2026-09-30');
    await tl.to.fill('2026-09-26');
    await expect(page.locator('#vz-msg')).toHaveText('From was after To, so the two dates were swapped.');
    await expect(tl.from).toHaveValue('2026-09-26');
    await expect(tl.to).toHaveValue('2026-09-30');
    await expect.poll(() => tl.keys()).toHaveLength(5);
  });

  test('should show only tasks without a capsule from the coverage ring and clear it @regression', async () => {
    await tl.coverage.click();
    await expect(tl.capFilter).toBeVisible();
    await expect(tl.page.locator('#coverage')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await tl.keys()).includes('SHOP-105')).toBe(false);
    expect((await tl.keys()).every((k) => !['SHOP-104', 'SHOP-101', 'SHOP-102'].includes(k))).toBe(true);
    await expect(tl.label('DOCS-33')).toBeVisible();
    await tl.page.locator('#capfilter-clear').click();
    await expect(tl.capFilter).toBeHidden();
    await expect(tl.label('SHOP-105')).toBeVisible();
  });

  test('should show an empty message with a reset when no lane matches, and Reset brings the lanes back @regression', async () => {
    await tl.repo.selectOption('acme-shop');
    await tl.period.selectOption('custom');
    await tl.from.fill('2026-09-30');
    await tl.to.fill('2026-09-30');
    await expect(tl.empty).toContainText('No dated activity matches these filters.');
    await tl.page.locator('#vz-empty-reset').click();
    await expect(tl.lanes).toHaveCount(12);
    await expect(tl.repo).toHaveValue('');
  });

  test('should bring the lanes back with the Reset button @regression', async () => {
    await tl.repo.selectOption('acme-api');
    await expect.poll(async () => (await tl.keys()).length).toBeLessThan(12);
    await tl.reset.click();
    await expect(tl.lanes).toHaveCount(12);
  });
});

test.describe('timeline: hidden units', () => {
  test('should drop a hidden unit from the lanes and list it in the hidden box @regression', async ({ freshPage }) => {
    const tl = new TimelinePage(freshPage);
    await tl.goto();
    await tl.page.locator('.lanemenu[data-menu="DOCS-33"]').click();
    await tl.menu.choose('Hide');
    await tl.dialog.confirm();
    await expect(tl.label('DOCS-33')).toHaveCount(0);
    await expect(tl.hiddenBox).toContainText('DOCS-33');
  });
});
