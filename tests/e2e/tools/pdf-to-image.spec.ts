import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  expectDownload,
  assertZip,
  assertImage,
} from '../helpers/harness';

async function loadPdf(page: import('@playwright/test').Page, file: string) {
  await addSingleFileAndWait(page, file);
  await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
}

test.describe('PDF to Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/pdf-to-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Convert PDF to Image');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('all pages -> PNG produces a ZIP of images', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/pdf-to-image');
    await loadPdf(page, FIXTURE.pdf3page);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertZip(bytes);
    expect(name).toMatch(/-images\.zip$/);
    // The pdf.js worker must be local — no cross-origin request may leak.
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('single-page range -> PNG produces one image file', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await loadPdf(page, FIXTURE.pdf3page);

    await page.getByRole('button', { name: 'Custom range' }).click();
    await page.getByRole('textbox').fill('1');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'png');
    expect(name).toMatch(/-page1\.png$/);
  });

  test('AVIF format exports a valid AVIF image (jSquash encoder)', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await loadPdf(page, FIXTURE.pdf3page);

    await page.getByRole('button', { name: 'avif', exact: true }).click();
    await page.getByRole('button', { name: 'Custom range' }).click();
    await page.getByRole('textbox').fill('1');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'avif');
    expect(name).toMatch(/-page1\.avif$/);
  });

  test('JPEG format exposes a quality slider and exports a JPEG', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await loadPdf(page, FIXTURE.pdf3page);

    // The format button's text is lowercase 'jpeg' (displayed uppercase via CSS).
    await page.getByRole('button', { name: 'jpeg', exact: true }).click();
    await expect(page.getByRole('slider')).toBeVisible();

    await page.getByRole('button', { name: 'Custom range' }).click();
    await page.getByRole('textbox').fill('2');
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    expect(name).toMatch(/\.jpeg$/);
  });
});
