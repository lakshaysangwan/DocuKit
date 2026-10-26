import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { FIXTURE } from '../fixtures/generate';
import { SOFT_MASK_PAGE, OVERLAY_PAGE } from '../fixtures/masked-images';
import { addSingleFileAndWait, expectDownload, expectImageRendered, assertPdf, countPdfPagesStrict } from '../helpers/harness';

/**
 * Images under a plain soft mask are re-encoded with the mask kept: the
 * picture becomes a JPEG, the /SMask stays the very same stream. Black lies
 * under every clear pixel of the fixture's images, so a lost mask, or JPEG
 * ringing that drags the hidden black into the visible pixels, shows as dark
 * pixels — checked cell by cell across each image, its edges included. Everything is measured on MuPDF renders of the downloaded file
 * against the same render of the original (see compress-pdf-image-safety.spec.ts
 * for why), and on the pdf.js preview the visitor sees.
 */

type Rgb = [number, number, number];
interface Raster { width: number; height: number; n: number; data: Uint8Array }

async function renderPage(bytes: Buffer): Promise<Raster> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(0);
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return { width: pix.getWidth(), height: pix.getHeight(), n: pix.getNumberOfComponents(), data: Uint8Array.from(pix.getPixels()) };
  } finally {
    pix.destroy();
    page.destroy();
    doc.destroy();
  }
}

const luma = ([r, g, b]: Rgb) => 0.299 * r + 0.587 * g + 0.114 * b;
function meanRgb(r: Raster, x0: number, y0: number, x1: number, y1: number): Rgb {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(r.height, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(r.width, Math.ceil(x1)); x++) {
      const i = (y * r.width + x) * r.n;
      sum[0] += r.data[i]; sum[1] += r.data[i + 1]; sum[2] += r.data[i + 2];
      count++;
    }
  }
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}
const maxChannelDiff = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
function regionDiff(a: Raster, b: Raster, x0: number, y0: number, x1: number, y1: number, cells: number): number {
  let worst = 0;
  const cw = (x1 - x0) / cells;
  const ch = (y1 - y0) / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const box = [x0 + cx * cw, y0 + cy * ch, x0 + (cx + 1) * cw, y0 + (cy + 1) * ch] as const;
      worst = Math.max(worst, maxChannelDiff(meanRgb(a, ...box), meanRgb(b, ...box)));
    }
  }
  return worst;
}
const meanLuma = (r: Raster) => luma(meanRgb(r, 0, 0, r.width, r.height));
/** Mean of a 5×5 patch at a point given in page pixels from the top-left. */
const patch = (r: Raster, x: number, y: number) => meanRgb(r, x - 2, y - 2, x + 3, y + 3);
/** A badge-relative point, in render pixels (one per point, y from the top). */
function badgePoint(r: Raster, box: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }) {
  return [box.x + p.x * box.w, r.height - (box.y + box.h) + p.y * box.h] as const;
}

