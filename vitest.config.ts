import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so the CRXJS plugin (which expects a real
// extension build) never runs inside the test runner.
export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
});
