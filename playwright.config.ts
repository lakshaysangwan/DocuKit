import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Docukit.
 *
 * Docukit is a 100% client-side app: every tool runs in the browser via
 * WebAssembly workers. Those workers require cross-origin isolation
 * (COOP/COEP headers), which the Astro dev server already sets in
 * astro.config.mjs. So we run the tests against `astro dev`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  // Client-side processing can be slow (WASM cold-start, PDF rendering).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // WASM tools are CPU-heavy; limit parallelism so runs stay stable on a laptop.
  workers: process.env.CI ? 2 : 3,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Downloads are how tools deliver output — we assert on them.
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The full functional/a11y suite runs on desktop; mobile-only specs are
      // exercised by the `mobile` project below.
      testIgnore: '**/mobile/**',
    },
    {
      // P5.4 — phone-viewport pass: layout/rendering smoke on a real mobile
      // device profile. Scoped to tests/e2e/mobile so the heavy WASM functional
      // suite isn't re-run on mobile.
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: '**/mobile/**',
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
