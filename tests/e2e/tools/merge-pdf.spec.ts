import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  uploadFiles,
  addFilesAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

test.describe('Merge PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/merge-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Merge PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('shows a preview card per uploaded file', async ({ page }) => {
    await page.goto('/merge-pdf');
    await uploadFiles(page, [FIXTURE.pdf3page, FIXTURE.pdf5page]);
    await expect(page.getByTestId('file-card')).toHaveCount(2);
    // Thumbnails should render (img with a data URL) within a reasonable time.
    await expect(page.getByTestId('file-card').first().locator('img')).toBeVisible({ timeout: 20_000 });
  });

  test('merge button disabled with <2 files, enabled with 2+', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, FIXTURE.pdf1page, 1);
    await expect(page.getByTestId('tool-action')).toBeDisabled();
    await addFilesAndWait(page, FIXTURE.pdf3page, 2);
    await expect(page.getByTestId('tool-action')).toBeEnabled();
  });

  test('merges two PDFs into a valid combined PDF with all pages', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf3page, FIXTURE.pdf5page], 2);

    // Run the merge, then wait for the success state to appear.
    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Merge complete')).toBeVisible({ timeout: 45_000 });

    // Download comes from the dedicated download button that appears on success.
    const { bytes, name } = await expectDownload(page, () =>
      page.getByTestId('download-button').click()
    );

    assertPdf(bytes);
    expect(name).toMatch(/\.pdf$/);
    // 3 + 5 = 8 pages expected.
    expect(countPdfPages(bytes)).toBe(8);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('per-file page selection: only chosen pages are merged', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf3page, FIXTURE.pdf5page], 2);
    // Wait for page counts to load (thumbnails resolve pageCount).
    await expect(page.getByTestId('file-card').first().locator('img')).toBeVisible({ timeout: 20_000 });

    // Take only page 1 from the first file; leave the second file as all pages.
    await page.getByTestId('page-select').locator('summary').click();
    await page.getByTestId('page-range-input').first().fill('1');

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Merge complete')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    // 1 (from file 1) + 5 (all of file 2) = 6 pages.
    expect(countPdfPages(bytes)).toBe(6);
  });

  test('remove button drops a file from the queue', async ({ page }) => {
    await page.goto('/merge-pdf');
    await uploadFiles(page, [FIXTURE.pdf3page, FIXTURE.pdf5page]);
    await expect(page.getByTestId('file-card')).toHaveCount(2);
    await page.getByTestId('file-card').first().hover();
    await page.getByTestId('file-remove').first().click();
    await expect(page.getByTestId('file-card')).toHaveCount(1);
  });

  test('clear all empties the queue', async ({ page }) => {
    await page.goto('/merge-pdf');
    await uploadFiles(page, [FIXTURE.pdf3page, FIXTURE.pdf5page]);
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.getByTestId('file-card')).toHaveCount(0);
  });
});
