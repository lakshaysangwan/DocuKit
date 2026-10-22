import { test, expect } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, expectDownload } from '../helpers/harness';
import {
  openOrganize,
  card,
  gridDetails,
  dragPage,
  saveAndDownload,
  filePageOrder,
  fileRotations,
  fileShapes,
} from '../helpers/organize-pages';

/**
 * Rearrange / Rotate PDF Pages in the shared workspace. Every test changes the
 * pages the way a visitor would and then reads the DOWNLOADED file: the order
 * of its pages (by the text printed on each), their /Rotate and their count.
 */

const button = (page: import('@playwright/test').Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('Rearrange PDF Pages — the workspace', () => {
  test('each card has rotate, duplicate, delete, reorder and enlarge, visible without hovering', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await openOrganize(page, FIXTURE.pdf3page, 3);
    // The pointer is nowhere near the grid.
    await page.mouse.move(2, 2);
    for (let i = 1; i <= 3; i++) {
      for (const name of [`Rotate page ${i} left`, `Rotate page ${i} right`, `Duplicate page ${i}`, `Delete page ${i}`, `Reorder page ${i}`]) {
        const b = button(page, name);
        await expect(b, name).toBeVisible();
        expect(await b.evaluate((el) => getComputedStyle(el).opacity), name).toBe('1');
      }
    }
    await expect(page.getByTestId('step-prompt')).toHaveText(
      'Drag pages to reorder, or use the buttons on each page to rotate, duplicate or delete it.',
    );
    await expect(page.getByTestId('tool-action')).toHaveText('Save PDF (3 pages)');
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('per-card buttons by mouse: rotate both ways, duplicate, delete — the file follows', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf5page, 5);
    await button(page, 'Rotate page 1 right').click();
    await button(page, 'Rotate page 2 left').click();
    await button(page, 'Duplicate page 3').click();
    await expect(page.getByTestId('organize-page')).toHaveCount(6);
    // The copy turns on its own.
    await button(page, 'Rotate page 4 right').click();
    await button(page, 'Rotate page 4 right').click();
    await button(page, 'Delete page 6').click();
    await expect(page.getByTestId('organize-page')).toHaveCount(5);
    await expect(page.getByTestId('tool-action')).toHaveText('Save PDF (5 pages)');
    expect(await gridDetails(page)).toEqual([
      'Original page 1 · turned right',
      'Original page 2 · turned left',
      'Original page 3',
      'Original page 3 · upside down',
      'Original page 4',
    ]);
    // The thumbnail is turned, not just labelled.
    await expect(card(page, 0).locator('[data-turn]')).toHaveAttribute('data-turn', '90');

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '2', '3', '3', '4']);
    expect(await fileRotations(bytes)).toEqual([90, 270, 0, 180, 0]);
  });

  test('per-card buttons by keyboard', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    await button(page, 'Rotate page 2 right').focus();
    await page.keyboard.press('Enter');
    await button(page, 'Duplicate page 1').focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('organize-page')).toHaveCount(4);
    await button(page, 'Delete page 4').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('organize-page')).toHaveCount(3);

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '1', '2']);
    expect(await fileRotations(bytes)).toEqual([0, 0, 90]);
  });

  test('reorder by dragging a page', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf5page, 5);
    await dragPage(page, 0, 3);
    await expect.poll(() => gridDetails(page)).toEqual([
      'Original page 2',
      'Original page 3',
      'Original page 4',
      'Original page 1',
      'Original page 5',
    ]);
    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['2', '3', '4', '1', '5']);
  });

  test('reorder with the keyboard on a card’s handle', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    const handle = button(page, 'Reorder page 3');
    await handle.focus();
    await expect(handle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(card(page, 2)).toHaveAttribute('data-dragging', 'true');
    // dnd-kit measures a frame after pick-up and drops an arrow pressed before
    // that, so the move is repeated until it is announced.
    await expect(async () => {
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByText(/page 3 moved to position 2 of 3/)).toBeAttached({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.keyboard.press('Space');
    await expect(page.getByText(/page 3 dropped at position 2 of 3/)).toBeAttached();
    await expect.poll(() => gridDetails(page)).toEqual(['Original page 1', 'Original page 3', 'Original page 2']);
    await page.waitForTimeout(100);

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '3', '2']);
  });

  test('selection by click, Shift-click and keyboard; Rotate selected, Delete selected, Rotate all', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf5page, 5);
    const summary = page.getByTestId('selection-summary');

    await page.getByTestId('page-select-1').click();
    await page.getByTestId('page-select-3').click({ modifiers: ['Shift'] });
    await expect(summary).toHaveText('3 of 5 pages selected.');
    await expect(page.getByTestId('page-select-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('step-prompt')).toContainText('3 pages selected');

    // Keyboard: Space on a page's toggle takes it out of the selection.
    await page.getByTestId('page-select-3').focus();
    await page.keyboard.press('Space');
    await expect(summary).toHaveText('2 of 5 pages selected.');

    await page.getByTestId('rotate-selected-right').click();
    await expect.poll(() => gridDetails(page)).toEqual([
      'Original page 1',
      'Original page 2 · turned right',
      'Original page 3 · turned right',
      'Original page 4',
      'Original page 5',
    ]);
    await page.getByTestId('rotate-all-left').click();

    // Delete selected: pages 2 and 3 go.
    await page.getByTestId('delete-selected').click();
    await expect(page.getByTestId('organize-page')).toHaveCount(3);
    await expect(summary).toContainText('None selected');

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '4', '5']);
    expect(await fileRotations(bytes)).toEqual([270, 270, 270]);
  });

  test('a blank page goes after the last selected page and takes its shape', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    const insert = page.getByTestId('insert-blank');
    await expect(insert).toHaveText('Add a blank page at the end');
    await page.getByTestId('page-select-0').click();
    await expect(insert).toHaveText('Add a blank page after page 1');
    await expect(insert).toHaveAttribute('data-position', '1');
    await insert.click();
    await expect(page.getByTestId('organize-page')).toHaveCount(4);
    await expect(card(page, 1).getByTestId('blank-page')).toBeVisible();
    expect((await gridDetails(page))[1]).toBe('Blank page');

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '', '2', '3']);
    const shapes = await fileShapes(bytes);
    expect(shapes[1]).toBe(shapes[0]);
  });

  test('undo and redo, by button and by Ctrl+Z; Reset puts everything back', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    const undo = page.getByTestId('undo');
    const redo = page.getByTestId('redo');
    await expect(undo).toBeVisible();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await expect(page.getByTestId('organize-reset')).toBeDisabled();

    await button(page, 'Delete page 1').click();
    await button(page, 'Rotate page 1 right').click();
    await expect(page.getByTestId('organize-page')).toHaveCount(2);
    await undo.click();
    expect(await gridDetails(page)).toEqual(['Original page 2', 'Original page 3']);
    await undo.click();
    await expect(page.getByTestId('organize-page')).toHaveCount(3);
    await redo.click();
    await expect(page.getByTestId('organize-page')).toHaveCount(2);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('organize-page')).toHaveCount(3);
    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('organize-page')).toHaveCount(2);

    await page.getByTestId('organize-reset').click();
    expect(await gridDetails(page)).toEqual(['Original page 1', 'Original page 2', 'Original page 3']);
    await undo.click();
    await expect(page.getByTestId('organize-page')).toHaveCount(2);

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['2', '3']);
  });

  test('a page opens large, pages through with Previous / Next, and shows the turn', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    await button(page, 'Rotate page 2 right').click();
    await card(page, 0).getByTestId('page-open').click();
    const dialog = page.getByTestId('page-preview-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('page-preview-title')).toContainText('Page 1 of 3');
    await page.getByTestId('page-preview-next').click();
    await expect(page.getByTestId('page-preview-title')).toContainText('Page 2 of 3');
    await expect(dialog.locator('[data-turn]')).toHaveAttribute('data-turn', '90');
    await expect(dialog.getByTestId('organize-page-image')).toBeVisible();
    await page.getByTestId('page-preview-prev').click();
    await expect(page.getByTestId('page-preview-title')).toContainText('Page 1 of 3');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 0).getByTestId('page-open')).toBeFocused();
  });

  test('on a page that is already /Rotate 90, rotating right gives 180', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdfRotate90, 2);
    await button(page, 'Rotate page 1 right').click();
    await button(page, 'Rotate page 2 left').click();
    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['R1', 'R2']);
    expect(await fileRotations(bytes)).toEqual([180, 0]);
  });

  test('after saving the grid is the saved file; any change goes back to Save', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    await button(page, 'Delete page 2').click();
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    // Read back from the output: two pages.
    await expect(page.getByTestId('organize-output-page')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('organize-output-image')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('result-summary')).toContainText('2 pages');
    await expect(page.getByTestId('step-prompt')).toContainText('Done');

    // Ctrl+Z is a change: the result is dropped and the editing grid is back.
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('download-button')).toHaveCount(0);
    await expect(page.getByTestId('tool-action')).toHaveText('Save PDF (3 pages)');
    await expect(page.getByTestId('organize-page')).toHaveCount(3);

    const bytes = await saveAndDownload(page);
    expect(await filePageOrder(bytes)).toEqual(['1', '2', '3']);
  });
});

