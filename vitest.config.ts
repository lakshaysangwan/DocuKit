import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the fast unit tests that live next to the source (`src/**​/*.test.ts`).
 * The end-to-end suite under `tests/e2e` is Playwright — those `*.spec.ts` files
 * must be excluded here or Vitest tries to import them and fails on the
 * `@playwright/test` runner API.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
