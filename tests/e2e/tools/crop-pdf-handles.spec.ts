import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait, expectDownload, assertPdf } from '../helpers/harness';

/**
 * The crop box on the Crop PDF preview: what can be dragged, what the pointer
 * says about it, and that what is dragged on screen is what ends up in the file.
 *
 * Everything is measured, not eyeballed — the cursor is the computed style of
 * the element under a point, the margins are read back from the fields, and the
 * crop is read back from the downloaded PDF.
 */

const HANDLES = [
  { id: 'top-left', name: 'Top-left corner', cursor: 'nwse-resize' },
  { id: 'top', name: 'Top edge', cursor: 'ns-resize' },
  { id: 'top-right', name: 'Top-right corner', cursor: 'nesw-resize' },
  { id: 'right', name: 'Right edge', cursor: 'ew-resize' },
  { id: 'bottom-right', name: 'Bottom-right corner', cursor: 'nwse-resize' },
  { id: 'bottom', name: 'Bottom edge', cursor: 'ns-resize' },
  { id: 'bottom-left', name: 'Bottom-left corner', cursor: 'nesw-resize' },
  { id: 'left', name: 'Left edge', cursor: 'ew-resize' },
] as const;

type Side = 'top' | 'right' | 'bottom' | 'left';

/** Size of page 1 of the fixture in points, read from the file itself. */
async function fixturePageSize(): Promise<{ width: number; height: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(await readFile(FIXTURE.pdf3page));
  return doc.getPage(0).getSize();
}

/** Load the fixture and bring the whole preview on screen, clear of the sticky header. */
async function openCrop(page: Page, unit: 'mm' | 'pt' = 'pt') {
  await page.goto('/crop-pdf');
  await addSingleFileAndWait(page, FIXTURE.pdf3page);
  if (unit === 'pt') await page.getByRole('button', { name: 'pt', exact: true }).click();
  const preview = page.getByTestId('crop-preview');
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('overlay-handle-top')).toBeVisible();
  await centrePreview(page);
}

/**
 * Put the whole preview on screen. The site scrolls smoothly, so jump instead and
 * the boxes read next are final. Call again after typing in a margin field:
 * filling a field scrolls it into view and moves the preview.
 */
async function centrePreview(page: Page) {
  await page.getByTestId('crop-preview').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
}

const field = (page: Page, side: Side) => page.locator(`#crop-margin-${side}`);

async function margins(page: Page): Promise<Record<Side, number>> {
  const read = async (side: Side) => Number(await field(page, side).inputValue());
  return { top: await read('top'), right: await read('right'), bottom: await read('bottom'), left: await read('left') };
}

/** The displayed page, in viewport pixels. */
async function pageBox(page: Page) {
  const box = await page.getByTestId('crop-preview').boundingBox();
  if (!box) throw new Error('crop preview has no box');
  return box;
}

async function centre(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The cursor a visitor sees at a point: the computed style of the topmost element there. */
const cursorAt = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? getComputedStyle(el).cursor : 'nothing-there';
  }, [x, y]);

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2);
  await page.mouse.move(from.x + dx, from.y + dy);
  await page.mouse.up();
}

/** No resize or move cursor: the browser's ordinary pointer. */
const PLAIN = ['auto', 'default'];

