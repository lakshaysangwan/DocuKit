import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

test.describe('Crop PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/crop-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Crop PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('crops all pages with numeric margins and preserves page count', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    // margins order in DOM: top, right, bottom, left
    const margins = page.getByRole('spinbutton');
    await margins.nth(0).fill('20'); // top
    await margins.nth(3).fill('20'); // left

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-cropped\.pdf$/);
    expect(countPdfPages(bytes)).toBe(5);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('supports pt units and a page-range subset', async ({ page }) => {
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);

    await page.getByRole('button', { name: 'pt', exact: true }).click();
    const margins = page.getByRole('spinbutton');
    await margins.nth(1).fill('30'); // right

    await page.getByRole('button', { name: 'Page range' }).click();
    await page.getByRole('textbox').fill('1-2');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(5);
  });
});
