import { test, expect } from '@playwright/test';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, uploadFiles } from '../helpers/harness';

/**
 * P5.3 — large-file heads-up. Everything runs client-side in WASM, so a very
 * large input can be slow and memory-heavy. FileInfoCard (shared by every
 * single-file tool) shows a non-blocking warning once a file crosses the 50 MB
 * threshold, and stays quiet for normal files.
 */

test.describe('P5.3 — large-file warning', () => {
  test('a >50MB file shows the heads-up', async ({ page }) => {
    // 51 MB with a PDF header — watermark reads bytes at load but doesn't parse,
    // so the file registers and the size-based warning renders. Playwright caps
    // in-memory upload buffers at 50 MB, so stage it on disk and upload by path.
    const big = Buffer.alloc(51 * 1024 * 1024, 0x20);
    Buffer.from('%PDF-1.7\n').copy(big);
    const tmp = path.join(tmpdir(), `docukit-huge-${Date.now()}.pdf`);
    await writeFile(tmp, big);

    try {
      await page.goto('/watermark-pdf');
      await uploadFiles(page, tmp);
      await expect(page.getByTestId('file-info')).toBeVisible();
      await expect(page.getByTestId('large-file-warning')).toBeVisible();
    } finally {
      await rm(tmp, { force: true });
    }
  });

  test('a normal file stays quiet', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);
    await expect(page.getByTestId('large-file-warning')).toHaveCount(0);
  });
});
