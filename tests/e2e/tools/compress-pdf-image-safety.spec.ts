import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { PDFRawStream as RawStream } from 'pdf-lib';
import { FIXTURE } from '../fixtures/generate';
import { OVERLAY_PAGE, SWEEP_TILES } from '../fixtures/masked-images';
import {
  addSingleFileAndWait,
  expectDownload,
  expectImageRendered,
  assertPdf,
  countPdfPagesStrict,
} from '../helpers/harness';

/**
 * Compress PDF must never change what a page looks like beyond JPEG softening.
 *
 * It once did, badly: a real report came out almost entirely black, because a
 * full-page image that was transparent nearly everywhere was re-encoded as an
 * opaque JPEG without its /SMask and /Mask — and the pixels hidden under the
 * transparency were black. tests/e2e/fixtures/masked-images.ts rebuilds that
 * structure (page 1) and adds one image of every other kind a naive
 * recompressor mishandles (page 2).
 *
 * Every assertion here is on *rendered pixels* of the downloaded file, drawn by
 * MuPDF in Node — a different engine from the pdf.js preview in the page — and
 * compared with the same render of the original. Checking only that a valid,
 * smaller PDF came back is what let the black page through.
 */

type Rgb = [number, number, number];
interface Raster { width: number; height: number; n: number; data: Uint8Array }

/** Render one page at 72 DPI (one pixel per point) with MuPDF. */
async function renderPage(bytes: Buffer, pageIndex: number): Promise<Raster> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(pageIndex);
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return {
      width: pix.getWidth(),
      height: pix.getHeight(),
      n: pix.getNumberOfComponents(),
      data: Uint8Array.from(pix.getPixels()),
    };
  } finally {
    pix.destroy();
    page.destroy();
    doc.destroy();
  }
}

const luma = ([r, g, b]: Rgb) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Mean colour of a pixel rectangle (clamped to the raster). */
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

/** Mean colour of a 5×5 patch around a point given as page fractions. */
function sample(r: Raster, at: { x: number; y: number }): Rgb {
  const cx = at.x * r.width;
  const cy = at.y * r.height;
  return meanRgb(r, cx - 2, cy - 2, cx + 3, cy + 3);
}

/** Share of pixels that are light (luma above 192). */
function lightShare(r: Raster): number {
  let light = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    if (luma([r.data[i * r.n], r.data[i * r.n + 1], r.data[i * r.n + 2]]) > 192) light++;
  }
  return light / (r.width * r.height);
}

const maxChannelDiff = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/**
 * Largest difference in mean colour between two renders over a grid of cells
 * covering a rectangle. Cell means rather than single pixels: JPEG softening
 * moves individual pixels but not the average of a block, while a lost mask, an
 * inverted image or a mis-decoded one moves whole blocks a long way.
 */
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

interface ImageInfo {
  filter: string;
  colorSpace: string;
  width: number;
  /** Dictionary keys other than /Length, sorted. */
  keys: string[];
  /** Encoded stream length. */
  rawLength: number;
  /** Decoded bytes for Flate streams, the stream itself otherwise. */
  payload: Buffer;
  softMask?: Buffer;
  stencilMask?: Buffer;
}

/** The image XObjects of one page by resource name, read with a real parser. */
async function readPageImages(bytes: Buffer, pageIndex: number): Promise<Record<string, ImageInfo>> {
  const { PDFDocument, PDFName, PDFDict, PDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const xobjects = doc.getPages()[pageIndex].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);

  const payload = (s: RawStream): Buffer =>
    s.dict.lookup(PDFName.of('Filter'))?.toString() === '/FlateDecode'
      ? inflateSync(s.contents)
      : Buffer.from(s.contents);
  const maskPayload = (s: RawStream, key: string): Buffer | undefined => {
    const mask = s.dict.lookup(PDFName.of(key));
    return mask instanceof PDFRawStream ? payload(mask) : undefined;
  };

  const out: Record<string, ImageInfo> = {};
  for (const [name] of xobjects.entries()) {
    const stream = xobjects.lookup(name);
    if (!(stream instanceof PDFRawStream)) continue;
    out[name.toString().slice(1)] = {
      filter: stream.dict.lookup(PDFName.of('Filter'))?.toString() ?? '',
      colorSpace: stream.dict.lookup(PDFName.of('ColorSpace'))?.toString() ?? '',
      width: Number(stream.dict.lookup(PDFName.of('Width'))?.toString()),
      keys: stream.dict.keys().map((k) => k.toString()).filter((k) => k !== '/Length').sort(),
      rawLength: stream.contents.length,
      payload: payload(stream),
      softMask: maskPayload(stream, 'SMask'),
      stencilMask: maskPayload(stream, 'Mask'),
    };
  }
  return out;
}

