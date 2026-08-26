import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addFilesAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

test.describe('Image to PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/image-to-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Convert Images to PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('two images → one PDF with a page per image (A4 + center)', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);

    // Defaults: A4 page size, center placement.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/\.pdf$/);
    expect(countPdfPages(bytes)).toBe(2);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('Fit Image page size hides placement/margins and yields one page', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, FIXTURE.jpg, 1);

    await page.getByRole('button', { name: 'Fit Image' }).click();
    // In Fit mode, placement + margin controls are hidden — the 4 margin
    // spinbuttons disappear (the label text also appears in page copy, so we
    // assert on the controls, not the text).
    await expect(page.getByRole('spinbutton')).toHaveCount(0);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(1);
  });

  test('Letter page size with cover placement still produces a valid PDF', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.jpg2], 2);
    await page.getByRole('button', { name: 'Letter' }).click();
    await page.getByRole('button', { name: 'cover', exact: true }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(2);
  });
});
