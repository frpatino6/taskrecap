// E2E configuration: ONE project on purpose (Chromium, desktop 1280x800, English UI, light theme).
// The app under test is started by the fixtures (fixtures/app.js), one server per worker, so there is no webServer here.
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './specs',
  outputDir: './.output/results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { outputFolder: './.output/report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