test.describe('Rearrange PDF Pages — by touch', () => {
  // Touch is emulated through the DevTools protocol, which only Chromium speaks.
  test.skip(({ browserName }) => browserName !== 'chromium', 'touch emulation needs Chromium');
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 851 } });

  test('every card button is at least 44px, and taps alone rotate, duplicate and delete', async ({ page }) => {
    await openOrganize(page, FIXTURE.pdf3page, 3);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'emulated as a touch device').toBe(true);
    for (const id of ['page-rotate-left', 'page-rotate-right', 'page-duplicate', 'file-remove', 'page-reorder', 'page-open']) {
      const box = (await card(page, 0).getByTestId(id).boundingBox())!;
      expect(Math.min(box.width, box.height), `${id} touch target`).toBeGreaterThanOrEqual(44);
    }

    await button(page, 'Rotate page 1 right').tap();
    await button(page, 'Rotate page 2 left').tap();
    await button(page, 'Duplicate page 2').tap();
    await expect(page.getByTestId('organize-page')).toHaveCount(4);
    await button(page, 'Delete page 4').tap();
    await expect(page.getByTestId('organize-page')).toHaveCount(3);
    // A tap on a page selects it.
    await page.getByTestId('page-select-0').tap();
    await expect(page.getByTestId('page-select-0')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('tool-action').tap();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').tap());
    expect(await filePageOrder(bytes)).toEqual(['1', '2', '2']);
    expect(await fileRotations(bytes)).toEqual([90, 270, 270]);
  });
});
