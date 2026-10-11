// The stored corrections and organize proposals are garbage: the app must start, move them aside and keep working.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../fixtures/app.js';
import { presets } from '../../fixtures/presets.js';
import { HomePage } from '../../pages/home.page.js';

test.use({ serverConfig: presets.corruptedStore });

test.describe('states: corrupted stores', () => {
  test('should start with the demo tasks, without the stored sample corrections, and move the damaged files aside @smoke', async ({ freshPage, freshServer }) => {
    const errors = [];
    freshPage.on('pageerror', (e) => errors.push(e.message));
    const home = new HomePage(freshPage);
    await home.goto();
    await expect(home.cards).toHaveCount(22); // 21 with the sample correction (a grouped pair), 22 without any
    expect(errors).toEqual([]);
    const names = fs.readdirSync(path.join(freshServer.home, 'demo-cache', '.index'));
    expect(names.some((n) => n.startsWith('overrides.json.corrupt-'))).toBe(true);
  });

  test('should keep corrections working: a rename is saved over the damaged file @regression', async ({ freshPage, freshServer }) => {
    const home = new HomePage(freshPage);
    await home.goto();
    await home.openCardMenu('session:f3a3b3c3');
    await home.menu.choose('Rename');
    await home.dialog.name.fill('After corruption');
    await home.dialog.confirm();
    await expect(home.card('session:f3a3b3c3')).toContainText('After corruption');
    await freshPage.reload();
    await expect(home.card('session:f3a3b3c3')).toContainText('After corruption');
    const dir = path.join(freshServer.home, 'demo-cache', '.index');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'overrides.json'), 'utf8'));
    expect(saved).toBeTruthy();
  });

  test('should show the organize panel without proposals instead of failing @regression', async ({ freshPage, freshServer }) => {
    const home = new HomePage(freshPage);
    await home.goto();
    const body = await (await freshPage.request.get(freshServer.url + 'api/organize/proposals')).json();
    expect(Array.isArray(body.proposals)).toBe(true);
    await expect(freshPage.locator('#organize')).toBeVisible();
  });
});
