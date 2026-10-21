import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  expectDownloads,
  assertPdf,
  countPdfPages,
} from '../helpers/harness';

/**
 * Wait until the split tool has finished loading the PDF: its pages are drawn.
 * (The action is not a signal: Extract and Remove wait for pages to be chosen.)
 */
async function loadPdf(page: import('@playwright/test').Page, file: string) {
  await addSingleFileAndWait(page, file);
  await expect(page.getByTestId('split-page').first()).toBeVisible({ timeout: 20_000 });
}

async function chooseMode(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: label, exact: false }).first().click();
}

test.describe('Split PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/split-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Split PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('extract mode produces a single PDF with only the selected pages', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    // Default mode is Extract Pages. Select pages 1-3.
    await page.getByRole('textbox').fill('1-3');
    await expect(page.getByText('3 of 5 pages selected')).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(name).toMatch(/\.pdf$/);
    expect(countPdfPages(bytes)).toBe(3);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('remove mode keeps the complementary pages', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Remove Pages');
    await page.getByRole('textbox').fill('1-2');
    await expect(page.getByText('2 of 5 pages selected')).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    // 5 pages minus 2 removed = 3 remaining.
    expect(countPdfPages(bytes)).toBe(3);
  });

  test('split-by-range mode produces one PDF per range, as separate downloads', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Split by Range');
    await page.getByRole('textbox').fill('1-2, 3-5');

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/2 files · /)).toBeVisible();

    // A few files arrive as themselves, not in a ZIP.
    await expect(page.getByTestId('download-button')).toHaveText('Download all (2 PDFs)');
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 2);
    expect(files.map((f) => f.name).sort()).toEqual(['doc-5page-part1.pdf', 'doc-5page-part2.pdf']);
    for (const f of files) assertPdf(f.bytes);
    expect(files.map((f) => countPdfPages(f.bytes)).sort()).toEqual([2, 3]);
  });

  test('extract-each mode produces one PDF per page', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Extract Each Page');
    await expect(page.getByTestId('split-output')).toHaveCount(5);

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/5 files · /)).toBeVisible();

    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 5);
    for (const f of files) {
      assertPdf(f.bytes);
      expect(countPdfPages(f.bytes)).toBe(1);
    }
  });

  test('split-every-N mode chunks the document', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Split Every N');
    const n = page.getByRole('spinbutton');
    await n.fill('2');
    await expect(page.getByTestId('split-output')).toHaveCount(3);

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });

    // 5 pages / 2 = 3 parts: 2, 2 and 1 pages, as separate files.
    const files = await expectDownloads(page, () => page.getByTestId('download-button').click(), 3);
    expect(files.map((f) => countPdfPages(f.bytes)).sort()).toEqual([1, 2, 2]);
  });
});
