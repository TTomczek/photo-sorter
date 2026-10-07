const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/playwright',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.GITHUB_ACTIONS ? [['list'], ['github']] : 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
});