/**
 * An image came through with the same dictionary shape and the same data. Soft
 * assertions, so one run names every image that was damaged rather than the first.
 */
function expectUntouched(out: ImageInfo | undefined, orig: ImageInfo, label: string): void {
  expect.soft(out, `${label}: image is still on the page`).toBeDefined();
  if (!out) return;
  const same = (a?: Buffer, b?: Buffer) => (a && b ? a.equals(b) : a === b);
  expect.soft(out.filter, `${label}: filter`).toBe(orig.filter);
  expect.soft(out.keys, `${label}: dictionary keys`).toEqual(orig.keys);
  expect.soft(same(out.payload, orig.payload), `${label}: image data is unchanged`).toBe(true);
  expect.soft(same(out.softMask, orig.softMask), `${label}: soft mask is unchanged`).toBe(true);
  expect.soft(same(out.stencilMask, orig.stencilMask), `${label}: stencil mask is unchanged`).toBe(true);
}

interface Mode {
  name: string;
  /** Does this mode run the lossy image pass at all? */
  lossy: boolean;
  select: (page: Page) => Promise<void>;
  /** Target size in KB (Target size mode only). */
  targetKb?: number;
  /** Whether that target is out of reach. */
  missesTarget?: boolean;
}

const level = (label: string) => async (page: Page) => {
  await page.getByRole('button', { name: label }).click();
};
const target = (kb: number) => async (page: Page) => {
  await page.getByRole('button', { name: /Target size/ }).click();
  await page.getByLabel('Make the PDF no larger than').fill(String(kb));
  await page.getByLabel('Size unit').selectOption('KB');
};

const custom = (dpi: number, quality: number) => async (page: Page) => {
  await level('Custom')(page);
  await page.locator('#cp-dpi').fill(String(dpi));
  await page.locator('#cp-jpeg-quality').fill(String(quality));
};

/**
 * Between what the harshest lossy step (about 249 KB) and the gentlest (about
 * 276 KB) make of the fixture, so reaching it takes the bisection, not just the
 * first or last pass. Most of the file is images that must stay untouched,
 * which is why that range is narrow.
 */
const REACHABLE_TARGET_KB = 262;

const MODES: Mode[] = [
  { name: 'Low', lossy: false, select: level('Low') },
  { name: 'Medium', lossy: true, select: level('Medium') },
  { name: 'High', lossy: true, select: level('High') },
  { name: 'Custom (36 DPI, quality 25)', lossy: true, select: custom(36, 25) },
  // Out of reach, so the harshest step of the ladder is what gets delivered —
  // the setting the black page was first seen at.
  { name: 'Target size, out of reach (1 KB)', lossy: true, select: target(1), targetKb: 1, missesTarget: true },
  { name: `Target size, reachable (${REACHABLE_TARGET_KB} KB)`, lossy: true, select: target(REACHABLE_TARGET_KB), targetKb: REACHABLE_TARGET_KB },
];

async function compress(page: Page, fixture: string, mode: Mode): Promise<Buffer> {
  await page.goto('/compress-pdf');
  await addSingleFileAndWait(page, fixture);
  await mode.select(page);
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 90_000 });
  const { bytes } = await expectDownload(page, () => page.getByTestId('download-button').click());
  assertPdf(bytes);
  return bytes;
}

/**
 * Mean luma and a few sampled colours of the "Compressed" half of the
 * before/after slider — the pdf.js render of the very bytes that get downloaded.
 */
async function previewStats(page: Page, points: Record<string, { x: number; y: number }>) {
  const after = page.getByTestId('compress-preview').getByAltText('After image');
  await expectImageRendered(after);
  return after.evaluate((el, pts) => {
    const img = el as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const samples: Record<string, [number, number, number]> = {};
    for (const [key, p] of Object.entries(pts)) {
      const i = (Math.floor(p.y * canvas.height) * canvas.width + Math.floor(p.x * canvas.width)) * 4;
      samples[key] = [data[i], data[i + 1], data[i + 2]];
    }
    return { meanLuma: sum / (data.length / 4), samples };
  }, points);
}