test.describe('Crop PDF — crop box handles', () => {
  test('the pointer changes only over what can be dragged', async ({ page }) => {
    await openCrop(page);
    const box = await pageBox(page);
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Nothing cropped yet: the box is the whole page and cannot go anywhere.
    expect(PLAIN, 'page body with nothing cropped').toContain(await cursorAt(page, mid.x, mid.y));
    expect(PLAIN, 'tray around the page').toContain(await cursorAt(page, box.x + box.width / 4, box.y - 12));

    for (const h of HANDLES) {
      const c = await centre(page, `overlay-handle-${h.id}`);
      expect(await cursorAt(page, c.x, c.y), `${h.name} handle`).toBe(h.cursor);
    }

    // The edges between the handles are grab zones too.
    expect(await cursorAt(page, box.x + box.width / 4, box.y), 'top edge').toBe('ns-resize');
    expect(await cursorAt(page, box.x + box.width / 4, box.y + box.height - 1), 'bottom edge').toBe('ns-resize');
    expect(await cursorAt(page, box.x, box.y + box.height / 4), 'left edge').toBe('ew-resize');
    expect(await cursorAt(page, box.x + box.width - 1, box.y + box.height / 4), 'right edge').toBe('ew-resize');

    // Crop 100pt off every side: the page outside the box stays plain, the
    // inside of the box can now be slid around.
    for (const side of ['top', 'right', 'bottom', 'left'] as const) await field(page, side).fill('100');
    await centrePreview(page);
    const after = await pageBox(page);
    expect(PLAIN, 'dimmed page outside the box').toContain(await cursorAt(page, after.x + 20, after.y + 20));
    expect(PLAIN, 'dimmed page outside the box').toContain(
      await cursorAt(page, after.x + after.width - 20, after.y + after.height - 20),
    );
    expect(await cursorAt(page, after.x + after.width / 2, after.y + after.height / 2), 'inside the box').toBe('move');
  });

  test('every handle has a name, a visible shape and a hit area of at least 24px', async ({ page }) => {
    await openCrop(page);
    for (const h of HANDLES) {
      const handle = page.getByRole('button', { name: h.name, exact: true });
      await expect(handle, h.name).toHaveAttribute('data-testid', `overlay-handle-${h.id}`);
      const hit = await handle.boundingBox();
      expect(hit!.width, `${h.name} hit width`).toBeGreaterThanOrEqual(24);
      expect(hit!.height, `${h.name} hit height`).toBeGreaterThanOrEqual(24);
      const shape = await handle.locator('span').evaluate((el: HTMLElement) => {
        const s = getComputedStyle(el);
        return { w: el.offsetWidth, h: el.offsetHeight, bg: s.backgroundColor, border: s.borderTopWidth };
      });
      expect(shape.w, `${h.name} shape`).toBeGreaterThanOrEqual(12);
      expect(shape.h, `${h.name} shape`).toBeGreaterThanOrEqual(12);
      expect(shape.bg, `${h.name} is filled`).not.toBe('rgba(0, 0, 0, 0)');
      expect(shape.border, `${h.name} has a border`).toBe('2px');
    }
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const strip = await page.getByTestId(`crop-edge-${side}`).boundingBox();
      expect(Math.min(strip!.width, strip!.height), `${side} edge grab zone`).toBeGreaterThanOrEqual(12);
    }
    await expect(page.getByTestId('crop-hint')).toContainText('Drag the handles to crop');

    // The site-wide axe pass sees this page before a file is added, so the
    // handles are audited here, where they exist.
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => v.id + ': ' + v.nodes[0]?.target.join(' ')), 'axe violations with the preview open').toEqual([]);
  });

  test('dragging an edge and a corner sets the margins, and the file is cropped to match', async ({ page }) => {
    const size = await fixturePageSize();
    await openCrop(page);
    const box = await pageBox(page);
    const ptPerPxX = size.width / box.width;
    const ptPerPxY = size.height / box.height;

    // Top edge handle, 60px down.
    await drag(page, await centre(page, 'overlay-handle-top'), 0, 60);
    let m = await margins(page);
    expect(Math.abs(m.top - 60 * ptPerPxY), `top margin ${m.top}`).toBeLessThanOrEqual(1);
    expect([m.right, m.bottom, m.left], 'an edge handle moves one edge').toEqual([0, 0, 0]);
    const top = m.top;

    // Bottom-right corner, 40px left and 50px up: two edges at once.
    await drag(page, await centre(page, 'overlay-handle-bottom-right'), -40, -50);
    m = await margins(page);
    expect(Math.abs(m.right - 40 * ptPerPxX), `right margin ${m.right}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.bottom - 50 * ptPerPxY), `bottom margin ${m.bottom}`).toBeLessThanOrEqual(1);
    expect([m.top, m.left], 'the other two edges stay put').toEqual([top, 0]);

    // The left edge itself, away from any handle, 30px right.
    const current = await page.getByTestId('overlay-item').boundingBox();
    await drag(page, { x: current!.x, y: current!.y + current!.height / 4 }, 30, 0);
    m = await margins(page);
    expect(Math.abs(m.left - 30 * ptPerPxX), `left margin ${m.left}`).toBeLessThanOrEqual(1);

    const width = Math.round(size.width - m.left - m.right);
    const height = Math.round(size.height - m.top - m.bottom);
    await expect(page.getByTestId('crop-size-readout')).toHaveText(`Page 1 after crop: ${width} × ${height} pt`);

    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    assertPdf(bytes);

    // The proof is in the file: every page carries the box that was dragged.
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(out.getPageCount()).toBe(3);
    for (const p of out.getPages()) {
      const crop = p.getCropBox();
      expect(crop.x, 'crop box left').toBeCloseTo(m.left, 2);
      expect(crop.y, 'crop box bottom').toBeCloseTo(m.bottom, 2);
      expect(crop.width, 'crop box width').toBeCloseTo(size.width - m.left - m.right, 2);
      expect(crop.height, 'crop box height').toBeCloseTo(size.height - m.top - m.bottom, 2);
    }
  });

  test('dragging inside the box slides it without resizing', async ({ page }) => {
    const size = await fixturePageSize();
    await openCrop(page);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) await field(page, side).fill('80');
    await centrePreview(page);
    const box = await pageBox(page);

    await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 20, 30);
    const m = await margins(page);
    expect(Math.abs(m.left - (80 + (20 * size.width) / box.width)), `left margin ${m.left}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.top - (80 + (30 * size.height) / box.height)), `top margin ${m.top}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.left + m.right - 160), 'width kept').toBeLessThanOrEqual(1);
    expect(Math.abs(m.top + m.bottom - 160), 'height kept').toBeLessThanOrEqual(1);

    // It stops at the page edge instead of pushing the box off it.
    await drag(page, await centre(page, 'crop-move'), -2000, -2000);
    const pinned = await margins(page);
    expect([pinned.left, pinned.top]).toEqual([0, 0]);
    expect(Math.abs(pinned.right - 160), 'width kept at the edge').toBeLessThanOrEqual(1);
    expect(Math.abs(pinned.bottom - 160), 'height kept at the edge').toBeLessThanOrEqual(1);
  });

  test('arrow keys nudge a focused handle; Shift takes a larger step', async ({ page }) => {
    await openCrop(page, 'mm');

    const top = page.getByRole('button', { name: 'Top edge', exact: true });
    await top.focus();
    await expect(top).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(field(page, 'top')).toHaveValue('1');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(field(page, 'top')).toHaveValue('11');
    await page.keyboard.press('ArrowUp');
    await expect(field(page, 'top')).toHaveValue('10');
    // A top edge has nowhere to go sideways.
    await page.keyboard.press('ArrowRight');
    expect(await margins(page)).toEqual({ top: 10, right: 0, bottom: 0, left: 0 });

    // A corner answers to both directions.
    await page.getByRole('button', { name: 'Bottom-right corner', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    expect(await margins(page)).toEqual({ top: 10, right: 1, bottom: 10, left: 0 });

    // The fields drive the box as before, and the step follows the unit.
    await page.getByRole('button', { name: 'pt', exact: true }).click();
    await field(page, 'left').fill('20');
    await page.getByRole('button', { name: 'Left edge', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(field(page, 'left')).toHaveValue('21');
    const box = await pageBox(page);
    const crop = await page.getByTestId('overlay-item').boundingBox();
    const size = await fixturePageSize();
    expect(Math.abs(crop!.x - box.x - (21 * box.width) / size.width), 'box follows the field').toBeLessThanOrEqual(1);
  });
});

test.describe('Crop PDF — crop box handles on touch', () => {
  // Touch is emulated through the DevTools protocol, which only Chromium speaks.
  test.skip(({ browserName }) => browserName !== 'chromium', 'touch emulation needs Chromium');
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 851 } });

  test('a finger can drag a handle, and the page still scrolls from anywhere else', async ({ page }) => {
    const size = await fixturePageSize();
    await openCrop(page);

    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'emulated as a touch device').toBe(true);
    for (const h of HANDLES) {
      const handle = page.getByTestId(`overlay-handle-${h.id}`);
      const hit = await handle.boundingBox();
      expect(Math.min(hit!.width, hit!.height), `${h.name} touch target`).toBeGreaterThanOrEqual(44);
      expect(await handle.evaluate((el) => getComputedStyle(el).touchAction), h.name).toBe('none');
    }
    // Only the handles and edges hold on to a touch.
    for (const id of ['crop-preview', 'crop-move', 'overlay-item']) {
      expect(await page.getByTestId(id).evaluate((el) => getComputedStyle(el).touchAction), id).toBe('auto');
    }

    const box = await pageBox(page);
    const from = await centre(page, 'overlay-handle-top-left');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type: type as 'touchStart',
        touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
      });
    await touch('touchStart', from.x, from.y);
    await touch('touchMove', from.x + 20, from.y + 30);
    await touch('touchMove', from.x + 40, from.y + 60);
    await touch('touchEnd', 0, 0);

    const m = await margins(page);
    expect(Math.abs(m.left - (40 * size.width) / box.width), `left margin ${m.left}`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.top - (60 * size.height) / box.height), `top margin ${m.top}`).toBeLessThanOrEqual(2);
    expect([m.right, m.bottom]).toEqual([0, 0]);
  });
});
