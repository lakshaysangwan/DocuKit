import { type Locator, type Page, expect } from '@playwright/test';
import { uploadBuffer, uploadFiles, expectDownload } from './harness';

/**
 * Helpers for Redact PDF's workspace. Every check that matters reads the
 * DOWNLOADED file — its text with pdf.js, its pixels and drawing operations
 * with MuPDF — never only the UI.
 */

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PointerKind = 'mouse' | 'touch' | 'pen';

/** Open Redact with a PDF and wait until the first page is drawn. */
export async function openRedact(page: Page, pdf: string | { name: string; buffer: Buffer }) {
  await page.goto('/redact-pdf');
  if (typeof pdf === 'string') await uploadFiles(page, pdf);
  else await uploadBuffer(page, { name: pdf.name, mimeType: 'application/pdf', buffer: pdf.buffer });
  await expect(page.getByTestId('workspace')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('overlay-layer')).toBeVisible();
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/** Go to a page (1-based) with the pager and wait for it to be drawn. */
export async function goToPage(page: Page, pageNumber: number) {
  for (let guard = 0; guard < 60; guard++) {
    const shown = Number(await page.getByTestId('page-canvas').getAttribute('data-page'));
    if (shown === pageNumber) break;
    await page.getByTestId(shown < pageNumber ? 'page-next' : 'page-prev').click();
  }
  await expect(page.getByTestId('page-canvas')).toHaveAttribute('data-page', String(pageNumber));
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

async function canvasBox(page: Page) {
  const box = await page.getByTestId('page-canvas').boundingBox();
  if (!box) throw new Error('page canvas has no box');
  return box;
}

/**
 * Drag a mark on the current page from one corner of `rect` (fractions of the
 * page) to the other. A mouse drag is a real mouse; touch and pen are pointer
 * events with that `pointerType`, as a finger or a stylus sends them.
 */
export async function drawMark(page: Page, rect: ViewRect, kind: PointerKind = 'mouse') {
  const before = await page.getByTestId('overlay-item').count();
  const box = await canvasBox(page);
  const x1 = box.x + rect.x * box.width;
  const y1 = box.y + rect.y * box.height;
  const x2 = box.x + (rect.x + rect.width) * box.width;
  const y2 = box.y + (rect.y + rect.height) * box.height;
  if (kind === 'mouse') {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
    await page.mouse.move(x2, y2, { steps: 4 });
    await page.mouse.up();
  } else {
    await page.getByTestId('overlay-layer').evaluate(
      (el, { x1, y1, x2, y2, kind }) => {
        const fire = (type: string, x: number, y: number) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              pointerId: kind === 'pen' ? 21 : 11,
              pointerType: kind,
              isPrimary: true,
              button: type === 'pointermove' ? -1 : 0,
              buttons: type === 'pointerup' ? 0 : 1,
              pressure: type === 'pointerup' ? 0 : 0.5,
              clientX: x,
              clientY: y,
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
        fire('pointerdown', x1, y1);
        for (let i = 1; i <= 6; i++) fire('pointermove', x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6);
        fire('pointerup', x2, y2);
      },
      { x1, y1, x2, y2, kind },
    );
  }
  await expect(page.getByTestId('overlay-item')).toHaveCount(before + 1);
}

/** Where a mark is on screen, as fractions of the page. */
export async function markViewRect(page: Page, mark?: Locator): Promise<ViewRect> {
  const el = mark ?? page.locator('[data-testid="overlay-item"][data-selected="true"]');
  const box = await el.boundingBox();
  const canvas = await canvasBox(page);
  if (!box) throw new Error('mark has no box');
  return {
    x: (box.x - canvas.x) / canvas.width,
    y: (box.y - canvas.y) / canvas.height,
    width: box.width / canvas.width,
    height: box.height / canvas.height,
  };
}

/** Tick the confirmation, press Redact PDF, download the result. */
export async function redactAndDownload(page: Page, { confirm = true } = {}): Promise<Buffer> {
  await openOptions(page);
  if (confirm && !(await page.getByTestId('confirm-redaction').isChecked())) await page.getByTestId('confirm-redaction').check();
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click(), { timeout: 90_000 });
  expect(name).toMatch(/-redacted\.pdf$/);
  return bytes;
}

/* ── Reading the file ─────────────────────────────────────────────────── */

export interface TextRunAt {
  str: string;
  /** Centre of the run on the displayed page, by pdf.js's own viewport. */
  x: number;
  y: number;
}

/** Text runs of a page with where pdf.js shows them, as fractions of the displayed page. */
export async function textRunsAt(bytes: Buffer, pageIndex: number): Promise<TextRunAt[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const out: TextRunAt[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const [a, b, c, d, e, f] = item.transform as number[];
      const along = Math.hypot(a, b) || 1;
      const up = Math.hypot(c, d) || 1;
      const h = item.height || up;
      const cx = e + ((item.width / 2) * a) / along + ((h / 2) * c) / up;
      const cy = f + ((item.width / 2) * b) / along + ((h / 2) * d) / up;
      const [vx, vy] = vp.convertToViewportPoint(cx, cy);
      out.push({ str: item.str, x: vx / vp.width, y: vy / vp.height });
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

export async function pageText(bytes: Buffer, pageIndex: number): Promise<string> {
  return (await textRunsAt(bytes, pageIndex)).map((r) => r.str).join(' ');
}

async function mupdf() {
  return import('mupdf');
}

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 bytes a pixel. */
  data: Uint8ClampedArray;
}

/** Render a page of a PDF with MuPDF (not the app's renderer), as displayed: rotation and crop box applied. */
export async function renderPage(bytes: Buffer, pageIndex: number, scale = 2): Promise<Raster> {
  const m = await mupdf();
  const doc = m.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page = doc.loadPage(pageIndex);
  const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, false);
  const raster = { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8ClampedArray(pix.getPixels()) };
  pix.destroy();
  page.destroy();
  doc.destroy();
  return raster;
}

/** The bounding box of the pure-black pixels of a raster, as fractions; null when there are none. */
export function blackBounds(r: Raster, threshold = 20): ViewRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 3;
      if (r.data[i] < threshold && r.data[i + 1] < threshold && r.data[i + 2] < threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX / r.width, y: minY / r.height, width: (maxX + 1 - minX) / r.width, height: (maxY + 1 - minY) / r.height };
}

