import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, addSingleFileAndWait, expectDownload, assertPdf } from '../helpers/harness';

async function runLevel(
  page: import('@playwright/test').Page,
  levelLabel: string,
  fixture: string = FIXTURE.pdf5page,
) {
  await addSingleFileAndWait(page, fixture);
  await page.getByRole('button', { name: levelLabel }).click();
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  return expectDownload(page, () => page.getByTestId('download-button').click());
}

test.describe('Compress PDF', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/compress-pdf');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Compress PDF');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('Low (lossless) level yields a valid PDF no larger than the original', async ({ page }) => {
    const orig = (await readFile(FIXTURE.pdfPhoto)).length;
    await page.goto('/compress-pdf');
    const { bytes, name } = await runLevel(page, 'Low', FIXTURE.pdfPhoto);
    assertPdf(bytes);
    expect(name).toMatch(/-compressed\.pdf$/);
    // Lossless: never bigger than the input (structural optimization only).
    expect(bytes.length).toBeLessThanOrEqual(orig);
  });

  test('Medium and High measurably shrink an image-heavy PDF (High < Medium)', async ({ page }) => {
    const orig = (await readFile(FIXTURE.pdfPhoto)).length;

    await page.goto('/compress-pdf');
    const { bytes: medium } = await runLevel(page, 'Medium', FIXTURE.pdfPhoto);
    assertPdf(medium);
    expect(medium.length, 'Medium should be clearly smaller than the original').toBeLessThan(orig * 0.9);

    await page.goto('/compress-pdf');
    const { bytes: high } = await runLevel(page, 'High', FIXTURE.pdfPhoto);
    assertPdf(high);
    expect(high.length, 'High should be smaller than Medium').toBeLessThan(medium.length);
  });

  test('Medium level yields a valid PDF and reports before/after sizes', async ({ page }) => {
    await page.goto('/compress-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await page.getByRole('button', { name: 'Medium' }).click();
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    // The result panel always shows a Before/After breakdown.
    await expect(page.getByText(/Before:/)).toBeVisible();
    await expect(page.getByText(/After:/)).toBeVisible();
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
  });

  test('Custom level reveals DPI / quality / grayscale / font controls', async ({ page }) => {
    await page.goto('/compress-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    await page.getByRole('button', { name: 'Custom' }).click();

    // Custom panel controls become available.
    await expect(page.getByText('Custom settings')).toBeVisible();
    const sliders = page.getByRole('slider');
    await expect(sliders).toHaveCount(2); // DPI + JPEG quality
    await page.getByRole('checkbox', { name: /grayscale/i }).check();
    await expect(page.getByRole('checkbox', { name: /grayscale/i })).toBeChecked();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);
  });
});
