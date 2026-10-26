import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import {
  expectSameMarks,
  fileMarks,
  openWatermark,
  screenMarks,
  watermarkAndDownload,
  type Corners,
  type Point,
} from '../helpers/watermark';

/**
 * Put the watermark anywhere: a drag (or the arrow keys, or the millimetre
 * fields) moves the single watermark's centre, and the downloaded file has it
 * exactly there — read from the content stream and mapped to the displayed
 * page by pdf.js, not from the app's own layout code. Checked on a plain page,
 * a /Rotate 90 scan and a page whose crop box does not start at 0,0, and on
 * every page "Apply to" selects of a file whose pages differ in size, shape,
 * rotation and crop.
 */

const TEXT = { text: 'CONFIDENTIAL', font: 'Helvetica-Bold' } as const;
const MM_PER_PT = 25.4 / 72;

/** Centre of a copy's four corners, as fractions of the displayed page. */
const centreOf = (c: Corners): Point => [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];

function expectNear(got: Point, want: Point, tolerance: number, what: string) {
  expect(Math.abs(got[0] - want[0]), `${what} x: got ${got[0].toFixed(4)}, want ${want[0].toFixed(4)}`).toBeLessThan(tolerance);
  expect(Math.abs(got[1] - want[1]), `${what} y: got ${got[1].toFixed(4)}, want ${want[1].toFixed(4)}`).toBeLessThan(tolerance);
}

/** Drag the watermark by its middle with the mouse so its centre lands on `to` (fractions of the page). */
async function dragWatermarkTo(page: Page, to: Point) {
  const box = (await page.getByTestId('overlay-item').boundingBox())!;
  const image = (await page.getByTestId('page-image').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const target = { x: image.x + to[0] * image.width, y: image.y + to[1] * image.height };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((target.x - from.x) * i) / 8, from.y + ((target.y - from.y) * i) / 8);
  await page.mouse.up();
}

async function shownCentre(page: Page): Promise<Point> {
  const marks = await screenMarks(page);
  expect(marks).toHaveLength(1);
  return centreOf(marks[0]);
}

async function fileCentre(bytes: Buffer, pageIndex: number): Promise<Point> {
  const marks = await fileMarks(bytes, pageIndex, TEXT);
  expect(marks, `copies on page ${pageIndex + 1}`).toHaveLength(1);
  return centreOf(marks[0].corners);
}

const FILES = [
  { name: 'plain page', file: FIXTURE.pdf1page },
  { name: '/Rotate 90 scan', file: FIXTURE.pdfRotate90 },
  { name: 'offset crop box', file: FIXTURE.pdfCropOffset },
];