export function expectSameRect(actual: ViewRect | null, expected: ViewRect, tolerance: number, what: string) {
  expect(actual, `${what} exists`).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual![key] - expected[key]), `${what}.${key}: ${actual![key]} vs ${expected[key]}`).toBeLessThanOrEqual(tolerance);
  }
}

/**
 * The pixels of every image on a page, from the image data stored in the file
 * (not a render of the page, so a black box drawn over an image does not hide
 * what the image itself still holds). `bbox` is where the image is drawn, as
 * fractions of the displayed page.
 */
export async function pageImages(bytes: Buffer, pageIndex: number): Promise<{ bbox: ViewRect; raster: Raster }[]> {
  const m = await mupdf();
  const doc = m.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page = doc.loadPage(pageIndex);
  const [bx0, by0, bx1, by1] = page.getBounds();
  const images: { bbox: ViewRect; raster: Raster }[] = [];
  const text = page.toStructuredText('preserve-images');
  text.walk({
    onImageBlock(bbox, _transform, image) {
      let pix = image.toPixmap();
      if (pix.getColorSpace()?.getNumberOfComponents() !== 3 || pix.getAlpha()) {
        const rgb = pix.convertToColorSpace(m.ColorSpace.DeviceRGB, false);
        pix = rgb;
      }
      images.push({
        bbox: {
          x: (bbox[0] - bx0) / (bx1 - bx0),
          y: (bbox[1] - by0) / (by1 - by0),
          width: (bbox[2] - bbox[0]) / (bx1 - bx0),
          height: (bbox[3] - bbox[1]) / (by1 - by0),
        },
        raster: { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8ClampedArray(pix.getPixels()) },
      });
    },
  });
  return images;
}

/** Spread of the pixel values inside a region of a raster (fractions): 0 when every pixel is the same. */
export function regionSpread(r: Raster, rect: ViewRect): { min: number; max: number } {
  let min = 255;
  let max = 0;
  const x0 = Math.floor(rect.x * r.width);
  const x1 = Math.ceil((rect.x + rect.width) * r.width);
  const y0 = Math.floor(rect.y * r.height);
  const y1 = Math.ceil((rect.y + rect.height) * r.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * 3;
      const v = (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

/** Bounding boxes of every stroked path on a page, as fractions of the displayed page. */
export async function strokedPaths(bytes: Buffer, pageIndex: number): Promise<ViewRect[]> {
  const m = await mupdf();
  const doc = m.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page = doc.loadPage(pageIndex);
  const [bx0, by0, bx1, by1] = page.getBounds();
  const boxes: ViewRect[] = [];
  const device = new m.Device({
    strokePath(path, stroke, ctm) {
      const [x0, y0, x1, y1] = path.getBounds(stroke, ctm);
      boxes.push({ x: (x0 - bx0) / (bx1 - bx0), y: (y0 - by0) / (by1 - by0), width: (x1 - x0) / (bx1 - bx0), height: (y1 - y0) / (by1 - by0) });
    },
  });
  page.run(device, m.Matrix.identity);
  device.close();
  return boxes;
}

export function inside(rect: ViewRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * Like `blackBounds`, but only pixels that are black in `after` and were not in
 * `before` — the black boxes redaction added, not black text that was there.
 */
export function addedBlackBounds(before: Raster, after: Raster, threshold = 20): ViewRect | null {
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  const black = (r: Raster, i: number) => r.data[i] < threshold && r.data[i + 1] < threshold && r.data[i + 2] < threshold;
  const only: Raster = { width: after.width, height: after.height, data: new Uint8ClampedArray(after.data.length).fill(255) };
  for (let i = 0; i < after.data.length; i += 3) {
    if (black(after, i) && !black(before, i)) only.data[i] = only.data[i + 1] = only.data[i + 2] = 0;
  }
  return blackBounds(only, threshold);
}

/** Mean absolute difference of two same-sized rasters over a region (fractions). */
export function regionDiff(a: Raster, b: Raster, rect: ViewRect): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  const x0 = Math.floor(rect.x * a.width);
  const x1 = Math.ceil((rect.x + rect.width) * a.width);
  const y0 = Math.floor(rect.y * a.height);
  const y1 = Math.ceil((rect.y + rect.height) * a.height);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 3;
      sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}