interface ImageInfo { filter: string; rawLength: number; softMask?: Buffer }
async function readImages(bytes: Buffer): Promise<Record<string, ImageInfo>> {
  const { PDFDocument, PDFName, PDFDict, PDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const xobjects = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const out: Record<string, ImageInfo> = {};
  for (const [name] of xobjects.entries()) {
    const stream = xobjects.lookup(name);
    if (!(stream instanceof PDFRawStream)) continue;
    const mask = stream.dict.lookup(PDFName.of('SMask'));
    out[name.toString().slice(1)] = {
      filter: stream.dict.lookup(PDFName.of('Filter'))?.toString() ?? '',
      rawLength: stream.contents.length,
      softMask: mask instanceof PDFRawStream ? inflateSync(mask.contents) : undefined,
    };
  }
  return out;
}

interface Mode { name: string; lossy: boolean; select: (page: Page) => Promise<void> }
const level = (label: string) => async (page: Page) => { await page.getByRole('button', { name: label }).click(); };
const MODES: Mode[] = [
  { name: 'Low', lossy: false, select: level('Low') },
  { name: 'Medium', lossy: true, select: level('Medium') },
  { name: 'High', lossy: true, select: level('High') },
  {
    name: 'Custom (36 DPI, quality 25)', lossy: true, select: async (page) => {
      await level('Custom')(page);
      await page.locator('#cp-dpi').fill('36');
      await page.locator('#cp-jpeg-quality').fill('25');
    },
  },
  {
    name: 'Target size, out of reach (1 KB)', lossy: true, select: async (page) => {
      await page.getByRole('button', { name: /Target size/ }).click();
      await page.getByLabel('Make the PDF no larger than').fill('1');
      await page.getByLabel('Size unit').selectOption('KB');
    },
  },
];

test.describe('Compress PDF — images under a soft mask keep their transparency', () => {
  test.setTimeout(120_000);

  let original: Buffer;
  let orig: Raster;
  let origImages: Record<string, ImageInfo>;

  test.beforeAll(async () => {
    original = await readFile(FIXTURE.pdfSoftMasked);
    orig = await renderPage(original);
    origImages = await readImages(original);
  });

  test('the fixture: clear corners show the page, black hidden beneath', () => {
    const { names, badge, badgePoints } = SOFT_MASK_PAGE;
    expect(Object.keys(origImages).sort()).toEqual(Object.values(names).sort());
    for (const name of Object.values(names)) expect(origImages[name].softMask, name).toBeDefined();
    // The clear corner of the RGB badge is the white page; its opaque middle is the photo.
    expect(maxChannelDiff(patch(orig, ...badgePoint(orig, badge, badgePoints.clear)), [255, 255, 255])).toBeLessThanOrEqual(1);
    expect(luma(patch(orig, ...badgePoint(orig, badge, badgePoints.opaque)))).toBeGreaterThan(60);
  });

  for (const mode of MODES) {
    test(`${mode.name}: every page pixel as light and as coloured as before, masks kept`, async ({ page }) => {
      await page.goto('/compress-pdf');
      await addSingleFileAndWait(page, FIXTURE.pdfSoftMasked);
      await mode.select(page);
      await page.getByTestId('tool-action').click();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
      const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
      assertPdf(bytes);
      expect(await countPdfPagesStrict(bytes)).toBe(1);
      expect(bytes.length).toBeLessThanOrEqual(original.length);
      console.log(`soft-masked fixture, ${mode.name}: ${original.length} → ${bytes.length} bytes`);

      // ── Rendered pixels (MuPDF) ─────────────────────────────────────────────
      const out = await renderPage(bytes);
      expect(meanLuma(out), 'the page is not darker').toBeGreaterThan(meanLuma(orig) - 1);
      expect(regionDiff(orig, out, 0, 0, orig.width, orig.height, 24), 'the page matches the original everywhere').toBeLessThan(16);
      const { badge, greyBadge, badgePoints } = SOFT_MASK_PAGE;
      for (const [label, box] of [['badge', badge], ['grey badge', greyBadge]] as const) {
        const at = (p: { x: number; y: number }) => badgePoint(orig, box, p);
        expect(maxChannelDiff(patch(out, ...at(badgePoints.clear)), patch(orig, ...at(badgePoints.clear))), `${label}: clear corner still shows the page`)
          .toBeLessThanOrEqual(2);
        expect(maxChannelDiff(patch(out, ...at(badgePoints.half)), patch(orig, ...at(badgePoints.half))), `${label}: half-transparent band blends as before`)
          .toBeLessThanOrEqual(10);
        // The whole badge, cell by cell, its edges included: no dark fringe.
        const x0 = box.x;
        const y0 = orig.height - (box.y + box.h);
        expect(regionDiff(orig, out, x0, y0, x0 + box.w, y0 + box.h, 12), `${label}: matches within JPEG softening`).toBeLessThan(10);
      }
      // The overlay: transparent parts show what lies beneath, not the black hidden there.
      const { points } = OVERLAY_PAGE;
      const pt = (p: { x: number; y: number }) => [p.x * out.width, p.y * out.height] as const;
      expect(maxChannelDiff(patch(out, ...pt(points.blank)), [255, 255, 255]), 'bare page under the overlay').toBeLessThanOrEqual(1);
      expect(maxChannelDiff(patch(out, ...pt(points.bandTransparent)), OVERLAY_PAGE.bandColour), 'band under the clear overlay').toBeLessThanOrEqual(2);
      for (const key of ['bandHalf', 'bandOpaque'] as const) {
        expect(maxChannelDiff(patch(out, ...pt(points[key])), patch(orig, ...pt(points[key]))), key).toBeLessThanOrEqual(8);
      }

      // ── Structure: each image keeps the very same soft mask ─────────────────
      const images = await readImages(bytes);
      for (const name of Object.values(SOFT_MASK_PAGE.names)) {
        expect.soft(images[name].softMask, `${name}: soft mask kept`).toBeDefined();
        expect.soft(images[name].softMask?.equals(origImages[name].softMask!), `${name}: soft mask unchanged`).toBe(true);
      }
      for (const name of [SOFT_MASK_PAGE.names.badge, SOFT_MASK_PAGE.names.greyBadge]) {
        if (mode.lossy) {
          expect.soft(images[name].filter, `${name}: re-encoded`).toBe('/DCTDecode');
          expect.soft(images[name].rawLength, `${name}: smaller`).toBeLessThan(origImages[name].rawLength);
        } else {
          expect.soft(images[name].filter, `${name}: untouched at Low`).toBe('/FlateDecode');
        }
      }

      // ── What the visitor is shown: the compare view's "Compressed" render (pdf.js) ──
      const after = page.getByTestId('compress-preview').getByAltText('After image');
      await expectImageRendered(after);
      const shown = await after.evaluate((el, at) => {
        const img = el as HTMLImageElement;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const i = (Math.floor(at.y * canvas.height) * canvas.width + Math.floor(at.x * canvas.width)) * 4;
        return { meanLuma: sum / (data.length / 4), band: [data[i], data[i + 1], data[i + 2]] as [number, number, number] };
      }, points.bandTransparent);
      expect(shown.meanLuma, 'the compare view shows a light page').toBeGreaterThan(meanLuma(orig) - 12);
      expect(maxChannelDiff(shown.band, OVERLAY_PAGE.bandColour)).toBeLessThan(20);
    });
  }
});
