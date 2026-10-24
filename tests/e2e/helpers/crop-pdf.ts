import { type Page, expect } from '@playwright/test';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { uploadFiles, uploadBuffer, expectDownload, assertPdf } from './harness';
import { userToView } from './edit-pdf';

/**
 * Helpers for Crop PDF's workspace, and the part that matters: the area the
 * downloaded file shows, read from each page's /CropBox and mapped to the
 * ORIGINAL displayed page by pdf.js's own viewport — none of the app's
 * geometry code — so it can be compared with the margins chosen on screen.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
export type Margins = Record<Side, number>;

const rendered = (page: Page) => page.locator('[data-testid="page-canvas"][data-rendered="true"]');

/** Open Crop PDF with a document (a path, or bytes) and wait for its first page to be drawn. */
export async function openCrop(page: Page, pdf: string | { name: string; buffer: Buffer }) {
  await page.goto('/crop-pdf');
  if (typeof pdf === 'string') await uploadFiles(page, pdf);
  else await uploadBuffer(page, { name: pdf.name, mimeType: 'application/pdf', buffer: pdf.buffer });
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('overlay-handle-top')).toBeVisible();
}

/** On a phone the options sit behind a toggle: run `fn` with them open, then close them again. */
export async function withOptions(page: Page, fn: () => Promise<void>) {
  const toggle = page.getByTestId('options-toggle');
  const closed = (await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false';
  if (closed) await toggle.click();
  await fn();
  if (closed) await toggle.click();
}

export async function setUnit(page: Page, unit: 'mm' | 'in' | 'pt') {
  await withOptions(page, async () => {
    await page.getByRole('button', { name: unit, exact: true }).click();
    await expect(page.getByTestId(`crop-unit-${unit}`)).toHaveAttribute('aria-pressed', 'true');
  });
}

export const field = (page: Page, side: Side) => page.locator(`#crop-margin-${side}`);

export async function setMargins(page: Page, m: Partial<Margins>) {
  await withOptions(page, async () => {
    for (const side of SIDES) if (m[side] !== undefined) await field(page, side).fill(String(m[side]));
  });
}

/** The four fields, as numbers in the unit shown. */
export async function readMargins(page: Page): Promise<Margins> {
  const read = async (side: Side) => Number(await field(page, side).inputValue());
  return { top: await read('top'), right: await read('right'), bottom: await read('bottom'), left: await read('left') };
}

/** Show page `pageIndex` (zero-based) with the pager, which every layout has. */
export async function goToPage(page: Page, pageIndex: number) {
  for (let guard = 0; guard < 50; guard++) {
    const text = (await page.getByTestId('page-indicator').textContent()) ?? '';
    const now = Number(/Page (\d+)/.exec(text)?.[1] ?? 0) - 1;
    if (now === pageIndex) break;
    await page.getByTestId(now < pageIndex ? 'page-next' : 'page-prev').click();
    await expect(page.getByTestId('page-indicator')).toContainText(`Page ${now + (now < pageIndex ? 2 : 0)} of`);
  }
  await expect(page.getByTestId('page-indicator')).toContainText(`Page ${pageIndex + 1} of`);
  await expect(rendered(page)).toHaveAttribute('data-page', String(pageIndex + 1));
  await expect(rendered(page)).toBeVisible({ timeout: 30_000 });
}

/** Press Crop PDF and download the result. */
export async function cropAndDownload(page: Page, timeout = 90_000): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click(), { timeout });
  assertPdf(bytes);
  expect(name).toMatch(/-cropped\.pdf$/);
  return bytes;
}

/** Displayed size of each page of a PDF, in points, by pdf.js (after /Rotate, inside the crop box). */
export async function displayedSizes(bytes: Buffer | Uint8Array): Promise<{ width: number; height: number }[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const out: { width: number; height: number }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      out.push({ width: vp.width, height: vp.height });
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/**
 * The visual area each page of `output` shows, as margins in fractions of the
 * ORIGINAL displayed page: the output /CropBox's corners mapped through the
 * original page's pdf.js viewport.
 */
export async function shownAreaFractions(original: Buffer, output: Buffer, pageIndex: number): Promise<Margins> {
  const doc = await PDFDocument.load(output, { ignoreEncryption: true, updateMetadata: false });
  const box = doc.getPage(pageIndex).getCropBox();
  const [[ax, ay], [bx, by]] = await userToView(original, pageIndex, [
    [box.x, box.y],
    [box.x + box.width, box.y + box.height],
  ]);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: 1 - Math.max(ax, bx),
    bottom: 1 - Math.max(ay, by),
  };
}

export type ColourBox = { x1: number; y1: number; x2: number; y2: number };

/**
 * The box (fractions of the page) of strongly red or blue pixels in the page
 * image the viewer shows, or null when there are almost none (or the image the
 * viewer had a moment ago has been replaced by a fresh render).
 */
export async function colourBoxInViewer(page: Page, colour: 'red' | 'blue'): Promise<ColourBox | null> {
  const image = page.getByTestId('page-image');
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src');
  return src ? colourBoxInImage(page, src, colour) : null;
}

/**
 * The same box, read from the downloaded file itself: a flattened page is one
 * JPEG drawn over the whole page, so that JPEG is taken out of the PDF and
 * decoded by the browser — no viewer, no pdf.js.
 */
export async function colourBoxInFlattenedPage(
  page: Page,
  pdf: Buffer,
  pageIndex: number,
  colour: 'red' | 'blue',
): Promise<ColourBox | null> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  const xobjects = doc.getPage(pageIndex).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  expect(xobjects, 'the flattened page draws an image').toBeTruthy();
  const images = xobjects!
    .values()
    .map((ref) => doc.context.lookup(ref))
    .filter((obj): obj is PDFRawStream => obj instanceof PDFRawStream);
  expect(images, 'the flattened page is exactly one image').toHaveLength(1);
  expect(String(images[0].dict.get(PDFName.of('Filter'))), 'a JPEG').toBe('/DCTDecode');
  const jpeg = Buffer.from(images[0].contents).toString('base64');
  return colourBoxInImage(page, `data:image/jpeg;base64,${jpeg}`, colour);
}

/** Decode the image at `src` in the page and find the colour's box; null if it cannot be read. */
async function colourBoxInImage(page: Page, src: string, colour: 'red' | 'blue'): Promise<ColourBox | null> {
  return page.evaluate(async ({ src, want }) => {
    const el = new Image();
    el.src = src;
    try {
      await el.decode();
    } catch {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        const hit = want === 'red' ? r - Math.max(g, b) > 100 : b - Math.max(r, g) > 100;
        if (hit) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x + 1);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y + 1);
          count++;
        }
      }
    }
    if (count < 20) return null;
    return { x1: minX / width, y1: minY / height, x2: maxX / width, y2: maxY / height };
  }, { src, want: colour });
}

/** The raw /CropBox of every page, `[x, y, width, height]`. */
export async function cropBoxes(bytes: Buffer): Promise<[number, number, number, number][]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPages().map((p) => {
    const b = p.getCropBox();
    return [b.x, b.y, b.width, b.height];
  });
}
