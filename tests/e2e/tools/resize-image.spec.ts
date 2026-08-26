import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, addSingleFileAndWait, addFilesAndWait, expectDownload, assertImage, assertZip } from '../helpers/harness';

/** Decode an image buffer and return its pixel dimensions (via the browser). */
async function imageSize(page: import('@playwright/test').Page, bytes: Buffer, mime: string) {
  const b64 = bytes.toString('base64');
  return page.evaluate(
    ({ b64, mime }) =>
      new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('decode failed'));
        img.src = `data:${mime};base64,${b64}`;
      }),
    { b64, mime }
  );
}

test.describe('Resize Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/resize-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Resize Images');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('resizes to explicit width with aspect lock and verifies output dimensions', async ({ page }) => {
    await page.goto('/resize-image');
    await addSingleFileAndWait(page, FIXTURE.jpg); // 1200x800

    const width = page.getByRole('spinbutton').first();
    await width.fill('600');
    // Aspect is locked by default: height should follow to 400.
    await expect(page.getByRole('spinbutton').nth(1)).toHaveValue('400');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });

    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertImage(bytes, 'jpeg');
    expect(name).toMatch(/-600x400\.jpg$/);
    const size = await imageSize(page, bytes, 'image/jpeg');
    expect(size).toEqual({ w: 600, h: 400 });
  });

  test('Cover fit mode is available and produces exact target dimensions', async ({ page }) => {
    await page.goto('/resize-image');
    await addSingleFileAndWait(page, FIXTURE.jpg); // 1200x800

    // Unlock aspect and set a non-matching aspect ratio, then Cover-crop to it.
    await page.getByTitle(/Aspect/).click();
    await page.getByRole('spinbutton').first().fill('500');
    await page.getByRole('spinbutton').nth(1).fill('500');
    await page.getByRole('button', { name: 'Cover (crop)' }).click();

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    const size = await imageSize(page, bytes, 'image/jpeg');
    expect(size).toEqual({ w: 500, h: 500 });
  });

  test('custom presets save and persist across a reload (localStorage)', async ({ page }) => {
    await page.goto('/resize-image');
    // Start clean so the assertion isn't polluted by a previous run's storage.
    await page.evaluate(() => localStorage.removeItem('docukit:resize-presets'));
    await page.reload();
    await addSingleFileAndWait(page, FIXTURE.jpg); // defaults to 1200×800

    // Save the current size as a preset.
    await page.getByTestId('save-preset').click();
    await expect(page.getByTestId('custom-preset')).toHaveCount(1);
    await expect(page.getByTestId('custom-preset')).toContainText('1200×800');

    // Reload, re-add a file — the preset must still be listed (persisted).
    await page.reload();
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByTestId('custom-preset')).toHaveCount(1);
    await expect(page.getByTestId('custom-preset')).toContainText('1200×800');
  });

  test('batch: multiple images resize to a ZIP', async ({ page }) => {
    await page.goto('/resize-image');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.jpg2], 2);

    // Target dims default from the first image; just apply to all.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertZip(bytes);
    expect(name).toMatch(/resized-images\.zip$/);
  });

  test('a social preset sets fixed dimensions and unlocks aspect', async ({ page }) => {
    await page.goto('/resize-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);

    await page.getByText('Social media presets', { exact: true }).click(); // expand <details> summary
    await page.getByRole('button', { name: /YouTube Thumbnail/ }).click();

    await expect(page.getByRole('spinbutton').first()).toHaveValue('1280');
    await expect(page.getByRole('spinbutton').nth(1)).toHaveValue('720');

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    const size = await imageSize(page, bytes, 'image/jpeg');
    expect(size).toEqual({ w: 1280, h: 720 });
  });
});
