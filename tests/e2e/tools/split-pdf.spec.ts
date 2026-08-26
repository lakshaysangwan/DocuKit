import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertPdf,
  assertZip,
  countPdfPages,
} from '../helpers/harness';

/** Wait until the split tool has finished loading the PDF (action enabled). */
async function loadPdf(page: import('@playwright/test').Page, file: string) {
  await addSingleFileAndWait(page, file);
  await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
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

  test('split-by-range mode produces a ZIP of multiple PDFs', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Split by Range');
    await page.getByRole('textbox').fill('1-2, 3-5');

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/2 files · /)).toBeVisible();

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertZip(bytes);
    expect(name).toMatch(/\.zip$/);
  });

  test('extract-each mode produces a ZIP with one PDF per page', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Extract Each Page');
    await expect(page.getByText(/Will create 5 individual PDF files/)).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/5 files · /)).toBeVisible();

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertZip(bytes);
  });

  test('split-every-N mode chunks the document', async ({ page }) => {
    await page.goto('/split-pdf');
    await loadPdf(page, FIXTURE.pdf5page);

    await chooseMode(page, 'Split Every N');
    const n = page.getByRole('spinbutton');
    await n.fill('2');
    await expect(page.getByText(/Creates ~3 parts/)).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByText('Split complete!')).toBeVisible({ timeout: 45_000 });

    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    // 5 pages / 2 = 3 parts -> ZIP.
    assertZip(bytes);
  });
});
