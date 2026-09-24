import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests of the built extension (`npm run test:e2e` builds first).
 * Every test launches its own browser profile with the unpacked extension, so
 * tests run one at a time. See e2e/harness.ts for how the browser is chosen.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    actionTimeout: 15_000,
  },
});
