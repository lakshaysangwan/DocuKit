import { type Page, expect } from '@playwright/test';
import { uploadFiles, expectDownload, assertPdf, readPdfContentStreams } from './harness';

/**
 * Helpers for the Image to PDF workspace. The point of them is one comparison:
 * what the preview says a page will be, against what the DOWNLOADED file is.
 */

type Upload = string | { name: string; mimeType: string; buffer: Buffer };

/** Open Image to PDF with some images and wait until every page is laid out. */
export async function openImages(page: Page, files: Upload | Upload[]) {
  const list = (Array.isArray(files) ? files : [files]) as Upload[];
  await page.goto('/image-to-pdf');
  await uploadFiles(page, list as string[]);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('output-page')).toHaveCount(list.length, { timeout: 30_000 });
}

/** A page as the preview shows it: the numbers on `output-page`, and its box on screen. */
export interface PreviewPage {
  filename: string;
  label: string;
  pageW: number;
  pageH: number;
  /** Points, bottom-left origin. */
  draw: { x: number; y: number; w: number; h: number };
  /** Width ÷ height of the page box as actually laid out on screen. */
  boxAspect: number;
  /** The image's box as a fraction of the page box, measured on screen (top-left origin). */
  imageBox: { x: number; y: number; w: number; h: number };
}

/** Every page in the preview grid, in order. */
export async function previewPages(page: Page): Promise<PreviewPage[]> {
  return page.locator('[data-testid="page-grid"] [data-testid="file-card"]').evaluateAll((cards) =>
    cards.map((card) => {
      const el = card.querySelector<HTMLElement>('[data-testid="output-page"]')!;
      const [pageW, pageH] = el.dataset.page!.split(',').map(Number);
      const [x, y, w, h] = el.dataset.draw!.split(',').map(Number);
      const box = el.getBoundingClientRect();
      const content = el.querySelector('[data-testid="output-page-content"]')!.getBoundingClientRect();
      return {
        filename: card.getAttribute('data-filename') ?? '',
        label: card.querySelector('[data-testid="page-label"]')?.textContent?.trim() ?? '',
        pageW,
        pageH,
        draw: { x, y, w, h },
        boxAspect: box.width / box.height,
        imageBox: {
          x: (content.left - box.left) / box.width,
          y: (content.top - box.top) / box.height,
          w: content.width / box.width,
          h: content.height / box.height,
        },
      };
    }),
  );
}

/** Press "Create PDF", wait for the download to take its place, and fetch the file. */
export async function createAndDownload(page: Page): Promise<Buffer> {
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });
  const { bytes, name } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  expect(name).toBe('images.pdf');
  return bytes;
}

/** A page as the file has it. */
export interface FilePage {
  /** MediaBox size in points. */
  pageW: number;
  pageH: number;
  /** The image's `cm` matrix: translate (x, y), scale (w, h). Points, bottom-left origin. */
  draw: { x: number; y: number; w: number; h: number };
  /** The embedded image itself. */
  image: { width: number; height: number; filter: string; hasSoftMask: boolean };
}

const NUM = '(-?\\d*\\.?\\d+(?:e-?\\d+)?)';

/**
 * Every page of an Image to PDF output, read from the file with a parser:
 * the MediaBox, the matrix the image is painted with, and the image stream's
 * own size and encoding. Nothing here comes from the app.
 */
export async function readOutputPages(bytes: Buffer): Promise<FilePage[]> {
  const { PDFDocument, PDFName, PDFDict, PDFNumber, PDFRawStream, PDFArray } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out: FilePage[] = [];
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const media = pages[i].getMediaBox();
    expect([media.x, media.y], `page ${i + 1}: MediaBox origin`).toEqual([0, 0]);

    // pdf-lib paints an image as translate, rotate, scale, skew, then Do.
    const content = (await readPdfContentStreams(bytes, i)).join('\n');
    const painted = [
      ...content.matchAll(
        new RegExp(
          `1 0 0 1 ${NUM} ${NUM} cm\\s+${NUM} ${NUM} ${NUM} ${NUM} 0 0 cm\\s+${NUM} 0 0 ${NUM} 0 0 cm\\s+1 0 0 1 0 0 cm\\s+/(\\S+) Do`,
          'g',
        ),
      ),
    ];
    expect(painted, `page ${i + 1}: exactly one image is painted`).toHaveLength(1);
    const [x, y, cos, sin, negSin, cos2, w, h] = painted[0].slice(1, 9).map(Number);
    expect([cos, Math.abs(sin), Math.abs(negSin), cos2], `page ${i + 1}: the image is not rotated`).toEqual([1, 0, 0, 1]);

    const xobjects = pages[i].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const stream = xobjects.lookup(PDFName.of(painted[0][9]));
    if (!(stream instanceof PDFRawStream)) throw new Error(`page ${i + 1}: image XObject is not a stream`);
    const filterEntry = stream.dict.lookup(PDFName.of('Filter'));
    const filter = filterEntry instanceof PDFArray ? filterEntry.asArray().join(' ') : String(filterEntry);
    out.push({
      pageW: media.width,
      pageH: media.height,
      draw: { x, y, w, h },
      image: {
        width: stream.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
        height: stream.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(),
        filter,
        hasSoftMask: stream.dict.get(PDFName.of('SMask')) !== undefined,
      },
    });
  }
  return out;
}

/**
 * The comparison: each previewed page against the page at the same position in
 * the file — page size against MediaBox, draw rectangle against the `cm` matrix
 * — to a hundredth of a point. Also checks the preview is DRAWN the way its
 * numbers say: the page box has the page's proportions and the image sits where
 * the rectangle puts it.
 */
export function expectPreviewMatchesFile(preview: PreviewPage[], file: FilePage[]) {
  expect(file.length, 'pages in the file').toBe(preview.length);
  preview.forEach((shown, i) => {
    const written = file[i];
    const where = `page ${i + 1} (${shown.filename})`;
    expect(shown.pageW, `${where}: page width`).toBeCloseTo(written.pageW, 2);
    expect(shown.pageH, `${where}: page height`).toBeCloseTo(written.pageH, 2);
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      expect(shown.draw[key], `${where}: draw.${key}`).toBeCloseTo(written.draw[key], 2);
    }

    // What is on screen, in the file's terms.
    expect(
      Math.abs(shown.boxAspect - written.pageW / written.pageH),
      `${where}: the page box has the page's proportions`,
    ).toBeLessThan(0.02);
    const { draw, pageW, pageH } = written;
    const expected = { x: draw.x / pageW, y: 1 - (draw.y + draw.h) / pageH, w: draw.w / pageW, h: draw.h / pageH };
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      expect(
        Math.abs(shown.imageBox[key] - expected[key]),
        `${where}: image ${key} on screen (${shown.imageBox[key].toFixed(4)}) vs in the file (${expected[key].toFixed(4)})`,
      ).toBeLessThan(0.02);
    }
  });
}
