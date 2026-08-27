import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the fast unit tests that live next to the source (any `.test.ts`
 * under src/, per the include below),
 * plus the Cloudflare Pages Functions under `functions/` — the view-once
 * backend's delete-on-read behaviour is a real advertised guarantee, and a unit
 * test with a stub KV is the only way to prove it (the e2e suite runs against a
 * static build with no Functions runtime).
 *
 * The end-to-end suite under `tests/e2e` is Playwright — those `*.spec.ts` files
 * must be excluded here or Vitest tries to import them and fails on the
 * `@playwright/test` runner API.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
  },
});
