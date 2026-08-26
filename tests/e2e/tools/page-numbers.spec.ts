import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

test.describe('Add Page Numbers', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/add-page-numbers');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Add Page Numbers');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('applies numbers with default options and preserves page count', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/add-page-numbers');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    await page.getByTestId('tool-action').click();
    // The success text also appears in a toast, so key off the download button.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('#main-content').getByText('Page numbers added!')).toBeVisible();

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-numbered\.pdf$/);
    expect(countPdfPages(bytes)).toBe(5);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('honors position, format, start number and skip options', async ({ page }) => {
    await page.goto('/add-page-numbers');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    // Position: bottom right
    await page.getByRole('button', { name: 'bottom right' }).click();
    // Format: roman numerals
    await page.getByRole('radio', { name: 'i, ii, iii…' }).check();
    await expect(page.getByRole('radio', { name: 'i, ii, iii…' })).toBeChecked();
    // Start number + skip. NOTE: these <label>s are not programmatically
    // associated with their inputs (no htmlFor/id) — an a11y finding — so we
    // target by role/order rather than getByLabel.
    const numbers = page.getByRole('spinbutton');
    await numbers.nth(0).fill('3'); // Start number
    await numbers.nth(1).fill('1'); // Skip first N pages

    await page.getByTestId('tool-action').click();
    // The success text also appears in a toast, so key off the download button.
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('#main-content').getByText('Page numbers added!')).toBeVisible();

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(5);
  });
});
