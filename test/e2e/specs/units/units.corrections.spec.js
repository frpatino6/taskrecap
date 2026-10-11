// Corrections change the server state (rename, merge, hide...): every test runs on its OWN pristine server (freshPage).
import { test, expect } from '../../fixtures/app.js';
import { HomePage } from '../../pages/home.page.js';
import { TaskPage } from '../../pages/task.page.js';

const A = 'session:f3a3b3c3'; // "Add pagination to the products listing endpoint ..."
const B = 'session:f4a4b4c4'; // "Write tests for the products pagination edge cases ..."
const C = 'session:f2a2b2c2'; // "Why does the /orders endpoint return a 500 ..."

test.describe('units: corrections on the home', () => {
  let home;
  test.beforeEach(async ({ freshPage }) => { home = new HomePage(freshPage); await home.goto(); });

  test('should offer rename, merge, move, name with AI, hide and undo on the card menu @regression', async () => {
    await home.openCardMenu(A);
    const labels = (await home.menu.labels()).map((s) => s.replace(/\(.*\)/, '').trim());
    expect(labels).toEqual(['Rename…', 'Merge with…', 'Move session…', 'Name with AI…', 'Hide', 'Undo last change']);
  });

  test('should close the menu with Escape and give the focus back to the card menu button @regression', async ({ freshPage }) => {
    await home.openCardMenu(A);
    await freshPage.keyboard.press('Escape');
    await expect(home.menu.root).toBeHidden();
    await expect(home.cardMenuButton(A)).toBeFocused();
  });

  test('should rename a unit, confirm with a toast and keep the name after a reload @smoke', async ({ freshPage }) => {
    await home.openCardMenu(A);
    await home.menu.choose('Rename');
    await home.dialog.name.fill('Products pagination');
    await freshPage.keyboard.press('Enter');
    await expect(home.toast.root).toContainText('Name saved');
    await expect(home.card(A)).toContainText('Products pagination');
    await freshPage.reload();
    await expect(home.card(A)).toContainText('Products pagination');
  });

  test('should undo a rename from the menu and restore the original title @regression', async () => {
    await home.openCardMenu(A);
    await home.menu.choose('Rename');
    await home.dialog.name.fill('Products pagination');
    await home.dialog.confirm();
    await expect(home.card(A)).toContainText('Products pagination');
    await home.openCardMenu(A);
    await expect(home.menu.items.last()).toHaveText(/Undo last change \(rename\)/);
    await home.menu.choose('Undo last change');
    await expect(home.card(A)).not.toContainText('Products pagination');
    await expect(home.card(A)).toContainText('Add pagination to the products listing endpoint');
  });

  test('should close the dialog with Escape or Cancel without changing anything @regression', async ({ freshPage }) => {
    await home.openCardMenu(A);
    await home.menu.choose('Rename');
    await freshPage.keyboard.press('Escape');
    await expect(home.dialog.root).toBeHidden();
    await home.openCardMenu(A);
    await home.menu.choose('Hide');
    await expect(home.dialog.root).toBeVisible();
    await home.dialog.cancel.click();
    await expect(home.dialog.root).toBeHidden();
    await expect(home.card(A)).toHaveCount(1);
  });

  test('should merge two cards into one group of mine @smoke', async () => {
    await home.openCardMenu(A);
    await home.menu.choose('Merge with');
    await home.dialog.target.selectOption({ value: B });
    await home.dialog.name.fill('Pagination work');
    await home.dialog.confirm();
    const group = home.cards.filter({ hasText: 'Pagination work' });
    await expect(group).toHaveCount(1);
    await expect(group).toContainText('Your group');
    await expect(group).toContainText('2 sessions');
    await expect(home.card(A)).toHaveCount(0);
    await expect(home.card(B)).toHaveCount(0);
  });

  test('should split a group back into its sessions and undo the split @regression', async () => {
    await home.openCardMenu(A);
    await home.menu.choose('Merge with');
    await home.dialog.target.selectOption({ value: B });
    await home.dialog.name.fill('Pagination work');
    await home.dialog.confirm();
    const group = home.cards.filter({ hasText: 'Pagination work' });
    const key = await group.getAttribute('data-key');
    await home.openCardMenu(key);
    await home.menu.choose('Split group');
    await home.dialog.confirm();
    await expect(home.card(A)).toBeVisible();
    await expect(home.card(key)).toHaveCount(0);
    await home.toast.undo.click();
    await expect(home.card(key)).toBeVisible();
    await expect(home.card(A)).toHaveCount(0);
  });

  test('should keep a merged group after a reload @regression', async ({ freshPage }) => {
    await home.openCardMenu(A);
    await home.menu.choose('Merge with');
    await home.dialog.target.selectOption({ value: B });
    await home.dialog.name.fill('Pagination work');
    await home.dialog.confirm();
    await freshPage.reload();
    await expect(home.cards.filter({ hasText: 'Pagination work' })).toHaveCount(1);
    await expect(home.card(A)).toHaveCount(0);
  });

  test('should hide a unit, list it under "Hidden (1)" and show it again @smoke', async () => {
    await home.openCardMenu(C);
    await home.menu.choose('Hide');
    await expect(home.dialog.title).toContainText('Hide “');
    await home.dialog.confirm();
    await expect(home.card(C)).toHaveCount(0);
    await expect(home.hiddenBox.locator('summary')).toHaveText('Hidden (1)');
    await home.hiddenBox.locator('summary').click();
    await home.hiddenBox.locator('[data-unhide-unit]').click();
    await expect(home.card(C)).toBeVisible();
    await expect(home.hiddenBox).toBeHidden();
  });

  test('should keep a hidden unit hidden after a reload @regression', async ({ freshPage }) => {
    await home.openCardMenu(C);
    await home.menu.choose('Hide');
    await home.dialog.confirm();
    await freshPage.reload();
    await expect(home.cards.first()).toBeVisible();
    await expect(home.card(C)).toHaveCount(0);
    await expect(home.hiddenBox.locator('summary')).toHaveText('Hidden (1)');
  });
});

test.describe('units: corrections on the task page', () => {
  test('should show the Actions menu and the related sessions as links @regression', async ({ freshPage }) => {
    const home = new HomePage(freshPage);
    await home.goto();
    await home.openTask(A);
    const task = new TaskPage(freshPage);
    await expect(task.heading).toContainText('Add pagination');
    await expect(task.actions).toBeVisible();
    await expect(task.related).toContainText('Related');
    await expect(task.related.locator('.relopen').first()).toContainText('Write tests for the products pagination');
  });

  test('should move a session into a new group from its task page and undo it @regression', async ({ freshPage }) => {
    const home = new HomePage(freshPage);
    await home.goto();
    await home.openTask(C);
    const task = new TaskPage(freshPage);
    await freshPage.locator('#sesslist .sessmenu').click();
    await task.menu.choose('Move to another unit');
    await task.dialog.target.selectOption({ value: 'new' });
    await task.dialog.name.fill('Orders bug');
    await task.dialog.ok.click();
    await expect(freshPage).toHaveURL(/#\/task\/user/);
    await expect(task.heading).toHaveText('Orders bug');
    await task.toast.undo.click();
    await expect(task.toast.root).toContainText('Change undone');
  });
});
