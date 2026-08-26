import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

test.describe('Watermark PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/watermark-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Add Watermark to PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('applies a text watermark and preserves page count', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    // Default type is Text with "CONFIDENTIAL"; change the text and tweak sliders.
    await page.getByRole('textbox').first().fill('DRAFT COPY');
    await page.getByRole('button', { name: 'tiled' }).click();
    await page.getByRole('button', { name: 'odd pages' }).click();

    await page.getByTestId('tool-action').click();
    // The success text also appears in a toast, so key off the download button.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-watermarked\.pdf$/);
    expect(countPdfPages(bytes)).toBe(5);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('image watermark mode accepts a logo and applies it', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    await page.getByRole('button', { name: 'image Watermark' }).click();
    // The image watermark dropzone is a second file input; upload a PNG logo.
    await page.locator('input[type="file"]').nth(1).setInputFiles(FIXTURE.png);

    await page.getByTestId('tool-action').click();
    // The success text also appears in a toast, so key off the download button.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(3);
  });
});
