import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { userToView } from '../helpers/edit-pdf';
import {
  SIDES,
  colourBoxInViewer,
  cropAndDownload,
  cropBoxes,
  displayedSizes,
  goToPage,
  openCrop,
  readMargins,
  setMargins,
  setUnit,
  shownAreaFractions,
  withOptions,
  type Margins,
} from '../helpers/crop-pdf';

/**
 * Crop PDF in the workspace: any page, the visual edges, every unit.
 *
 * The proof is always in the downloaded file. For CropBox mode each page's
 * /CropBox is read and its corners mapped to the ORIGINAL displayed page by
 * pdf.js's own viewport (no app code), then compared with the margins on
 * screen as fractions of that page — to 0.5% of the page. For Flatten the
 * output page is rendered and two coloured squares are found in its pixels,
 * where the crop should have put them.
 */

/** 0.5% of the page. */
const TOL = 0.005;

async function drag(page: Page, testId: string, dx: number, dy: number) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2);
  await page.mouse.move(from.x + dx, from.y + dy);
  await page.mouse.up();
}

/** The file shows exactly the area the margins (in points, on the displayed page) leave. */
async function expectShownArea(original: Buffer, output: Buffer, pageIndex: number, marginsPt: Margins) {
  const [size] = (await displayedSizes(original)).slice(pageIndex, pageIndex + 1);
  const got = await shownAreaFractions(original, output, pageIndex);
  for (const side of SIDES) {
    const whole = side === 'top' || side === 'bottom' ? size.height : size.width;
    const want = marginsPt[side] / whole;
    expect(Math.abs(got[side] - want), `page ${pageIndex + 1} ${side}: file ${got[side].toFixed(4)}, chosen ${want.toFixed(4)}`).toBeLessThan(TOL);
  }
}

/**
 * Two marker squares, red and blue, at known places on a page that is either
 * turned (/Rotate 90) or has a crop box away from 0,0.
 */
async function markerPdf(kind: 'rotated' | 'offset'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([612, 792]);
    if (kind === 'rotated') {
      page.setRotation(degrees(90));
      page.drawRectangle({ x: 100, y: 500, width: 60, height: 60, color: rgb(1, 0, 0) });
      page.drawRectangle({ x: 400, y: 150, width: 50, height: 80, color: rgb(0, 0, 1) });
    } else {
      page.setCropBox(50, 100, 512, 642);
      page.drawRectangle({ x: 120, y: 600, width: 60, height: 60, color: rgb(1, 0, 0) });
      page.drawRectangle({ x: 400, y: 200, width: 60, height: 60, color: rgb(0, 0, 1) });
    }
  }
  return Buffer.from(await doc.save());
}

/** A marker's box on the ORIGINAL displayed page, by pdf.js. */
async function markerView(original: Buffer, rect: [number, number, number, number]) {
  const [[ax, ay], [bx, by]] = await userToView(original, 0, [
    [rect[0], rect[1]],
    [rect[0] + rect[2], rect[1] + rect[3]],
  ]);
  return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
}

