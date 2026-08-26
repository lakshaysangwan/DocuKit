import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

async function loadPdf(page: import('@playwright/test').Page, file: string, expectedPages: number) {
  await addSingleFileAndWait(page, file);
  await expect(page.getByTestId('page-thumb')).toHaveCount(expectedPages, { timeout: 20_000 });
}

test.describe('Rearrange PDF Pages', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/rearrange-pdf-pages');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Rearrange PDF Pages');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('renders a thumbnail per page and applies with no edits', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf5page, 5);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/-organized\.pdf$/);
    expect(countPdfPages(bytes)).toBe(5);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('deleting a page drops it from output; undo restores it', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf5page, 5);

    // Delete the first page (hover reveals the delete control).
    const firstThumb = page.getByTestId('page-thumb').first();
    await firstThumb.hover();
    await firstThumb.getByRole('button', { name: 'Delete page' }).click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);

    // Undo restores it.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(5);

    // Delete again and apply -> 4-page output.
    await page.getByTestId('page-thumb').first().hover();
    await page.getByTestId('page-thumb').first().getByRole('button', { name: 'Delete page' }).click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(4);
  });

  test('rotating a page still produces a valid PDF with all pages', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf3page, 3);

    const firstThumb = page.getByTestId('page-thumb').first();
    await firstThumb.hover();
    await firstThumb.getByRole('button', { name: 'Rotate clockwise' }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(3);
  });
});
