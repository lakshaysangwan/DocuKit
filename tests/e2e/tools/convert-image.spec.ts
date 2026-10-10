import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addFilesAndWait,
  expectDownload,
  assertZip,
  assertImage,
} from '../helpers/harness';

test.describe('Convert Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/convert-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Convert Image Format');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('single JPG → PNG produces one PNG file', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.jpg, 1);
    await page.getByRole('button', { name: 'PNG', exact: true }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'png');
    expect(name).toMatch(/\.png$/);
  });

  test('batch JPG+PNG → WebP produces a ZIP', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);
    // WebP is the default target format; quality slider is available for it.
    await expect(page.getByRole('slider')).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertZip(bytes);
    expect(name).toMatch(/converted-images\.zip$/);
  });

  test('PNG → AVIF produces a valid AVIF file (jSquash encoder)', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.png, 1);
    await page.getByRole('button', { name: 'AVIF', exact: true }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'avif');
    expect(name).toMatch(/\.avif$/);
  });

  test('JPG → JPG exposes a quality slider and outputs a JPEG', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.png, 1);
    await page.getByRole('button', { name: 'JPG', exact: true }).click();
    await expect(page.getByRole('slider')).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    expect(name).toMatch(/\.jpg$/);
  });
});

/**
 * HEIC is the one accepted input no browser decodes natively, so it goes
 * through libheif (heic-to). That path is the first thing a stricter
 * Content-Security-Policy breaks — heic-to's default build evaluates a string
 * as script — which is why these run against a real HEVC-coded file.
 */
test.describe('Convert Image — HEIC (iPhone) input', () => {
  test('HEIC → JPG produces a valid JPEG', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.heic, 1);
    await page.getByRole('button', { name: 'JPG', exact: true }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    expect(name).toBe('photo.jpg');
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('HEIC → PNG produces a valid PNG', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.heic, 1);
    await page.getByRole('button', { name: 'PNG', exact: true }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'png');
  });

  test('a file the browser cannot preview shows a placeholder, not a broken image', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.heic, 1);
    // The <img> fails to decode and is swapped out for the placeholder.
    await expect(page.getByTestId('file-card').getByTestId('file-thumbnail')).toHaveCount(0);
    await expect(page.getByTestId('file-card')).toContainText('photo.heic');
  });
});
