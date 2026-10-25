import { test, expect } from '@playwright/test';
import { writeFile, rm } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, uploadFiles } from '../helpers/harness';

/**
 * P5.3 — large-file heads-up. Everything runs client-side in WASM, so a very
 * large input can be slow and memory-heavy. FileInfoCard (shared by every
 * single-file tool) shows a non-blocking warning once a file crosses the 50 MB
 * threshold, and stays quiet for normal files.
 */

test.describe('P5.3 — large-file warning', () => {
  test('a >50MB file shows the heads-up', async ({ page }, testInfo) => {
    // 51 MB with a PNG signature — Lock Image reads the bytes at load but does
    // not decode them, so the file registers and the size-based warning renders.
    // Playwright caps in-memory upload buffers at 50 MB, so stage it on disk and
    // upload by path.
    const big = Buffer.alloc(51 * 1024 * 1024, 0x20);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    // Inside the test's own output folder, which Playwright clears before the next run.
    const tmp = testInfo.outputPath('docukit-huge.png');
    await writeFile(tmp, big);

    try {
      await page.goto('/lock-image');
      await uploadFiles(page, tmp);
      await expect(page.getByTestId('file-info')).toBeVisible();
      await expect(page.getByTestId('large-file-warning')).toBeVisible();
    } finally {
      // On Windows the browser can still hold the file it was handed (WebKit
      // does, every time): EBUSY / EPERM. Retry for a moment, then leave it to
      // Playwright's own clean-up of the output folder — a file that cannot be
      // deleted yet says nothing about the warning this test checks.
      await rm(tmp, { force: true, maxRetries: 5, retryDelay: 200 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      });
    }
  });

  test('a normal file stays quiet', async ({ page }) => {
    await page.goto('/lock-image');
    await addSingleFileAndWait(page, FIXTURE.png);
    await expect(page.getByTestId('large-file-warning')).toHaveCount(0);
  });
});
