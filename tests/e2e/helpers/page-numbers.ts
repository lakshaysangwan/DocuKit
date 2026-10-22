import { type Page, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { uploadFiles, expectDownload, assertPdf, readPdfContentStreams } from './harness';
import { userToView } from './edit-pdf';

/**
 * Helpers for Add Page Numbers' workspace — and the part that matters: where
 * the number is ON SCREEN (read from the drawn SVG with the browser's own
 * transform) and where it is IN THE DOWNLOADED FILE (read from the content
 * stream and mapped to the displayed page by pdf.js's viewport). Neither side
 * uses the app's layout code, so they can be compared.
 */

export type Point = [number, number];
/** A box's corners on the displayed page, as fractions: bottom-left, bottom-right, top-right, top-left. */
export type Corners = [Point, Point, Point, Point];

export interface ScreenNumber {
  text: string;
  corners: Corners;
}

export interface FileNumber {
  text: string;
  corners: Corners;
  fontSize: number;
  /** The `r g b rg` in force, as written. */
  colour: string | null;
}

export type PnFont = 'Helvetica' | 'Times-Roman' | 'Courier';

/** Open Add Page Numbers with a document and wait for its first page to be drawn. */
export async function openPageNumbers(page: Page, pdf: string) {
  await page.goto('/add-page-numbers');
  await uploadFiles(page, pdf);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** Set a range input to `value`. */
export async function setSlider(page: Page, id: string, value: number) {
  await page.locator(`#${id}`).fill(String(value));
  await expect(page.locator(`#${id}`)).toHaveValue(String(value));
}

/** Show page `pageIndex` (zero-based) on the stage. */
export async function goToPage(page: Page, pageIndex: number) {
  await page.getByTestId('rail-page-' + (pageIndex + 1)).click();
  await expect(page.getByTestId('page-indicator')).toContainText(`Page ${pageIndex + 1} of`);
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** Press Add page numbers and download the result. */
export async function numberAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  expect(name).toMatch(/-numbered\.pdf$/);
  return bytes;
}

/** Wait until the viewer shows the page of the real output. */
export async function waitForOutputPage(page: Page) {
  await expect(page.getByTestId('output-caption')).toHaveText('Numbered — this is your file');
  await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Numbered page/, { timeout: 30_000 });
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** The number drawn on the page the stage shows: its text and box corners as the browser renders them. Null when none. */
export async function screenNumber(page: Page): Promise<ScreenNumber | null> {
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const box = document.querySelector<SVGRectElement>('[data-testid="pn-box"]');
    if (!box) return null;
    const image = document.querySelector('[data-testid="page-image"]')!.getBoundingClientRect();
    const m = box.getScreenCTM()!;
    const x = box.x.baseVal.value;
    const y = box.y.baseVal.value;
    const w = box.width.baseVal.value;
    const h = box.height.baseVal.value;
    const corners = [
      [x, y + h],
      [x + w, y + h],
      [x + w, y],
      [x, y],
    ].map(([px, py]) => {
      const p = new DOMPoint(px, py).matrixTransform(m);
      return [(p.x - image.left) / image.width, (p.y - image.top) / image.height];
    });
    const text = document.querySelector('[data-testid="page-numbers-preview"]')!.getAttribute('data-text') ?? '';
    return { text, corners } as unknown as { text: string; corners: [number, number][] };
  }) as Promise<ScreenNumber | null>;
}

const NUM = '(-?\\d*\\.?\\d+(?:e-?\\d+)?)';
const STANDARD: Record<PnFont, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Times-Roman': StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
};

/**
 * Every number the tool wrote into a page of the downloaded file: each
 * `q a b c d e f cm BT /F s Tf 1 0 0 1 0 b Tm <hex> Tj ET Q` frame, its text
 * decoded, its box from the standard font's metrics (sum of advance widths;
 * descender to ascender) via pdf-lib, mapped to the displayed page with pdf.js.
 */
export async function fileNumbers(bytes: Buffer, pageIndex: number, font: PnFont = 'Helvetica'): Promise<FileNumber[]> {
  const content = (await readPdfContentStreams(bytes, pageIndex)).join('\n');
  const frame = new RegExp(
    `(?:(${NUM} ${NUM} ${NUM}) rg\\s+)?q ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm BT /\\S+ ${NUM} Tf 1 0 0 1 0 ${NUM} Tm <([0-9A-Fa-f]*)> Tj ET Q`,
    'g',
  );
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(STANDARD[font]);
  const height = f.heightAtSize(1);
  const ascent = f.heightAtSize(1, { descender: false });
  const out: FileNumber[] = [];
  for (const m of content.matchAll(frame)) {
    const [a, b, c, d, e, ff] = m.slice(5, 11).map(Number);
    const fontSize = Number(m[11]);
    const text = Buffer.from(m[13], 'hex').toString('latin1');
    const w = [...text].reduce((s, ch) => s + f.widthOfTextAtSize(ch, fontSize), 0);
    const h = height * fontSize;
    expect(Math.abs(Number(m[12]) - (height - ascent) * fontSize), 'text baseline in its box').toBeLessThan(0.01);
    const at = (u: number, v: number): Point => [a * u + c * v + e, b * u + d * v + ff];
    const corners = (await userToView(bytes, pageIndex, [at(0, 0), at(w, 0), at(w, h), at(0, h)])) as Corners;
    out.push({ text, corners, fontSize, colour: m[1] ?? null });
  }
  return out;
}

/** The number in the file has the text shown and sits at the same corners, within `tolerance` of the page. */
export function expectSameNumber(file: FileNumber[], screen: ScreenNumber | null, what: string, tolerance = 0.005) {
  expect(screen, `${what}: a number on screen`).not.toBeNull();
  expect(file.map((n) => n.text), `${what}: text in the file`).toEqual([screen!.text]);
  for (let k = 0; k < 4; k++) {
    for (const axis of [0, 1]) {
      const got = file[0].corners[k][axis];
      const want = screen!.corners[k][axis];
      expect(Math.abs(got - want), `${what}, corner ${k}, ${axis ? 'y' : 'x'}: file ${got.toFixed(4)} screen ${want.toFixed(4)}`).toBeLessThan(tolerance);
    }
  }
}

/** The box reads left to right, upright, on the displayed page. */
export function expectUpright(c: Corners, what: string) {
  const [bl, br, , tl] = c;
  expect(br[0] - bl[0], `${what}: runs left to right`).toBeGreaterThan(0);
  expect(Math.abs(br[1] - bl[1]), `${what}: baseline level`).toBeLessThan(1e-3);
  expect(tl[1] - bl[1], `${what}: top above bottom`).toBeLessThan(0);
}

/**
 * The bounding box (fractions of the page) of strongly red pixels in the page
 * image the viewer shows, or null when there are almost none. Draw the number
 * in #ff0000 to find it.
 */
export async function redBoxInViewer(page: Page) {
  const image = page.getByTestId('page-image');
  await expect(image).toBeVisible();
  return image.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
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
        // Strongly red: antialiasing and the page image's compression pull thin
        // text toward the paper, so no pixel need be pure red.
        if (data[i] - Math.max(data[i + 1], data[i + 2]) > 100) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x + 1);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y + 1);
          count++;
        }
      }
    }
    if (count < 20) return null;
    return { x1: minX / width, y1: minY / height, x2: maxX / width, y2: maxY / height, count };
  });
}
