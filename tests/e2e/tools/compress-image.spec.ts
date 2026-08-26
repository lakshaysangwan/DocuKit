import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  PageDiagnostics,
  addSingleFileAndWait,
  addFilesAndWait,
  expectDownload,
  assertImage,
  assertZip,
  expectImageRendered,
} from '../helpers/harness';

test.describe('Compress Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/compress-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Compress Images');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('quality-mode compression yields a valid image + before/after preview', async ({ page }) => {
    await page.goto('/compress-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);

    // Uploaded image preview is visibly rendered.
    await expectImageRendered(page.locator('#main-content img').first());

    // Default: Best (WebP) format, By Quality mode.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });

    // The before/after comparison slider appears (a real operation preview).
    await expect(page.getByText(/Original \(/)).toBeVisible();
    await expect(page.getByText(/Compressed \(/)).toBeVisible();

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    // 'Best (WebP)' encodes to WebP.
    assertImage(bytes, 'webp');
    expect(name).toMatch(/-compressed\.webp$/);
  });

  test('explicit JPEG output with a quality slider', async ({ page }) => {
    await page.goto('/compress-image');
    await addSingleFileAndWait(page, FIXTURE.png);
    await page.getByRole('button', { name: 'JPEG', exact: true }).click();
    await expect(page.getByRole('slider')).toBeVisible();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
  });

  test('batch: multiple images compress to a ZIP', async ({ page }) => {
    await page.goto('/compress-image');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertZip(bytes);
    expect(name).toMatch(/compressed-images\.zip$/);
  });

  test('target-size mode exposes a KB target input', async ({ page }) => {
    await page.goto('/compress-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await page.getByRole('button', { name: 'Target Size' }).click();
    const kb = page.getByRole('spinbutton');
    await expect(kb).toBeVisible();
    await kb.fill('100');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    expect(bytes.length).toBeGreaterThan(0);
  });
});
