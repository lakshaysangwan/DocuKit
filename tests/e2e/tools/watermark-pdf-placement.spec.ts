import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { MARKER_COLOURS } from '../fixtures/sign-fixtures';
import { findMarkerInViewer } from '../helpers/sign';
import { uploadBuffer, readPdfContentStreams, extractPdfText } from '../helpers/harness';
import { readExtGStateAlpha } from '../helpers/edit-pdf';
import {
  expectSameMarks,
  fileMarks,
  openWatermark,
  screenMarks,
  setSlider,
  waitForOutputPage,
  watermarkAndDownload,
  type Corners,
  type Point,
} from '../helpers/watermark';

/**
 * What you see is what you get: every copy of the watermark drawn over the
 * page is, in the downloaded file, at the same four corners — to 0.5% of the
 * page — for text and image watermarks, single and tiled, turned and not, on a
 * plain page, a /Rotate 90 scan, a page whose crop box does not start at 0,0,
 * and a page whose content leaves the coordinate system changed. The screen
 * side is the drawn SVG's own transform; the file side is the content stream
 * mapped through pdf.js. On the last page the rendered output is checked too,
 * by its pixels.
 */

type Variant = {
  label: string;
  type: 'text' | 'image';
  placement: 'single' | 'tiled';
  rotation: number;
};

const VARIANTS: Variant[] = [
  { label: 'text, single, unturned', type: 'text', placement: 'single', rotation: 0 },
  { label: 'text, tiled, turned', type: 'text', placement: 'tiled', rotation: -45 },
  { label: 'image, single, turned', type: 'image', placement: 'single', rotation: 30 },
  { label: 'image, tiled, unturned', type: 'image', placement: 'tiled', rotation: 0 },
];

const FILES = [
  { name: 'plain page (page 2 of 3)', file: FIXTURE.pdf3page, pageIndex: 1 },
  { name: '/Rotate 90 scan', file: FIXTURE.pdfRotate90, pageIndex: 0 },
  { name: 'offset crop box', file: FIXTURE.pdfCropOffset, pageIndex: 0 },
  { name: 'page that leaves graphics states open', file: FIXTURE.pdfUnbalanced, pageIndex: 0 },
];

async function setUp(page: Page, v: Variant) {
  await page.getByTestId(`wm-type-${v.type}`).click();
  if (v.type === 'image' && (await page.getByTestId('wm-image-name').textContent()) === 'No image chosen') {
    await page.getByTestId('wm-image-input').setInputFiles(FIXTURE.signMarker);
    await expect(page.getByTestId('wm-image-name')).toHaveText('sign-marker.png');
    await setSlider(page, 'wm-image-size', 30);
  }
  await page.getByTestId(`wm-placement-${v.placement}`).click();
  await setSlider(page, 'wm-rotation', v.rotation);
}

async function goTo(page: Page, pageIndex: number) {
  if (pageIndex === 0) return;
  await page.getByTestId('rail-page-' + (pageIndex + 1)).click();
  await expect(page.getByTestId('page-indicator')).toContainText(`Page ${pageIndex + 1} of`);
}