for (const f of FILES) {
  test(`a dragged watermark is in the file where it was dropped — ${f.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await openWatermark(page, f.file);
    const target: Point = [0.3, 0.7];
    await dragWatermarkTo(page, target);

    // Custom now: no preset is pressed, and the way back is offered.
    await expect(page.getByTestId('wm-position-custom')).toBeVisible();
    await expect(page.locator('[data-testid^="wm-position-"][aria-pressed="true"]')).toHaveCount(0);
    const shown = await screenMarks(page);
    expectNear(centreOf(shown[0]), target, 0.01, 'centre on screen');

    const bytes = await watermarkAndDownload(page);
    const inFile = await fileMarks(bytes, 0, TEXT);
    expectSameMarks(inFile, shown);
    expectNear(centreOf(inFile[0].corners), target, 0.01, 'centre in the file');
  });
}

test('arrow keys nudge it 0.5% of the page width, Shift ten times as far, and the file follows', async ({ page }) => {
  test.setTimeout(120_000);
  await openWatermark(page, FIXTURE.pdf1page);
  const start = await shownCentre(page);
  const canvas = (await page.getByTestId('page-image').boundingBox())!;
  const item = page.getByTestId('overlay-item');
  await item.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByTestId('wm-position-announce')).toContainText('mm from the left');

  // The same distance on screen both ways: down is 5% of the width, as a share of the height.
  const want: Point = [start[0] + 2 * 0.005, start[1] + (0.05 * canvas.width) / canvas.height];
  expectNear(await shownCentre(page), want, 0.002, 'centre on screen after the nudges');
  const bytes = await watermarkAndDownload(page);
  expectNear(await fileCentre(bytes, 0), want, 0.002, 'centre in the file after the nudges');
});

test('the millimetre fields put its centre exactly there', async ({ page }) => {
  test.setTimeout(120_000);
  await openWatermark(page, FIXTURE.pdf1page);
  // A preset shows where it puts the centre: the middle of a Letter page.
  await expect(page.getByTestId('wm-centre-x')).toHaveValue(String(Math.round(306 * MM_PER_PT * 10) / 10));
  await page.getByTestId('wm-centre-x').fill('50');
  await page.getByTestId('wm-centre-y').fill('100');
  await page.getByTestId('wm-centre-y').blur();
  await expect(page.getByTestId('wm-position-custom')).toBeVisible();
  await expect(page.getByTestId('wm-centre-x')).toHaveValue('50');

  const want: Point = [50 / (612 * MM_PER_PT), 100 / (792 * MM_PER_PT)];
  expectNear(await shownCentre(page), want, 0.002, 'centre on screen');
  const bytes = await watermarkAndDownload(page);
  expectNear(await fileCentre(bytes, 0), want, 0.002, 'centre in the file');
});

test('a preset after a custom position snaps back, and so does Reset position', async ({ page }) => {
  test.setTimeout(120_000);
  await openWatermark(page, FIXTURE.pdf1page);
  await dragWatermarkTo(page, [0.25, 0.25]);
  await expect(page.getByTestId('wm-position-custom')).toBeVisible();

  await page.getByTestId('wm-position-top-center').click();
  await expect(page.getByTestId('wm-position-top-center')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('wm-position-custom')).toHaveCount(0);
  expect((await shownCentre(page))[0]).toBeCloseTo(0.5, 2);

  await dragWatermarkTo(page, [0.7, 0.6]);
  await page.getByTestId('wm-position-reset').click();
  await expect(page.getByTestId('wm-position-center')).toHaveAttribute('aria-pressed', 'true');
  expectNear(await shownCentre(page), [0.5, 0.5], 0.002, 'centre after Reset position');
  const bytes = await watermarkAndDownload(page);
  expectNear(await fileCentre(bytes, 0), [0.5, 0.5], 0.002, 'centre in the file');
});

test('tiled copies have no drag box, and say why', async ({ page }) => {
  await openWatermark(page, FIXTURE.pdf1page);
  await expect(page.getByTestId('overlay-item')).toHaveCount(1);
  await page.getByTestId('wm-placement-tiled').click();
  await expect(page.getByTestId('overlay-item')).toHaveCount(0);
  await expect(page.getByTestId('wm-tiled-note')).toHaveText(/no single watermark to drag/);
  expect((await screenMarks(page)).length).toBeGreaterThan(1);
  await page.getByTestId('wm-placement-single').click();
  await expect(page.getByTestId('overlay-item')).toHaveCount(1);
});

test('a custom position is at the same place on every page "Apply to" selects, whatever its size and rotation', async ({ page }) => {
  test.setTimeout(120_000);
  // Letter, landscape, /Rotate 90, A5 with an offset crop box.
  await openWatermark(page, FIXTURE.pdfMixedPages);
  const target: Point = [0.3, 0.35];
  await dragWatermarkTo(page, target);
  await page.getByTestId('wm-apply-range').click();
  await page.getByTestId('wm-page-range').fill('2-4');

  // Shown at that spot on each selected page…
  const shown: Corners[][] = [];
  for (const n of [2, 3, 4]) {
    await page.getByTestId('rail-page-' + n).click();
    await expect(page.getByTestId('page-indicator')).toContainText(`Page ${n} of`);
    const marks = await screenMarks(page);
    expectNear(centreOf(marks[0]), target, 0.01, `centre on screen, page ${n}`);
    shown.push(marks);
  }
  // …and in the file, there and only there.
  const bytes = await watermarkAndDownload(page);
  expect(await fileMarks(bytes, 0, TEXT)).toHaveLength(0);
  for (const [i, n] of [2, 3, 4].entries()) {
    const inFile = await fileMarks(bytes, n - 1, TEXT);
    expectSameMarks(inFile, shown[i]);
    expectNear(centreOf(inFile[0].corners), target, 0.01, `centre in the file, page ${n}`);
  }
});
