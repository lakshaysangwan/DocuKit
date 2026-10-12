import { type Page, type Locator, expect } from '@playwright/test';
import { uploadFiles, expectDownload, assertPdf, readPdfContentStreams } from './harness';
import { MARKER_COLOURS } from '../fixtures/sign-fixtures';

/**
 * Helpers for the Sign PDF workspace: drive the flow, and — the part that
 * matters — read back from the DOWNLOADED file where each stamp was drawn, as
 * a rectangle of the displayed page, using pdf.js's own viewport as the oracle.
 */

/** A rectangle as fractions of the displayed page, top-left origin. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Open Sign PDF with a document and wait for its first page to be drawn. */
export async function openSign(page: Page, pdf: string) {
  await page.goto('/sign-pdf');
  await uploadFiles(page, pdf);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** Make a typed signature and put it on the current page. */
export async function addTypedSignature(page: Page, name = 'Ada Lovelace') {
  await page.getByTestId('signature-mode-type').click();
  await page.getByLabel('Signature text').fill(name);
  await page.getByTestId('use-signature').click();
  await expect(page.getByTestId('overlay-item').first()).toBeVisible();
}

/** Upload a picture as the signature; it goes onto the current page at once. */
export async function addUploadedSignature(page: Page, image: string) {
  await page.getByTestId('signature-mode-upload').click();
  const zone = page.getByTestId('signature-upload');
  await expect(zone.locator('[data-testid="dropzone"][data-hydrated="true"]')).toBeVisible();
  await zone.locator('input[type="file"]').setInputFiles(image);
  await expect(page.getByTestId('overlay-item').first()).toBeVisible();
}

/** Where a stamp is on screen: its box as fractions of the page it sits on. */
export async function stampViewRect(page: Page, stamp?: Locator): Promise<ViewRect> {
  const item = stamp ?? page.locator('[data-testid="overlay-item"][data-selected="true"]');
  await expect(item).toBeVisible();
  return item.evaluate((el) => {
    const canvas = el.closest('[data-testid="page-canvas"]')!.getBoundingClientRect();
    // The selection frame is an outline, so this box is exactly what the image fills.
    const box = el.getBoundingClientRect();
    return {
      x: (box.left - canvas.left) / canvas.width,
      y: (box.top - canvas.top) / canvas.height,
      width: box.width / canvas.width,
      height: box.height / canvas.height,
    };
  });
}

/** Set the selected stamp's position and width with the millimetre fields. */
export async function setStampMm(page: Page, mm: { x?: number; y?: number; width?: number }) {
  // Width first: it keeps the top-left corner, and X/Y then place that corner.
  if (mm.width !== undefined) await page.getByTestId('stamp-width').fill(String(mm.width));
  if (mm.x !== undefined) await page.getByTestId('stamp-x').fill(String(mm.x));
  if (mm.y !== undefined) await page.getByTestId('stamp-y').fill(String(mm.y));
  await page.getByTestId('stamp-y').blur();
}

/** Click "Sign PDF", wait for the download to replace it, and fetch the file. */
export async function signAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  expect(name).toMatch(/-signed\.pdf$/);
  return bytes;
}

type Point = [number, number];

/** Map PDF user-space points to fractions of the displayed page with pdf.js. */
async function userToView(bytes: Buffer, pageIndex: number, points: Point[]): Promise<Point[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    return points.map(([x, y]) => {
      const [vx, vy] = viewport.convertToViewportPoint(x, y);
      return [vx / viewport.width, vy / viewport.height];
    });
  } finally {
    await doc.destroy();
  }
}

const NUM = '(-?\\d*\\.?\\d+(?:e-?\\d+)?)';

/** An image drawn on a page, as it appears to the reader. */
export interface DrawnImage {
  /** XObject name, so "the same image on every page" can be told from copies. */
  name: string;
  /** The upright box that contains the image on the displayed page. */
  rect: ViewRect;
  /**
   * Where the image's own corners landed on the displayed page. For an upright
   * stamp `bottomLeft` is the box's bottom-left corner, and so on; anything
   * else means the image is turned or mirrored.
   */
  corners: { bottomLeft: Point; bottomRight: Point; topLeft: Point; topRight: Point };
}

/**
 * Every image pdf-lib drew on a page of the output, read from the content
 * stream (`translate · rotate · scale` then `Do`) and mapped to the displayed
 * page. This is independent of the app's own geometry code: the numbers come
 * from the file, the mapping from pdf.js.
 */
