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

/** Rotation of every page in the output, read with a real parser. */
async function pageRotations(bytes: Buffer): Promise<number[]> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => p.getRotation().angle);
}

async function applyAndReadRotations(page: import('@playwright/test').Page): Promise<number[]> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
  return pageRotations(bytes);
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

    // Delete the first page with the button on its card.
    await page.getByRole('button', { name: 'Delete page 1', exact: true }).click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);

    // Undo restores it.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(5);

    // Delete again and apply -> 4-page output.
    await page.getByRole('button', { name: 'Delete page 1', exact: true }).click();
    await expect(page.getByTestId('page-thumb')).toHaveCount(4);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(4);
  });

  test('rotating a page turns that page in the file, and only it', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf3page, 3);

    await page.getByRole('button', { name: 'Rotate page 1 right', exact: true }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
    expect(countPdfPages(bytes)).toBe(3);
    expect(await pageRotations(bytes)).toEqual([90, 0, 0]);
  });
});

test.describe('Rearrange PDF Pages — batch rotation', () => {
  test('"Rotate all right" turns every page', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf3page, 3);

    await page.getByRole('button', { name: /Rotate all right/ }).click();

    expect(await applyAndReadRotations(page)).toEqual([90, 90, 90]);
  });

  test('"Rotate selected right" turns the selected pages, and only them', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf3page, 3);

    const thumbs = page.getByTestId('page-thumb');
    await thumbs.nth(0).click();
    await thumbs.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('selection-summary')).toHaveText('2 of 3 pages selected.');

    await page.getByRole('button', { name: /Rotate selected right/ }).click();

    expect(await applyAndReadRotations(page)).toEqual([90, 90, 0]);
  });

  test('a batch rotation is a single undo step', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await loadPdf(page, FIXTURE.pdf3page, 3);

    await page.getByRole('button', { name: /Rotate all left/ }).click();
    await page.getByRole('button', { name: /Undo/ }).click();

    expect(await applyAndReadRotations(page)).toEqual([0, 0, 0]);
  });
});
