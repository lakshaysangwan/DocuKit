import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE } from '../fixtures/generate';
import {
  uploadFiles,
  addSingleFileAndWait,
  expectImageRendered,
} from '../helpers/harness';

/**
 * UX "operation visibility" checks — verify that what a tool does to a document
 * is actually visible on screen, not just correct in the output bytes:
 *   • page/thumbnail previews are really painted (not blank placeholders)
 *   • an edit visibly changes the canvas (add-object screenshot differs)
 *   • a redaction mark is visibly drawn before applying
 * Screenshots are saved to test-results/screens/ as audit evidence.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = path.join(DIR, '..', '..', '..', 'test-results', 'screens');
const shot = (name: string) => path.join(SCREENS, `${name}.png`);

test.describe('UX: operation visibility', () => {
  test('Merge — every uploaded file shows a rendered page thumbnail', async ({ page }) => {
    await page.goto('/merge-pdf');
    await uploadFiles(page, [FIXTURE.pdf3page, FIXTURE.pdf5page]);
    const cards = page.getByTestId('file-card');
    await expect(cards).toHaveCount(2);
    // Both cards must show a real (decoded) thumbnail image.
    await expectImageRendered(cards.nth(0).locator('img'));
    await expectImageRendered(cards.nth(1).locator('img'));
    await page.screenshot({ path: shot('merge-thumbnails'), fullPage: false });
  });

  test('Reorder — each page is clearly visible as a rendered thumbnail', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf5page);
    const thumbs = page.getByTestId('page-thumb');
    await expect(thumbs).toHaveCount(5);
    // Every page thumbnail must be genuinely rendered (naturalWidth > 0).
    for (let i = 0; i < 5; i++) {
      await expectImageRendered(thumbs.nth(i).locator('img'));
    }
    await page.locator('#main-content').screenshot({ path: shot('reorder-pages-visible') });
  });

  test('Edit — adding a text annotation visibly changes the canvas', async ({ page }) => {
    await page.goto('/edit-pdf');
    await uploadFiles(page, FIXTURE.pdf3page);
    const canvas = page.getByTestId('editor-canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // Let the page background render onto the Fabric canvas first.
    await page.waitForTimeout(800);

    const before = await canvas.screenshot({ path: shot('edit-before') });
    // Add a text object — it should appear (and be selected) on the canvas.
    await page.locator('button[title="Text Box (T)"]').click();
    await page.waitForTimeout(800);
    const after = await canvas.screenshot({ path: shot('edit-after') });

    // The canvas pixels must change — proof the added annotation is visible.
    expect(Buffer.compare(before, after), 'canvas should change after adding text').not.toBe(0);
  });

  test('Watermark — live preview renders and updates when options change', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    const preview = page.getByTestId('watermark-preview');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    // The preview canvas is really sized (rendered), not a 0×0 placeholder.
    await expect
      .poll(async () => preview.evaluate((c: HTMLCanvasElement) => c.width * c.height))
      .toBeGreaterThan(0);

    const before = await preview.screenshot({ path: shot('watermark-preview-before') });

    // Change the opacity (its slider is the only one with min=5) — the
    // composited watermark must visibly change.
    await page.locator('input[type="range"][min="5"]').fill('95');
    await page.waitForTimeout(400);
    const after = await preview.screenshot({ path: shot('watermark-preview-after') });

    expect(Buffer.compare(before, after), 'preview should change when opacity changes').not.toBe(0);
  });

  test('Page numbers — live preview renders and updates when the format changes', async ({ page }) => {
    await page.goto('/add-page-numbers');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    const preview = page.getByTestId('page-numbers-preview');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => preview.evaluate((c: HTMLCanvasElement) => c.width * c.height))
      .toBeGreaterThan(0);

    const before = await preview.screenshot({ path: shot('page-numbers-preview-before') });

    // Switch the number format — the rendered label must visibly change.
    await page.locator('input[type="radio"][value="roman"]').check();
    await page.waitForTimeout(400);
    const after = await preview.screenshot({ path: shot('page-numbers-preview-after') });

    expect(Buffer.compare(before, after), 'preview should change when format changes').not.toBe(0);
  });

  test('Compress — before/after preview appears with both pages rendered', async ({ page }) => {
    await page.goto('/compress-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdfPhoto);
    await page.getByRole('button', { name: 'High' }).click();
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

    const preview = page.getByTestId('compress-preview');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    const imgs = preview.locator('img');
    await expect(imgs).toHaveCount(2);
    // Both the original and compressed page renders must be genuinely painted.
    await expectImageRendered(imgs.nth(0));
    await expectImageRendered(imgs.nth(1));
    // The two renders come from different bytes (original vs compressed).
    const srcs = await imgs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
    expect(srcs[0]).not.toBe(srcs[1]);
    await page.locator('#main-content').screenshot({ path: shot('compress-before-after') });
  });

  test('Crop — visual preview renders and auto-crop sets margins from content', async ({ page }) => {
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);

    const preview = page.getByTestId('crop-preview');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => preview.evaluate((c: HTMLCanvasElement) => c.width * c.height))
      .toBeGreaterThan(0);

    const before = await preview.screenshot({ path: shot('crop-preview-before') });

    // Auto-crop should detect the content bbox and set non-zero margins…
    await page.getByTestId('crop-autocrop').click();
    await page.waitForTimeout(500);

    // …at least one margin input becomes > 0…
    const values = await page.locator('input[type="number"]').evaluateAll((els) =>
      els.map((e) => Number((e as HTMLInputElement).value)),
    );
    expect(Math.max(...values), 'auto-crop sets a non-zero margin').toBeGreaterThan(0);

    // …and the crop rectangle visibly moves.
    const after = await preview.screenshot({ path: shot('crop-preview-after') });
    expect(Buffer.compare(before, after), 'crop overlay should change after auto-crop').not.toBe(0);
  });

  test('Redact — a drawn mark is visibly overlaid before applying', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 2200 });
    await page.goto('/redact-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    const pageEl = page.getByTestId('redact-page').first();
    await expectImageRendered(pageEl.locator('img'));
    await pageEl.scrollIntoViewIfNeeded();

    const box = await pageEl.boundingBox();
    if (!box) throw new Error('no box');
    const x1 = box.x + box.width * 0.25;
    const y1 = box.y + box.height * 0.06;
    const x2 = box.x + box.width * 0.65;
    const y2 = box.y + box.height * 0.16;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(x2, y2, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.up();

    // The red redaction overlay must be visible with a real size.
    const overlay = pageEl.locator('div.bg-red-600\\/60');
    await expect(overlay).toBeVisible();
    const ob = await overlay.boundingBox();
    expect(ob && ob.width > 5 && ob.height > 5, 'redaction overlay has visible area').toBeTruthy();
    await pageEl.screenshot({ path: shot('redact-mark-visible') });
  });
});