export async function readDrawnImages(bytes: Buffer, pageIndex = 0): Promise<DrawnImage[]> {
  const content = (await readPdfContentStreams(bytes, pageIndex)).join('\n');
  const pattern = new RegExp(
    `1 0 0 1 ${NUM} ${NUM} cm\\s+${NUM} ${NUM} ${NUM} ${NUM} 0 0 cm\\s+${NUM} 0 0 ${NUM} 0 0 cm\\s+1 0 0 1 0 0 cm\\s+/(\\S+) Do`,
    'g',
  );
  const out: DrawnImage[] = [];
  for (const m of content.matchAll(pattern)) {
    const [tx, ty, cos, sin, , , w, h] = m.slice(1, 9).map(Number);
    // A point (u, v) of the image's unit square, origin at its bottom-left.
    const at = (u: number, v: number): Point => [tx + cos * (w * u) - sin * (h * v), ty + sin * (w * u) + cos * (h * v)];
    const [bottomLeft, bottomRight, topLeft, topRight] = await userToView(bytes, pageIndex, [
      at(0, 0),
      at(1, 0),
      at(0, 1),
      at(1, 1),
    ]);
    const xs = [bottomLeft[0], bottomRight[0], topLeft[0], topRight[0]];
    const ys = [bottomLeft[1], bottomRight[1], topLeft[1], topRight[1]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    out.push({
      name: m[9],
      rect: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
      corners: { bottomLeft, bottomRight, topLeft, topRight },
    });
  }
  return out;
}

/** A line of text drawn on a page: its font size and where its baseline starts. */
export interface DrawnText {
  size: number;
  /** Baseline start, as fractions of the displayed page. */
  origin: Point;
  /** One font-size along the baseline and one up from it, on the displayed page. */
  along: Point;
  up: Point;
}

/** Every `Tf … Tm` text placement pdf-lib wrote on a page of the output. */
export async function readDrawnText(bytes: Buffer, pageIndex = 0): Promise<DrawnText[]> {
  const content = (await readPdfContentStreams(bytes, pageIndex)).join('\n');
  const pattern = new RegExp(`/\\S+ ${NUM} Tf[\\s\\S]*?${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} Tm`, 'g');
  const out: DrawnText[] = [];
  for (const m of content.matchAll(pattern)) {
    const [size, a, b, c, d, x, y] = m.slice(1, 8).map(Number);
    const [origin, along, up] = await userToView(bytes, pageIndex, [
      [x, y],
      [x + a * size, y + b * size],
      [x + c * size, y + d * size],
    ]);
    out.push({ size, origin, along, up });
  }
  return out;
}

/** Assert two view rectangles are the same to within `tolerance` of the page. */
export function expectSameRect(actual: ViewRect, expected: ViewRect, tolerance = 0.004, what = 'rectangle') {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${what}.${key}: got ${actual[key].toFixed(4)}, expected ${expected[key].toFixed(4)}`,
    ).toBeLessThan(tolerance);
  }
}

/** Assert an image is upright: each of its own corners is the matching corner of `rect`. */
export function expectUpright(image: DrawnImage, rect: ViewRect, tolerance = 0.004) {
  const want = {
    bottomLeft: [rect.x, rect.y + rect.height],
    bottomRight: [rect.x + rect.width, rect.y + rect.height],
    topLeft: [rect.x, rect.y],
    topRight: [rect.x + rect.width, rect.y],
  } as const;
  for (const corner of ['bottomLeft', 'bottomRight', 'topLeft', 'topRight'] as const) {
    expect(Math.abs(image.corners[corner][0] - want[corner][0]), `${corner} x`).toBeLessThan(tolerance);
    expect(Math.abs(image.corners[corner][1] - want[corner][1]), `${corner} y`).toBeLessThan(tolerance);
  }
}

/**
 * Find the four-coloured marker in the page the viewer is showing, by its
 * pixels. Returns the centre of each colour as fractions of the page, or null
 * for a colour that is not there. This looks at what was RENDERED, so it sees
 * things the content stream cannot — a leaked transform, a stamp painted under
 * the page content.
 */
export async function findMarkerInViewer(page: Page): Promise<Record<keyof typeof MARKER_COLOURS, Point | null>> {
  const image = page.getByTestId('page-image');
  await expect(image).toBeVisible();
  return image.evaluate(async (el: HTMLImageElement, colours) => {
    await el.decode();
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out: Record<string, [number, number] | null> = {};
    for (const [name, [r, g, b]] of Object.entries(colours)) {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - r) < 40 && Math.abs(data[i + 1] - g) < 40 && Math.abs(data[i + 2] - b) < 40) {
            sumX += x + 0.5;
            sumY += y + 0.5;
            count++;
          }
        }
      }
      // A few stray pixels are JPEG noise, not the marker.
      out[name] = count > 40 ? [sumX / count / width, sumY / count / height] : null;
    }
    return out as any;
  }, MARKER_COLOURS);
}

/** Where the centre of each marker quadrant should be for a marker filling `rect`. */
export function markerCentres(rect: ViewRect): Record<keyof typeof MARKER_COLOURS, Point> {
  const at = (u: number, v: number): Point => [rect.x + rect.width * u, rect.y + rect.height * v];
  return {
    topLeft: at(0.25, 0.25),
    topRight: at(0.75, 0.25),
    bottomLeft: at(0.25, 0.75),
    bottomRight: at(0.75, 0.75),
  };
}
