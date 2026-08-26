import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { uploadFiles, addSingleFileAndWait, addFilesAndWait, unlabelledFormControls } from '../helpers/harness';

/**
 * P4.1 — form-label audit (WCAG 2.1 AA, 1.3.1 / 4.1.2).
 *
 * The site sweep records `inputsMissingLabel` only at page load, but almost
 * every tool renders its option controls *after* a file is uploaded (and some
 * only after switching a mode). This suite drives each tool into the state
 * where its controls are visible, then asserts that **zero** visible form
 * controls lack an accessible name — no `aria-label`/`labelledby`, no
 * `<label for>`, and not wrapped in a `<label>`.
 */

/** Assert every visible form control on the page currently has an accessible name. */
async function assertAllLabelled(page: Page) {
  const bad = await unlabelledFormControls(page);
  expect(bad, `Unlabelled form controls found:\n  ${bad.join('\n  ')}`).toEqual([]);
}

test.describe('P4.1 — every tool control has an accessible name', () => {
  test('image-to-pdf — margins', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, FIXTURE.png, 1);
    // pageSize defaults to A4 → margin inputs are rendered.
    await expect(page.getByLabel('top margin')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('digital-signature — certificate fields', async ({ page }) => {
    await page.goto('/digital-signature-pdf');
    // "Generate New" is the default cert source → CN/Org inputs are shown.
    await expect(page.getByPlaceholder('John Doe')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('page-numbers — number/range/color inputs', async ({ page }) => {
    await page.goto('/add-page-numbers');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);
    await expect(page.getByLabel('Start number')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('crop-pdf — margins and page range', async ({ page }) => {
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByLabel('top margin')).toBeVisible();
    await assertAllLabelled(page);
    // Reveal the page-range text input.
    await page.getByRole('button', { name: 'Page range' }).click();
    await expect(page.getByLabel('Page range to crop')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('split-pdf — range and every-N', async ({ page }) => {
    await page.goto('/split-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    // Default mode "Extract Pages" shows the page-selection input.
    await expect(page.getByLabel('Page selection')).toBeVisible();
    await assertAllLabelled(page);
    // Switch to "Split Every N" to reveal the chunk-size input.
    await page.getByRole('button', { name: /Split Every N/ }).click();
    await expect(page.getByLabel('Pages per chunk')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('compress-pdf — custom settings', async ({ page }) => {
    await page.goto('/compress-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(page.getByLabel('Image DPI')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('compress-image — quality and target size', async ({ page }) => {
    await page.goto('/compress-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByLabel('Quality')).toBeVisible();
    await assertAllLabelled(page);
    await page.getByRole('button', { name: 'Target Size' }).click();
    await expect(page.getByLabel('Target Size (KB)')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('resize-image — dimensions', async ({ page }) => {
    await page.goto('/resize-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByLabel('Width (px)')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('convert-image — quality', async ({ page }) => {
    await page.goto('/convert-image');
    await addFilesAndWait(page, FIXTURE.png, 1);
    // Default target is WebP (non-PNG) → quality slider shows.
    await expect(page.getByLabel('Quality')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('pdf-to-image — quality and custom range', async ({ page }) => {
    await page.goto('/pdf-to-image');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await page.getByRole('button', { name: 'jpeg' }).click();
    await expect(page.getByLabel('Quality')).toBeVisible();
    await assertAllLabelled(page);
    await page.getByRole('button', { name: 'Custom range' }).click();
    await expect(page.getByLabel('Page range to convert')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('watermark-pdf — text options', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);
    await expect(page.getByLabel('Watermark Text')).toBeVisible();
    await assertAllLabelled(page);
  });

  test('protect-pdf — password fields', async ({ page }) => {
    await page.goto('/protect-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf1page);
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await assertAllLabelled(page);
  });

  test('lock-image — password fields', async ({ page }) => {
    await page.goto('/lock-image');
    await addSingleFileAndWait(page, FIXTURE.jpg);
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await assertAllLabelled(page);
  });

  test('merge-pdf — per-file page ranges', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf1page, FIXTURE.pdf3page], 2);
    await page.getByText('Choose pages per file (optional)').click();
    await expect(page.getByTestId('page-range-input').first()).toBeVisible();
    await assertAllLabelled(page);
  });

  test('redact-pdf — find & redact search', async ({ page }) => {
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId('redact-search')).toBeVisible({ timeout: 30_000 });
    await assertAllLabelled(page);
  });

  test('sign-pdf — typed signature', async ({ page }) => {
    await page.goto('/sign-pdf');
    // The signature island hydrates on idle with no dropzone to gate on, so retry
    // the tab click until the panel switches (a pre-hydration click is lost).
    await expect(async () => {
      await page.getByRole('button', { name: 'type', exact: true }).click();
      await expect(page.getByLabel('Signature text')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await assertAllLabelled(page);
  });
});
