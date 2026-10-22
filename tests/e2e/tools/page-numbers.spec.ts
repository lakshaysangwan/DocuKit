import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, assertPdf, countPdfPages, extractPdfText } from '../helpers/harness';
import { fileNumbers, numberAndDownload, openPageNumbers } from '../helpers/page-numbers';

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
    await openPageNumbers(page, FIXTURE.pdf5page);
    await expect(page.getByTestId('action-hint')).toHaveText('Numbers all 5 pages.');

    const bytes = await numberAndDownload(page);
    await expect(page.getByTestId('page-numbers-result')).toContainText('Page numbers added');
    await expect(page.getByTestId('page-numbers-result')).toContainText('On all 5 pages.');
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect((await fileNumbers(bytes, i)).map((n) => n.text)).toEqual([`Page ${i + 1} of 5`]);
      expect(await extractPdfText(bytes, i)).toContain(`Page ${i + 1} of 5`);
    }
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('honors position, format, start number and skip options', async ({ page }) => {
    await openPageNumbers(page, FIXTURE.pdf5page);

    await page.getByRole('button', { name: 'Bottom right' }).click();
    await expect(page.getByRole('button', { name: 'Bottom right' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('radio', { name: 'i, ii, iii…' }).check();
    await expect(page.getByRole('radio', { name: 'i, ii, iii…' })).toBeChecked();
    await page.getByLabel('Start number').fill('3');
    await page.getByLabel('Skip first N pages').fill('1');

    const bytes = await numberAndDownload(page);
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(5);
    const texts = [];
    for (let i = 0; i < 5; i++) texts.push((await fileNumbers(bytes, i)).map((n) => n.text).join());
    expect(texts).toEqual(['', 'iii', 'iv', 'v', 'vi']);
    // Bottom right: the number ends near the right edge, near the bottom.
    const [n] = await fileNumbers(bytes, 2);
    expect(n.corners[1][0]).toBeGreaterThan(0.8);
    expect(n.corners[0][1]).toBeGreaterThan(0.9);
  });
});
