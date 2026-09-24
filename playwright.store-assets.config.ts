import { defineConfig } from '@playwright/test';

/** `npm run store-assets`: captures the Chrome Web Store images into store-assets/. */
export default defineConfig({
  testDir: './scripts/store-assets',
  outputDir: './test-results/store-assets',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});