test.describe('Crop PDF — which pages', () => {
  test('"Current page" crops the page shown — page 3 — and only it', async ({ page }) => {
    const original = await readFile(FIXTURE.pdf5page);
    const before = await cropBoxes(original);
    await openCrop(page, FIXTURE.pdf5page);
    await goToPage(page, 2);
    await withOptions(page, async () => {
      await page.getByTestId('apply-to-current').click();
      await expect(page.getByTestId('crop-targets')).toHaveText('Crops page 3, the page shown.');
    });
    await setUnit(page, 'pt');
    await setMargins(page, { top: 50, left: 20 });
    await expect(page.getByTestId('crop-size-readout')).toContainText('Page 3 after crop:');
    // The other pages are marked in the rail.
    for (const n of [1, 2, 4, 5]) await expect(page.getByTestId(`rail-badge-${n}`)).toHaveText('Not cropped');
    await expect(page.getByTestId('rail-badge-3')).toHaveCount(0);

    const bytes = await cropAndDownload(page);
    const after = await cropBoxes(bytes);
    expect(after).toHaveLength(5);
    for (const i of [0, 1, 3, 4]) expect(after[i], `page ${i + 1} untouched`).toEqual(before[i]);
    expect(after[2]).not.toEqual(before[2]);
    await expectShownArea(original, bytes, 2, { top: 50, right: 0, bottom: 0, left: 20 });
  });

  test('a page range crops just those pages; the rest are marked and left alone', async ({ page }) => {
    const original = await readFile(FIXTURE.pdf5page);
    const before = await cropBoxes(original);
    await openCrop(page, FIXTURE.pdf5page);
    await withOptions(page, async () => {
      await page.getByTestId('apply-to-range').click();
      await page.getByLabel('Page range to crop').fill('2-3, 5');
      await expect(page.getByTestId('crop-targets')).toContainText('Crops 3 pages of 5');
    });
    await setUnit(page, 'pt');
    await setMargins(page, { right: 30, bottom: 45 });
    for (const n of [1, 4]) await expect(page.getByTestId(`rail-badge-${n}`)).toHaveText('Not cropped');
    for (const n of [2, 3, 5]) await expect(page.getByTestId(`rail-badge-${n}`)).toHaveCount(0);
    // The page shown (1) is not in the range: no box on it, and it says so.
    await expect(page.getByTestId('crop-size-readout')).toHaveText('Page 1 is not cropped: it is outside the pages chosen.');
    await expect(page.getByTestId('overlay-item')).toHaveCount(0);

    const bytes = await cropAndDownload(page);
    const after = await cropBoxes(bytes);
    for (const i of [0, 3]) expect(after[i], `page ${i + 1} untouched`).toEqual(before[i]);
    for (const i of [1, 2, 4]) await expectShownArea(original, bytes, i, { top: 0, right: 30, bottom: 45, left: 0 });
  });
});

