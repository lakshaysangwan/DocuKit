import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import { DUPLICATE_NAMES, DUPLICATE_PAGES } from '../fixtures/duplicate-images';
import { addSingleFileAndWait, expectDownload, assertPdf, countPdfPagesStrict } from '../helpers/harness';

/**
 * Compress PDF stores an image the file repeats as separate objects only once.
 * Lossless, so at Low the pages must render to the very same pixels (MuPDF, a
 * different engine from the pdf.js preview), and the file must shrink by about
 * the size of the copies.
 */

async function renderAll(bytes: Buffer): Promise<Uint8Array[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const out: Uint8Array[] = [];
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      out.push(Uint8Array.from(pix.getPixels()));
      pix.destroy();
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  return out;
}

/** Image objects in the file, and the object each page's resource names point at. */
async function inspect(bytes: Buffer) {
  const { PDFDocument, PDFName, PDFDict, PDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const images = doc.context.enumerateIndirectObjects().filter(
    ([, obj]) => obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'),
  );
  const refOf = (page: number, name: string) =>
    doc.getPages()[page].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of(name))?.toString();
  const sizeOf = (page: number, name: string) => {
    const ref = doc.getPages()[page].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of(name));
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error(`${name} is not a stream`);
    const mask = stream.dict.lookup(PDFName.of('SMask'));
    return stream.contents.length + (mask instanceof PDFRawStream ? mask.contents.length : 0);
  };
  return { imageCount: images.length, refOf, sizeOf };
}

async function compress(page: Page, level: string): Promise<Buffer> {
  await page.goto('/compress-pdf');
  await addSingleFileAndWait(page, FIXTURE.pdfDuplicateImages);
  await page.getByRole('button', { name: level }).click();
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
  const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  return bytes;
}

test.describe('Compress PDF — repeated images are stored once', () => {
  test.setTimeout(120_000);

  let original: Buffer;
  let originalPages: Uint8Array[];

  test.beforeAll(async () => {
    original = await readFile(FIXTURE.pdfDuplicateImages);
    originalPages = await renderAll(original);
  });

  test('the fixture repeats each image as its own object on every page', async () => {
    const { imageCount, refOf } = await inspect(original);
    // Per page: logo, photo, stamp and its mask; page 1 adds two near-copies with a mask.
    expect(imageCount).toBe(DUPLICATE_PAGES * 4 + 3);
    const photos = new Set(Array.from({ length: DUPLICATE_PAGES }, (_, p) => refOf(p, DUPLICATE_NAMES.photo)));
    expect(photos.size).toBe(DUPLICATE_PAGES);
  });

  test('Low: one object per distinct image, about the copies smaller, pixel-identical pages', async ({ page }) => {
    const before = await inspect(original);
    const copiesBytes = (DUPLICATE_PAGES - 1) *
      [DUPLICATE_NAMES.logo, DUPLICATE_NAMES.photo, DUPLICATE_NAMES.stamp].reduce((sum, name) => sum + before.sizeOf(0, name), 0);

    const bytes = await compress(page, 'Low');
    console.log(`duplicate-images fixture, Low: ${original.length} → ${bytes.length} bytes (copies ${copiesBytes})`);
    expect(await countPdfPagesStrict(bytes)).toBe(DUPLICATE_PAGES);
    // qpdf's structural pass also saves a little on top, so "at least most of the copies".
    expect(original.length - bytes.length, 'smaller by about the copies').toBeGreaterThan(copiesBytes * 0.9);

    const after = await inspect(bytes);
    expect(after.imageCount, 'logo, photo, stamp, mask, and the near-copies with their mask').toBe(7);
    for (const name of [DUPLICATE_NAMES.logo, DUPLICATE_NAMES.photo, DUPLICATE_NAMES.stamp]) {
      const refs = new Set(Array.from({ length: DUPLICATE_PAGES }, (_, p) => after.refOf(p, name)));
      expect(refs.size, `${name} is one object on every page`).toBe(1);
    }
    expect(after.refOf(0, DUPLICATE_NAMES.inverted)).not.toBe(after.refOf(0, DUPLICATE_NAMES.photo));
    expect(after.refOf(0, DUPLICATE_NAMES.stampOther)).not.toBe(after.refOf(0, DUPLICATE_NAMES.stamp));

    const pages = await renderAll(bytes);
    pages.forEach((pixels, i) => {
      expect(Buffer.from(pixels).equals(Buffer.from(originalPages[i])), `page ${i + 1} renders pixel-identical`).toBe(true);
    });

    // Said per page, from what the pass did.
    await expect(page.getByTestId('quality-facts')).toContainText('stored once');
  });

  test('Medium: repeats are still one object each after re-encoding', async ({ page }) => {
    const bytes = await compress(page, 'Medium');
    console.log(`duplicate-images fixture, Medium: ${original.length} → ${bytes.length} bytes`);
    const after = await inspect(bytes);
    expect(after.imageCount).toBe(7);
    for (const name of [DUPLICATE_NAMES.logo, DUPLICATE_NAMES.photo, DUPLICATE_NAMES.stamp]) {
      expect(new Set(Array.from({ length: DUPLICATE_PAGES }, (_, p) => after.refOf(p, name))).size, name).toBe(1);
    }
  });
});
