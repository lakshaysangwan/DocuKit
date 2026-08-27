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
  // WASM-heavy tools across four projects saturate a laptop; a single local retry
  // separates genuine failures from contention without hiding regressions (a test
  // that fails twice in a row is reported).
  retries: process.env.CI ? 2 : 1,
  // WASM tools are CPU-heavy; limit parallelism so runs stay stable on a laptop.
  // Running Chromium + Firefox + WebKit + mobile multiplies that load, so keep
  // the local worker count conservative.
  workers: 2,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    // E2E_BASE_URL lets the suite run against a production build served by
    // scripts/serve-dist.mjs, instead of the Vite dev server.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4321',
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
      // P6.3 — cross-browser parity. Docukit leans on OffscreenCanvas, WASM
      // workers, cross-origin isolation and blob downloads, all of which differ
      // by engine, so the FULL desktop suite runs on Gecko and WebKit too
      // rather than on a smoke subset.
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: '**/mobile/**',
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
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
  // Skipped when pointing at an already-running server (see E2E_BASE_URL).
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