for (const kind of ['rotated', 'offset'] as const) {
  const fixture = kind === 'rotated' ? FIXTURE.pdfRotate90 : FIXTURE.pdfCropOffset;
  const label = kind === 'rotated' ? 'a /Rotate 90 scan' : 'an offset crop box';

  test.describe(`Crop PDF — ${label}`, () => {
    test('typed margins crop the visual edges, in the file', async ({ page }) => {
      const original = await readFile(fixture);
      await openCrop(page, fixture);
      await setUnit(page, 'pt');
      const m = { top: 40, right: 60, bottom: 50, left: 30 };
      await setMargins(page, m);
      const bytes = await cropAndDownload(page);
      await expectShownArea(original, bytes, 0, m);
      // After the run the stage shows the real output: the cropped page's shape.
      const [out] = await displayedSizes(bytes);
      const [orig] = await displayedSizes(original);
      expect(Math.abs(out.width - (orig.width - 90))).toBeLessThan(0.01);
      expect(Math.abs(out.height - (orig.height - 90))).toBeLessThan(0.01);
      await expect(page.getByTestId('output-caption')).toHaveText('Cropped — this is your file');
    });

    test('handles dragged on screen crop exactly that area, in the file', async ({ page }) => {
      const original = await readFile(fixture);
      const [size] = await displayedSizes(original);
      await openCrop(page, fixture);
      await setUnit(page, 'pt');
      const shownPage = (await page.getByTestId('crop-preview').boundingBox())!;
      const ptPerPx = size.width / shownPage.width;

      await drag(page, 'overlay-handle-top', 0, 40);
      await drag(page, 'overlay-handle-left', 30, 0);
      await drag(page, 'overlay-handle-bottom-right', -50, -25);
      const m = await readMargins(page);
      expect(Math.abs(m.top - 40 * ptPerPx), `top ${m.top}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.left - 30 * ptPerPx), `left ${m.left}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.right - 50 * ptPerPx), `right ${m.right}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.bottom - 25 * ptPerPx), `bottom ${m.bottom}`).toBeLessThanOrEqual(1);

      // The box on screen is where the fields say, on the page as shown.
      const box = (await page.getByTestId('overlay-item').boundingBox())!;
      expect(Math.abs((box.x - shownPage.x) / shownPage.width - m.left / size.width)).toBeLessThan(TOL);
      expect(Math.abs((box.y - shownPage.y) / shownPage.height - m.top / size.height)).toBeLessThan(TOL);

      const bytes = await cropAndDownload(page);
      for (let i = 0; i < (await displayedSizes(original)).length; i++) await expectShownArea(original, bytes, i, m);
    });

    test('Flatten keeps exactly the visual area chosen — found by its pixels', async ({ page }) => {
      test.setTimeout(120_000);
      const original = await markerPdf(kind);
      const [size] = await displayedSizes(original);
      const m = kind === 'rotated' ? { top: 60, right: 90, bottom: 40, left: 120 } : { top: 40, right: 60, bottom: 50, left: 30 };
      const red = await markerView(original, kind === 'rotated' ? [100, 500, 60, 60] : [120, 600, 60, 60]);
      const blue = await markerView(original, kind === 'rotated' ? [400, 150, 50, 80] : [400, 200, 60, 60]);

      await openCrop(page, { name: `${kind}-markers.pdf`, buffer: original });
      await setUnit(page, 'pt');
      await setMargins(page, m);
      await withOptions(page, () => page.getByTestId('crop-mode-flatten').click());
      const bytes = await cropAndDownload(page, 120_000);

      // The flattened page is upright and the size of the area kept.
      const [out] = await displayedSizes(bytes);
      expect(Math.abs(out.width / (size.width - m.left - m.right) - 1)).toBeLessThan(TOL);
      expect(Math.abs(out.height / (size.height - m.top - m.bottom) - 1)).toBeLessThan(TOL);

      // Each marker is where the crop puts it on the output page.
      const keepW = 1 - (m.left + m.right) / size.width;
      const keepH = 1 - (m.top + m.bottom) / size.height;
      const expected = (r: typeof red) => ({
        x1: (r.x1 - m.left / size.width) / keepW,
        x2: (r.x2 - m.left / size.width) / keepW,
        y1: (r.y1 - m.top / size.height) / keepH,
        y2: (r.y2 - m.top / size.height) / keepH,
      });
      await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
      for (const [name, marker] of [['red', red], ['blue', blue]] as const) {
        const found = await colourBoxInViewer(page, name);
        expect(found, `${name} square in the flattened page`).not.toBeNull();
        const want = expected(marker);
        for (const k of ['x1', 'x2', 'y1', 'y2'] as const) {
          expect(Math.abs(found![k] - want[k]), `${name} ${k}: found ${found![k].toFixed(4)}, want ${want[k].toFixed(4)}`).toBeLessThan(TOL + 0.003);
        }
      }
    });
  });
}

test.describe('Crop PDF — units', () => {
  test('inches round-trip exactly, and the file gets exactly that many points', async ({ page }) => {
    const original = await readFile(FIXTURE.pdf3page);
    const before = await cropBoxes(original);
    await openCrop(page, FIXTURE.pdf3page);
    await setUnit(page, 'in');
    await setMargins(page, { top: 0.5, left: 1.25, right: 0.75, bottom: 1 });
    await expect(page.getByTestId('crop-size-readout')).toContainText(' in');

    const shows = async (want: Margins) => expect(await readMargins(page)).toEqual(want);
    await setUnit(page, 'pt');
    await shows({ top: 36, right: 54, bottom: 72, left: 90 });
    await setUnit(page, 'mm');
    await shows({ top: 12.7, right: 19.05, bottom: 25.4, left: 31.75 });
    await setUnit(page, 'in');
    await shows({ top: 0.5, right: 0.75, bottom: 1, left: 1.25 });

    const bytes = await cropAndDownload(page);
    const after = await cropBoxes(bytes);
    for (let i = 0; i < 3; i++) {
      const [x, y, w, h] = after[i];
      const [x0, y0, w0, h0] = before[i];
      expect(x - x0).toBeCloseTo(90, 6);
      expect(y - y0).toBeCloseTo(72, 6);
      expect(w).toBeCloseTo(w0 - 90 - 54, 6);
      expect(h).toBeCloseTo(h0 - 36 - 72, 6);
    }
  });
});

test.describe('Crop PDF — Auto-crop on the page shown', () => {
  test('trims the white border around the shown page’s own content', async ({ page }) => {
    // Two pages with their content in different places; page 2 is the one shown.
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([600, 800]);
    p1.drawRectangle({ x: 50, y: 600, width: 100, height: 100, color: rgb(0, 0, 0) });
    const p2 = doc.addPage([600, 800]);
    p2.drawRectangle({ x: 300, y: 100, width: 200, height: 300, color: rgb(0, 0, 0) });
    const original = Buffer.from(await doc.save());

    await openCrop(page, { name: 'two-blocks.pdf', buffer: original });
    await goToPage(page, 1);
    await setUnit(page, 'pt');
    await withOptions(page, async () => {
      await page.getByTestId('apply-to-current').click();
      await page.getByTestId('crop-autocrop').click();
      await expect(page.getByTestId('crop-auto-note')).toHaveText("Set to the white border around page 2's content.");
    });
    // Page 2's block: 300pt from the left, 100 from the right, 400 from the top, 100 from the bottom
    // — less a few pixels of padding.
    const m = await readMargins(page);
    const want = { left: 300, right: 100, top: 400, bottom: 100 };
    for (const side of SIDES) {
      expect(m[side], `${side}`).toBeLessThanOrEqual(want[side]);
      expect(m[side], `${side}`).toBeGreaterThan(want[side] - 8);
    }
    const bytes = await cropAndDownload(page);
    await expectShownArea(original, bytes, 1, m);
    expect((await cropBoxes(bytes))[0]).toEqual([0, 0, 600, 800]);
  });
});

test.describe('Crop PDF — the whole box by touch', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'touch emulation needs Chromium');
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 851 } });

  test('a finger inside the box slides it; outside it the page is left to scroll', async ({ page }) => {
    const original = await readFile(FIXTURE.pdf3page);
    const [size] = await displayedSizes(original);
    await openCrop(page, FIXTURE.pdf3page);
    await setUnit(page, 'pt');
    await setMargins(page, { top: 150, right: 150, bottom: 150, left: 150 });

    // Inside the box a touch belongs to the box; the dimmed page and the pane do not hold it.
    expect(await page.getByTestId('crop-move').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    for (const id of ['crop-preview', 'overlay-item', 'page-viewer']) {
      expect(await page.getByTestId(id).evaluate((el) => getComputedStyle(el).touchAction), id).toBe('auto');
    }

    const shownPage = (await page.getByTestId('crop-preview').boundingBox())!;
    const inside = (await page.getByTestId('crop-move').boundingBox())!;
    const from = { x: inside.x + inside.width / 2, y: inside.y + inside.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type: type as 'touchStart',
        touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
      });
    await touch('touchStart', from.x, from.y);
    await touch('touchMove', from.x + 10, from.y + 15);
    await touch('touchMove', from.x + 20, from.y + 30);
    await touch('touchEnd', 0, 0);

    const m = await readMargins(page);
    const ptPerPx = size.width / shownPage.width;
    expect(Math.abs(m.left - (150 + 20 * ptPerPx)), `left ${m.left}`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.top - (150 + 30 * ptPerPx)), `top ${m.top}`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.left + m.right - 300), 'width kept').toBeLessThanOrEqual(0.02);
    expect(Math.abs(m.top + m.bottom - 300), 'height kept').toBeLessThanOrEqual(0.02);

    await cdp.detach();
    // The press is not what is tested here; a click avoids a second synthetic touch sequence.
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
    const { expectDownload } = await import('../helpers/harness');
    const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
    await expectShownArea(original, bytes, 0, m);
  });
});

test.describe('Crop PDF — the action stays put', () => {
  test('after a reload the Crop PDF button does not move while the page draws', async ({ page }) => {
    await openCrop(page, FIXTURE.pdf3page);
    await page.reload();
    await openCrop(page, FIXTURE.pdf5page);
    const action = page.getByTestId('tool-action');
    const first = (await action.boundingBox())!;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(150);
      const now = (await action.boundingBox())!;
      expect(Math.abs(now.y - first.y), 'vertical shift').toBeLessThan(1);
      expect(Math.abs(now.x - first.x), 'horizontal shift').toBeLessThan(1);
    }
  });
});