test.describe('Compress PDF — pages keep their appearance', () => {
  // Several full compression passes in Target size mode, plus two renders.
  test.setTimeout(120_000);

  let original: Buffer;
  let origPages: Raster[];
  let origImages: Record<string, ImageInfo>[];

  test.beforeAll(async () => {
    original = await readFile(FIXTURE.pdfMaskedImages);
    origPages = [await renderPage(original, 0), await renderPage(original, 1)];
    origImages = [await readPageImages(original, 0), await readPageImages(original, 1)];
  });

  test('the fixture itself is a light page with a transparent overlay', () => {
    // Guards the oracle: if the original did not render this way, comparing the
    // output against it would prove nothing.
    const page1 = origPages[0];
    expect(lightShare(page1)).toBeGreaterThan(0.7);
    expect(maxChannelDiff(sample(page1, OVERLAY_PAGE.points.blank), [255, 255, 255])).toBeLessThanOrEqual(1);
    expect(maxChannelDiff(sample(page1, OVERLAY_PAGE.points.bandTransparent), OVERLAY_PAGE.bandColour)).toBeLessThanOrEqual(2);
    // The opaque patch hides the band; the half-transparent one sits between the two.
    const opaque = sample(page1, OVERLAY_PAGE.points.bandOpaque);
    const half = sample(page1, OVERLAY_PAGE.points.bandHalf);
    expect(maxChannelDiff(opaque, OVERLAY_PAGE.patchColour)).toBeLessThan(30);
    expect(half[0]).toBeGreaterThan(OVERLAY_PAGE.bandColour[0] + 40);
    expect(half[0]).toBeLessThan(opaque[0] - 40);

    const overlay = origImages[0][OVERLAY_PAGE.names.overlay];
    expect(overlay.softMask, 'overlay has a soft mask').toBeDefined();
    expect(overlay.stencilMask, 'overlay has a stencil mask').toBeDefined();
    // Large enough that the lossy pass does not pass over them for being tiny.
    expect(overlay.rawLength).toBeGreaterThan(1024);
    expect(SWEEP_TILES.map((t) => t.name).sort()).toEqual(Object.keys(origImages[1]).sort());
  });

  for (const mode of MODES) {
    test(`${mode.name}: the transparent overlay page stays light and the masks survive`, async ({ page }) => {
      const bytes = await compress(page, FIXTURE.pdfMaskedImages, mode);
      expect(await countPdfPagesStrict(bytes)).toBe(2);
      expect(bytes.length, 'output is not larger than the input').toBeLessThanOrEqual(original.length);

      // ── Rendered pixels of the downloaded file (MuPDF) ──────────────────────
      const out = await renderPage(bytes, 0);
      const orig = origPages[0];
      expect(lightShare(out), 'page 1 is predominantly light, as the original is')
        .toBeGreaterThan(lightShare(orig) - 0.02);
      const { points } = OVERLAY_PAGE;
      expect(maxChannelDiff(sample(out, points.blank), [255, 255, 255]), 'bare page under the overlay is white')
        .toBeLessThanOrEqual(1);
      expect(
        maxChannelDiff(sample(out, points.bandTransparent), OVERLAY_PAGE.bandColour),
        'transparent part of the overlay shows the band colour beneath it, not black',
      ).toBeLessThanOrEqual(2);
      for (const key of ['bandHalf', 'bandOpaque'] as const) {
        expect(maxChannelDiff(sample(out, points[key]), sample(orig, points[key])), `${key} matches the original`)
          .toBeLessThanOrEqual(2);
      }
      // The whole page, block by block. The only lossy thing on it is the plain logo.
      expect(regionDiff(orig, out, 0, 0, orig.width, orig.height, 24), 'page 1 matches the original everywhere')
        .toBeLessThan(16);

      // ── Structure: the overlay and both masks are the same data ─────────────
      const images = await readPageImages(bytes, 0);
      const { names } = OVERLAY_PAGE;
      expectUntouched(images[names.overlay], origImages[0][names.overlay], 'overlay');
      expectUntouched(images[names.logoMasked], origImages[0][names.logoMasked], 'soft-masked JPEG logo');
      if (mode.lossy) {
        // …while the plain JPEG logo, identity /Decode and all, is still recompressed.
        expect(images[names.logo].filter).toBe('/DCTDecode');
        expect(images[names.logo].rawLength, 'plain logo is recompressed').toBeLessThan(origImages[0][names.logo].rawLength);
        expect(bytes.length, 'output is smaller than the input').toBeLessThan(original.length);
      }

      // ── What the user is shown: the slider's "Compressed" render (pdf.js) ───
      const preview = await previewStats(page, { bandTransparent: points.bandTransparent, blank: points.blank });
      expect(preview.meanLuma, 'compare slider shows a light page').toBeGreaterThan(190);
      // The preview is a JPEG data URL, hence the looser tolerance.
      expect(maxChannelDiff(preview.samples.bandTransparent, OVERLAY_PAGE.bandColour)).toBeLessThan(20);
      expect(maxChannelDiff(preview.samples.blank, [255, 255, 255])).toBeLessThan(12);

      // ── Target size mode reports honestly either way ────────────────────────
      if (mode.targetKb !== undefined) {
        if (mode.missesTarget) {
          await expect(page.getByTestId('target-missed')).toBeVisible();
        } else {
          expect(bytes.length).toBeLessThanOrEqual(mode.targetKb * 1024);
          await expect(page.getByTestId('target-missed')).toHaveCount(0);
        }
      }
    });

    test(`${mode.name}: every image kind renders as it did before`, async ({ page }) => {
      const bytes = await compress(page, FIXTURE.pdfMaskedImages, mode);
      const out = await renderPage(bytes, 1);
      const orig = origPages[1];
      const images = await readPageImages(bytes, 1);

      for (const tile of SWEEP_TILES) {
        const label = `${tile.name} (${tile.why})`;
        // Tile rectangle in render pixels: one per point, y flipped, inset to
        // stay clear of resampling at the tile's edge.
        const inset = 4;
        const x0 = tile.x + inset;
        const y0 = orig.height - (tile.y + tile.size) + inset;
        const diff = regionDiff(orig, out, x0, y0, x0 + tile.size - 2 * inset, y0 + tile.size - 2 * inset, 4);

        if (tile.expect === 'untouched' || !mode.lossy) {
          expect.soft(diff, `${label}: renders identically`).toBeLessThanOrEqual(1);
          expectUntouched(images[tile.name], origImages[1][tile.name], label);
        } else {
          // Recompressed: same picture within JPEG softening, and really a JPEG
          // now — the safe kinds must not be skipped along with the unsafe ones.
          expect.soft(diff, `${label}: renders the same within JPEG tolerance`).toBeLessThan(14);
          expect.soft(images[tile.name].filter, `${label}: is recompressed`).toBe('/DCTDecode');
          expect.soft(images[tile.name].rawLength, `${label}: is smaller`).toBeLessThan(origImages[1][tile.name].rawLength);
          // Grey becomes RGB (the JPEG written has three components); a
          // three-component space is carried over, not flattened to DeviceRGB.
          const space = origImages[1][tile.name].colorSpace;
          expect.soft(images[tile.name].colorSpace, `${label}: colour space`).toBe(space === '/DeviceGray' ? '/DeviceRGB' : space);
        }
      }
      // And the page as a whole, so nothing between the tiles changed either.
      expect(regionDiff(orig, out, 0, 0, orig.width, orig.height, 24)).toBeLessThan(14);
    });
  }

  test('Custom: a lower DPI downsamples JPEGs even at a high JPEG quality', async ({ page }) => {
    // Quality 90+ used to skip JPEGs outright, so the DPI slider did nothing to them.
    const bytes = await compress(page, FIXTURE.pdfMaskedImages, { name: 'Custom (36 DPI, quality 95)', lossy: true, select: custom(36, 95) });
    const logo = (await readPageImages(bytes, 0))[OVERLAY_PAGE.names.logo];
    const before = origImages[0][OVERLAY_PAGE.names.logo];
    expect(logo.width).toBeLessThan(before.width);
    expect(logo.rawLength).toBeLessThan(before.rawLength);
    const out = await renderPage(bytes, 0);
    expect(regionDiff(origPages[0], out, 0, 0, out.width, out.height, 24)).toBeLessThan(16);
  });
});

