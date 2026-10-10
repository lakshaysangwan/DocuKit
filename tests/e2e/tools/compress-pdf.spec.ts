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

/** Compress the image-heavy fixture in Target size mode and return the download. */
async function runTarget(page: import('@playwright/test').Page, value: number, unit: 'KB' | 'MB' = 'KB') {
  await page.goto('/compress-pdf');
  await addSingleFileAndWait(page, FIXTURE.pdfPhoto);
  await page.getByRole('button', { name: /Target size/ }).click();
  await page.getByLabel('Make the PDF no larger than').fill(String(value));
  await page.getByLabel('Size unit').selectOption(unit);
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
  return expectDownload(page, () => page.getByTestId('download-button').click());
}

test.describe('Compress PDF — target size', () => {
  test('the output fits under a reachable target and is still a valid PDF', async ({ page }) => {
    const { bytes } = await runTarget(page, 30);
    assertPdf(bytes);
    expect(bytes.length).toBeLessThanOrEqual(30 * 1024);
    await expect(page.getByTestId('target-missed')).toHaveCount(0);
  });

  test('a looser target keeps more quality: it is not compressed harder than needed', async ({ page }) => {
    const loose = await runTarget(page, 45);
    const tight = await runTarget(page, 12);
    expect(loose.bytes.length).toBeLessThanOrEqual(45 * 1024);
    expect(tight.bytes.length).toBeLessThanOrEqual(12 * 1024);
    // Same input, so the only reason for the difference is the target.
    expect(loose.bytes.length).toBeGreaterThan(tight.bytes.length);
  });

  test('an unreachable target is reported, not passed off as success', async ({ page }) => {
    const orig = (await readFile(FIXTURE.pdfPhoto)).length;
    const { bytes } = await runTarget(page, 1);
    assertPdf(bytes);
    // Best effort is still delivered…
    expect(bytes.length).toBeLessThan(orig);
    expect(bytes.length).toBeGreaterThan(1024);
    // …with the miss stated plainly.
    await expect(page.getByTestId('target-missed')).toContainText('could not be brought under 1 KB');
  });

  test('a file already under the target is never made larger', async ({ page }) => {
    const orig = (await readFile(FIXTURE.pdfPhoto)).length;
    const { bytes } = await runTarget(page, 1, 'MB');
    assertPdf(bytes);
    expect(bytes.length).toBeLessThanOrEqual(orig);
    await expect(page.getByTestId('target-missed')).toHaveCount(0);
  });
});
