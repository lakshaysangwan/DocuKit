import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, addFilesAndWait, uploadFiles, expectImageRendered } from '../helpers/harness';

/**
 * Phase 7 — visual regression for the preview surfaces.
 *
 * operation-visibility.spec.ts proves a preview renders *something* and that it
 * changes when options change. That catches a blank canvas, but not a preview
 * that renders the wrong thing — shifted text, a watermark at the wrong opacity,
 * numbers in the wrong corner. These pin the actual pixels.
 *
 * Chromium only, deliberately. Font rasterisation and canvas compositing differ
 * enough between engines that per-engine baselines would triple the committed
 * PNGs and generate diffs that say nothing about the app. Cross-engine
 * *correctness* is covered by the functional suite, which runs everywhere.
 *
 * Regenerate after an intentional UI change:
 *   npx playwright test --project=chromium tests/e2e/visual/snapshots.spec.ts --update-snapshots
 */
test.describe('P7 — visual regression: preview surfaces', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'baselines are Chromium-only by design');

  // WASM rendering is deterministic in content but can differ by a hair in
  // antialiasing between runs; allow a small ratio rather than exact equality.
  const shot = { maxDiffPixelRatio: 0.02, animations: 'disabled' as const };

  test.beforeEach(async ({ page }) => {
    // Removes the fade-ins, so a snapshot can never catch a half-faded element.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('watermark preview', async ({ page }) => {
    await page.goto('/watermark-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    // The page in the workspace viewer with the watermark drawn over it.
    await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
    const preview = page.getByTestId('watermark-preview');
    await expect(preview).toHaveAttribute('data-count', '1', { timeout: 20_000 });
    await expectImageRendered(page.getByTestId('page-image'));
    await expect(preview).toHaveScreenshot('watermark-preview.png', shot);
  });

  test('page-numbers preview', async ({ page }) => {
    await page.goto('/add-page-numbers');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    // The page in the workspace viewer with its number drawn over it.
    await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
    const preview = page.getByTestId('page-numbers-preview');
    await expect(preview).toHaveAttribute('data-text', 'Page 1 of 3', { timeout: 20_000 });
    await expectImageRendered(page.getByTestId('page-image'));
    await expect(preview).toHaveScreenshot('page-numbers-preview.png', shot);
  });

  test('crop preview', async ({ page }) => {
    await page.goto('/crop-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    // The page in the workspace viewer with the crop box over it, 30pt off each side.
    await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'pt', exact: true }).click();
    for (const side of ['top', 'right', 'bottom', 'left']) await page.locator(`#crop-margin-${side}`).fill('30');
    await expectImageRendered(page.getByTestId('page-image'));
    const preview = page.getByTestId('crop-preview');
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview).toHaveScreenshot('crop-preview.png', shot);
  });

  test('editor canvas', async ({ page }) => {
    await page.goto('/edit-pdf');
    // edit-pdf opens the workspace with the first page large.
    await uploadFiles(page, FIXTURE.pdf3page);
    const canvas = page.locator('[data-testid="page-canvas"][data-rendered="true"]');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // A text box and a rectangle on the page, the rectangle selected with its handles.
    await page.getByTestId('add-text').click();
    await page.getByTestId('add-rect').click();
    await expect(page.getByTestId('overlay-item')).toHaveCount(2);
    await expect(canvas).toHaveScreenshot('editor-canvas.png', shot);
  });

  test('merge page thumbnail', async ({ page }) => {
    await page.goto('/merge-pdf');
    await addFilesAndWait(page, [FIXTURE.pdf3page], 1);
    // The first page of the merged PDF, in the "Pages in the merged PDF" grid.
    const img = page.getByTestId('merge-page').first().locator('img');
    await expectImageRendered(img);
    await expect(img).toHaveScreenshot('merge-thumbnail.png', shot);
  });

  test('organize page thumbnail', async ({ page }) => {
    await page.goto('/rearrange-pdf-pages');
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    const thumb = page.getByTestId('page-thumb').first();
    await expect(thumb).toBeVisible({ timeout: 20_000 });
    await expect(thumb.locator('img').first()).toBeVisible({ timeout: 20_000 });
    await expect(thumb).toHaveScreenshot("organize-page-thumb.png", shot);
  });
});

/**
 * Phase 8 — visual regression for the CONTROL surfaces.
 *
 * The block above pins preview canvases; nothing pinned the panels around them.
 * That gap is why closing the copy-drift list added controls to seven tools
 * without a single snapshot changing. Behaviour is asserted in
 * parity/closed-gaps.spec.ts — these pin what the controls actually look like,
 * which no functional assertion can speak to.
 */
test.describe('P8 — visual regression: control surfaces', () => {
  test.skip(({ browserName }) => browserName !== "chromium", 'baselines are Chromium-only by design');

  const shot = { maxDiffPixelRatio: 0.02, animations: 'disabled' as const };

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("merge options panel", async ({ page }) => {
    await page.goto("/merge-pdf");
    await addFilesAndWait(page, [FIXTURE.pdf3page, FIXTURE.pdf3page], 2);
    // The options are always open in the workspace's controls pane now.
    const options = page.getByTestId("merge-options");
    await expect(page.getByTestId("insert-blank-pages")).toBeVisible();
    await expect(options).toHaveScreenshot("merge-options.png", shot);
  });

  test("crop mode toggle", async ({ page }) => {
    await page.goto("/crop-pdf");
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    const modes = page.getByTestId("crop-mode");
    await expect(modes).toBeVisible({ timeout: 20_000 });
    // In the workspace's options pane; settle the page first, then bring the
    // section fully into the pane in one jump, so it is not caught mid-scroll.
    await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
    await modes.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await expect(modes).toHaveScreenshot("crop-mode.png", shot);
  });

  test("rearrange grid with an inserted blank page", async ({ page }) => {
    await page.goto("/rearrange-pdf-pages");
    await addSingleFileAndWait(page, FIXTURE.pdf3page);
    await expect(page.getByTestId("page-thumb")).toHaveCount(3);
    await expect(page.locator("[data-testid='page-thumb'] img").first()).toBeVisible({ timeout: 20_000 });
    await page.locator("[data-testid='insert-blank'][data-position='1']").click();
    await expect(page.locator("[data-testid='page-thumb'][data-blank='true']")).toHaveCount(1);
    await expect(page.getByTestId("page-grid")).toHaveScreenshot("rearrange-blank-page.png", shot);
  });
});