test.describe('Compress PDF — a document with nothing safe to recompress', () => {
  test.setTimeout(120_000);

  // Every image is masked or is a mask, so the lossy pass may touch none of
  // them. That must be an ordinary result — not an error, not an endless search
  // for a target that image quality can never reach.
  for (const mode of MODES.filter((m) => m.lossy && (m.name === 'High' || m.missesTarget))) {
    test(`${mode.name}: returns a valid, unchanged-looking PDF`, async ({ page }) => {
      const original = await readFile(FIXTURE.pdfOnlyMasked);
      const bytes = await compress(page, FIXTURE.pdfOnlyMasked, mode);
      expect(await countPdfPagesStrict(bytes)).toBe(1);
      expect(bytes.length).toBeLessThanOrEqual(original.length);

      const orig = await renderPage(original, 0);
      const out = await renderPage(bytes, 0);
      expect(regionDiff(orig, out, 0, 0, orig.width, orig.height, 24), 'renders identically').toBeLessThanOrEqual(1);

      const overlay = OVERLAY_PAGE.names.overlay;
      expectUntouched((await readPageImages(bytes, 0))[overlay], (await readPageImages(original, 0))[overlay], 'overlay');

      if (mode.missesTarget) await expect(page.getByTestId('target-missed')).toBeVisible();
      await expect(page.getByText(/Before:/)).toBeVisible();
    });
  }
});
