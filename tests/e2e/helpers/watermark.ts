import { type Page, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { uploadFiles, expectDownload, assertPdf, readPdfContentStreams } from './harness';
import { userToView } from './edit-pdf';

/**
 * Helpers for Watermark PDF's workspace — and the part that matters: where
 * each copy of the watermark is ON SCREEN (read from the drawn SVG with the
 * browser's own transform) and where it is IN THE DOWNLOADED FILE (read from
 * the content stream and mapped to the displayed page by pdf.js's viewport).
 * Neither side uses the app's layout code, so they can be compared.
 */

export type Point = [number, number];
/** A copy's box corners on the displayed page, as fractions: bottom-left, bottom-right, top-right, top-left. */
export type Corners = [Point, Point, Point, Point];

/** Open Watermark PDF with a document and wait for its first page to be drawn. */
export async function openWatermark(page: Page, pdf: string) {
  await page.goto('/watermark-pdf');
  await uploadFiles(page, pdf);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** On a phone the options are in a closed panel; open it. Elsewhere it does nothing. */
export async function openOptions(page: Page) {
  const toggle = page.getByTestId('options-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

/** Set a range input to `value`. */
export async function setSlider(page: Page, id: string, value: number) {
  await page.locator(`#${id}`).fill(String(value));
  await expect(page.locator(`#${id}`)).toHaveValue(String(value));
}

/** Press Add watermark and download the result. */
export async function watermarkAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 60_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  expect(name).toMatch(/-watermarked\.pdf$/);
  return bytes;
}

/** Wait until the viewer shows the page of the real output. */
export async function waitForOutputPage(page: Page) {
  await expect(page.getByTestId('output-caption')).toHaveText('Watermarked — this is your file');
  await expect(page.getByTestId('page-image')).toHaveAttribute('alt', /^Watermarked page/, { timeout: 30_000 });
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/**
 * Every copy of the watermark drawn on the page the viewer shows: the corners
 * of its box as the browser renders it (the SVG element's screen transform,
 * rotation included), as fractions of the page image.
 */
export async function screenMarks(page: Page): Promise<Corners[]> {
  await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const image = document.querySelector('[data-testid="page-image"]')!.getBoundingClientRect();
    return [...document.querySelectorAll<SVGRectElement>('[data-testid="wm-box"]')].map((box) => {
      const m = box.getScreenCTM()!;
      const x = box.x.baseVal.value;
      const y = box.y.baseVal.value;
      const w = box.width.baseVal.value;
      const h = box.height.baseVal.value;
      return [
        [x, y + h],
        [x + w, y + h],
        [x + w, y],
        [x, y],
      ].map(([px, py]) => {
        const p = new DOMPoint(px, py).matrixTransform(m);
        return [(p.x - image.left) / image.width, (p.y - image.top) / image.height];
      }) as [number, number][];
    }) as unknown as [Point, Point, Point, Point][];
  });
}

const NUM = '(-?\\d*\\.?\\d+(?:e-?\\d+)?)';

export interface FileMark {
  corners: Corners;
  kind: 'text' | 'image';
  /** Tf size for text. */
  fontSize: number | null;
  /** Font resource name for text. */
  fontName: string | null;
}

const STANDARD: Record<string, StandardFonts> = {
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Courier-Bold': StandardFonts.CourierBold,
};

/**
 * Every copy of the watermark in a page of the downloaded file: each
 * `q a b c d e f cm … Q` frame the tool wrote, with its box — an image's from
 * its own `W 0 0 H 0 0 cm`, a line of text's from the standard font's metrics
 * (sum of advance widths; descender to ascender) via pdf-lib — mapped to the
 * displayed page with pdf.js.
 */
export async function fileMarks(
  bytes: Buffer,
  pageIndex: number,
  text?: { text: string; font: keyof typeof STANDARD },
): Promise<FileMark[]> {
  const content = (await readPdfContentStreams(bytes, pageIndex)).join('\n');
  const frame = new RegExp(
    `q ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm (?:BT /(\\S+) ${NUM} Tf 1 0 0 1 0 ${NUM} Tm|${NUM} 0 0 ${NUM} 0 0 cm /\\S+ Do)`,
    'g',
  );
  let textBox: ((size: number) => { w: number; h: number; baseline: number }) | null = null;
  if (text) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(STANDARD[text.font]);
    const width = [...text.text].reduce((s, ch) => s + font.widthOfTextAtSize(ch, 1), 0);
    const height = font.heightAtSize(1);
    const ascent = font.heightAtSize(1, { descender: false });
    textBox = (size) => ({ w: width * size, h: height * size, baseline: (height - ascent) * size });
  }
  const out: FileMark[] = [];
  for (const m of content.matchAll(frame)) {
    const [a, b, c, d, e, f] = m.slice(1, 7).map(Number);
    let w: number;
    let h: number;
    let kind: 'text' | 'image';
    let fontSize: number | null = null;
    if (m[7]) {
      kind = 'text';
      fontSize = Number(m[8]);
      const box = textBox!(fontSize);
      // The baseline the file uses must be the box's: descender below it.
      expect(Math.abs(Number(m[9]) - box.baseline), 'text baseline in its box').toBeLessThan(0.01);
      w = box.w;
      h = box.h;
    } else {
      kind = 'image';
      w = Number(m[10]);
      h = Number(m[11]);
    }
    const at = (u: number, v: number): Point => [a * u + c * v + e, b * u + d * v + f];
    const corners = (await userToView(bytes, pageIndex, [at(0, 0), at(w, 0), at(w, h), at(0, h)])) as Corners;
    out.push({ corners, kind, fontSize, fontName: m[7] ?? null });
  }
  return out;
}

/** Every copy on screen is a copy in the file at the same corners, within `tolerance` of the page. */
export function expectSameMarks(file: FileMark[], screen: Corners[], tolerance = 0.005) {
  expect(screen.length, 'copies on screen').toBeGreaterThan(0);
  expect(file.length, 'copies in the file').toBe(screen.length);
  for (let i = 0; i < screen.length; i++) {
    for (let k = 0; k < 4; k++) {
      for (const axis of [0, 1]) {
        const got = file[i].corners[k][axis];
        const want = screen[i][k][axis];
        expect(Math.abs(got - want), `copy ${i}, corner ${k}, ${axis ? 'y' : 'x'}: file ${got.toFixed(4)} screen ${want.toFixed(4)}`).toBeLessThan(tolerance);
      }
    }
  }
}