for (const f of FILES) {
  test(`the file matches the screen — ${f.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await openWatermark(page, f.file);
    await goTo(page, f.pageIndex);
    for (const v of VARIANTS) {
      await setUp(page, v);
      const shown = await screenMarks(page);
      const bytes = await watermarkAndDownload(page);
      const inFile = await fileMarks(bytes, f.pageIndex, v.type === 'text' ? { text: 'CONFIDENTIAL', font: 'Helvetica-Bold' } : undefined);
      await test.step(v.label, () => expectSameMarks(inFile, shown));
      if (v.type === 'text') expect(inFile.every((m) => m.fontSize === 60)).toBe(true);
      await page.getByTestId('edit-again').click();
    }
  });
}

/** Where each quadrant of the marker should be for a marker filling these corners. */
function quadrantCentres(c: Corners): Record<keyof typeof MARKER_COLOURS, Point> {
  // Corners: bottom-left, bottom-right, top-right, top-left of the image.
  const [bl, br, tr, tl] = c;
  const at = (u: number, v: number): Point => {
    // u along the top edge (left → right), v down (top → bottom).
    const top: Point = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u];
    const bottom: Point = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u];
    return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
  };
  return { topLeft: at(0.25, 0.25), topRight: at(0.75, 0.25), bottomLeft: at(0.25, 0.75), bottomRight: at(0.75, 0.75) };
}

test('on a page that leaves its coordinates changed, the rendered output has the marker where it was shown', async ({ page }) => {
  test.setTimeout(120_000);
  await openWatermark(page, FIXTURE.pdfUnbalanced);
  await setUp(page, { label: '', type: 'image', placement: 'single', rotation: 0 });
  await setSlider(page, 'wm-opacity', 100);
  for (const rotation of [0, 30]) {
    await setSlider(page, 'wm-rotation', rotation);
    const [shown] = await screenMarks(page);
    const bytes = await watermarkAndDownload(page);
    // pdf.js forgives a page that leaves states open more than other viewers
    // do, so the pixels alone cannot prove the fix: the page leaves two states
    // open, and the watermark must start by closing both plus the `q` that
    // isolates the page's content.
    const streams = await readPdfContentStreams(bytes, 0);
    expect(streams[0].trim()).toBe('q');
    expect(streams[streams.length - 1].startsWith('Q\nQ\nQ\nq')).toBe(true);
    await waitForOutputPage(page);
    const found = await findMarkerInViewer(page);
    const want = quadrantCentres(shown);
    for (const q of Object.keys(want) as (keyof typeof want)[]) {
      expect(found[q], `${q} quadrant at ${rotation}°`).not.toBeNull();
      expect(Math.abs(found[q]![0] - want[q][0]), `${q} x at ${rotation}°`).toBeLessThan(0.01);
      expect(Math.abs(found[q]![1] - want[q][1]), `${q} y at ${rotation}°`).toBeLessThan(0.01);
    }
    await page.getByTestId('edit-again').click();
  }
});

test('"Specific pages": only those pages carry it, and the rest are badged and shown without it', async ({ page }) => {
  await openWatermark(page, FIXTURE.pdf5page);
  await page.getByTestId('wm-apply-range').click();
  await page.getByTestId('wm-page-range').fill('2, 4');
  await expect(page.getByTestId('rail-badge-1')).toHaveText('Not watermarked');
  await expect(page.getByTestId('rail-badge-2')).toHaveCount(0);
  await expect(page.getByTestId('rail-badge-3')).toHaveText('Not watermarked');
  // Page 1 is shown without the watermark, page 2 with it.
  await expect(page.getByTestId('wm-mark')).toHaveCount(0);
  await expect(page.getByTestId('watermark-page-note')).toHaveAttribute('data-watermarked', 'false');
  await page.getByTestId('rail-page-2').click();
  await expect(page.getByTestId('wm-mark')).toHaveCount(1);
  await expect(page.getByTestId('action-hint')).toHaveText('Adds the watermark to 2 pages: 2 and 4.');

  const bytes = await watermarkAndDownload(page);
  for (let i = 0; i < 5; i++) {
    const carries = (await fileMarks(bytes, i, { text: 'CONFIDENTIAL', font: 'Helvetica-Bold' })).length > 0;
    expect(carries, `page ${i + 1}`).toBe(i === 1 || i === 3);
    expect((await extractPdfText(bytes, i)).includes('CONFIDENTIAL'), `page ${i + 1} text`).toBe(i === 1 || i === 3);
  }
});

test('opacity, colour and font reach the file', async ({ page }) => {
  await openWatermark(page, FIXTURE.pdf1page);
  await setSlider(page, 'wm-opacity', 45);
  await page.locator('#wm-color').fill('#ff0000');
  await page.getByTestId('wm-font').selectOption('Times-Bold');
  await setSlider(page, 'wm-font-size', 40);
  const shown = await screenMarks(page);
  const bytes = await watermarkAndDownload(page);

  const content = (await readPdfContentStreams(bytes, 0)).join('\n');
  expect(content).toContain('1 0 0 rg');
  const gs = content.match(/\/(WmGS\S*) gs/)?.[1];
  expect(gs, 'an ExtGState is set').toBeTruthy();
  expect(await readExtGStateAlpha(bytes, gs!)).toBe(0.45);
  expect(bytes.toString('latin1')).toContain('/Times-Bold');
  const marks = await fileMarks(bytes, 0, { text: 'CONFIDENTIAL', font: 'Times-Bold' });
  expect(marks.map((m) => m.fontSize)).toEqual([40]);
  expectSameMarks(marks, shown);
});

/** A Letter page whose middle is covered by an opaque blue rectangle. */
async function filledPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 56, y: 96, width: 500, height: 600, color: rgb(0.1, 0.2, 0.8) });
  return Buffer.from(await doc.save());
}

test('layer: on top shows over a filled shape, behind is hidden under it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/watermark-pdf');
  await uploadBuffer(page, { name: 'filled.pdf', mimeType: 'application/pdf', buffer: await filledPdf() });
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  await setUp(page, { label: '', type: 'image', placement: 'single', rotation: 0 });
  await setSlider(page, 'wm-opacity', 100);

  await page.getByTestId('wm-layer-front').click();
  await watermarkAndDownload(page);
  await waitForOutputPage(page);
  const front = await findMarkerInViewer(page);
  for (const q of Object.keys(front) as (keyof typeof front)[]) expect(front[q], `on top: ${q}`).not.toBeNull();
  await page.getByTestId('edit-again').click();

  await page.getByTestId('wm-layer-behind').click();
  await expect(page.getByTestId('watermark-page-note')).toContainText('Behind content');
  const bytes = await watermarkAndDownload(page);
  await waitForOutputPage(page);
  const behind = await findMarkerInViewer(page);
  for (const q of Object.keys(behind) as (keyof typeof behind)[]) expect(behind[q], `behind: ${q}`).toBeNull();
  // It is in the file, painted first.
  const streams = await readPdfContentStreams(bytes, 0);
  expect(streams[0]).toContain(' Do');
});

test('a corner position, its distance from the edge and the tile spacing reach the file', async ({ page }) => {
  test.setTimeout(120_000);
  await openWatermark(page, FIXTURE.pdfRotate90);
  await page.getByTestId('wm-position-bottom-right').click();
  await setSlider(page, 'wm-margin', 72);
  const corner = await screenMarks(page);
  // The turned box keeps 72pt (1 in) from the right and bottom edges of the displayed page.
  const xs = corner[0].map((p) => p[0]);
  const ys = corner[0].map((p) => p[1]);
  expect(1 - Math.max(...xs)).toBeCloseTo(72 / 792, 2);
  expect(1 - Math.max(...ys)).toBeCloseTo(72 / 612, 2);
  let bytes = await watermarkAndDownload(page);
  expectSameMarks(await fileMarks(bytes, 0, { text: 'CONFIDENTIAL', font: 'Helvetica-Bold' }), corner);
  await page.getByTestId('edit-again').click();

  await page.getByTestId('wm-placement-tiled').click();
  await setSlider(page, 'wm-font-size', 24);
  await setSlider(page, 'wm-spacing', 10);
  const tight = await screenMarks(page);
  await setSlider(page, 'wm-spacing', 150);
  const loose = await screenMarks(page);
  expect(tight.length).toBeGreaterThan(loose.length);
  bytes = await watermarkAndDownload(page);
  expectSameMarks(await fileMarks(bytes, 0, { text: 'CONFIDENTIAL', font: 'Helvetica-Bold' }), loose);
});
