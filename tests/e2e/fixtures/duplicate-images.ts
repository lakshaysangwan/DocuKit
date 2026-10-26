/**
 * Fixture: the same images embedded again and again as separate objects, as
 * many scanners and office exporters write them — a logo, a photo and a
 * transparent stamp on every page, each page carrying its own copy.
 *
 * Compress PDF stores each of those once. Two near-copies that must NOT be
 * merged sit beside them: the photo's samples under an inverting /Decode, and
 * the stamp with a different soft mask. Same bytes is not enough; what the
 * reader draws has to be the same.
 *
 * Seeded, so identical on every run. No Playwright import: unit tests build
 * the same document.
 */
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
  type PDFContext,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';

const PAGE: [number, number] = [595, 842];
export const DUPLICATE_PAGES = 3;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

const PHOTO_W = 320;
const PHOTO_H = 220;
const STAMP = 120;

/** Photo-like RGB samples: smooth tones plus noise, so Flate leaves it large. */
function photoSamples(): Uint8Array {
  const rand = seeded(7);
  const out = new Uint8Array(PHOTO_W * PHOTO_H * 3);
  for (let y = 0; y < PHOTO_H; y++) {
    for (let x = 0; x < PHOTO_W; x++) {
      for (let c = 0; c < 3; c++) {
        out[(y * PHOTO_W + x) * 3 + c] = clamp(160 + 70 * Math.sin((x + c * 30) / 21) * Math.cos((y - c * 20) / 17) + (rand() - 0.5) * 24);
      }
    }
  }
  return out;
}

function stampSamples(): { colour: Uint8Array; alpha: Uint8Array; alpha2: Uint8Array } {
  const colour = new Uint8Array(STAMP * STAMP * 3);
  const alpha = new Uint8Array(STAMP * STAMP);
  const alpha2 = new Uint8Array(STAMP * STAMP);
  const rand = seeded(8);
  for (let y = 0; y < STAMP; y++) {
    for (let x = 0; x < STAMP; x++) {
      const i = y * STAMP + x;
      const r = Math.hypot(x - STAMP / 2, y - STAMP / 2);
      colour.set([clamp(200 + (rand() - 0.5) * 30), 40, 40], i * 3);
      alpha[i] = r < 50 && r > 30 ? 255 : r <= 30 ? 90 : 0;
      alpha2[i] = r < 50 ? 255 : 0;
    }
  }
  return { colour, alpha, alpha2 };
}

function place(page: PDFPage, name: string, ref: PDFRef, x: number, y: number, w: number, h: number): void {
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

const image = (ctx: PDFContext, data: Uint8Array, w: number, h: number, dict: Record<string, unknown>) =>
  ctx.register(ctx.flateStream(data, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8, ...dict }));

/** Resource names on every page. */
export const DUPLICATE_NAMES = { photo: 'Photo', logo: 'Logo', stamp: 'Stamp', inverted: 'Inverted', stampOther: 'StampOther' } as const;

/**
 * Pages of text, each with its own copy of the photo (Flate), the logo
 * (`jpg`, a baseline JPEG) and the soft-masked stamp (its mask a copy too).
 * Page 1 also has the two near-copies that must stay separate. Without `jpg`
 * there is no logo (the unit tests have no JPEG encoder).
 */
export async function makeDuplicateImagesPdf(jpg?: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const photo = photoSamples();
  const { colour, alpha, alpha2 } = stampSamples();

  for (let p = 0; p < DUPLICATE_PAGES; p++) {
    const page = doc.addPage(PAGE);
    page.drawText(`Monthly statement — page ${p + 1}`, { x: 60, y: 780, size: 16, font, color: rgb(0, 0, 0) });
    for (let i = 0; i < 6; i++) {
      page.drawText(`Line ${i + 1}    ${(12.5 + i * 3.1 + p).toFixed(2)}`, { x: 60, y: 420 - i * 18, size: 11, font });
    }
    if (jpg) {
      const logo = await doc.embedJpg(jpg);
      await logo.embed();
      place(page, DUPLICATE_NAMES.logo, logo.ref, 60, 700, 120, 60);
    }
    place(page, DUPLICATE_NAMES.photo, image(ctx, photo, PHOTO_W, PHOTO_H, { ColorSpace: 'DeviceRGB' }), 60, 450, 320, 220);
    const mask = image(ctx, alpha, STAMP, STAMP, { ColorSpace: 'DeviceGray' });
    place(page, DUPLICATE_NAMES.stamp, image(ctx, colour, STAMP, STAMP, { ColorSpace: 'DeviceRGB', SMask: mask }), 420, 560, 120, 120);
    if (p === 0) {
      place(page, DUPLICATE_NAMES.inverted, image(ctx, photo, PHOTO_W, PHOTO_H, { ColorSpace: 'DeviceRGB', Decode: [1, 0, 1, 0, 1, 0] }), 60, 120, 160, 110);
      const other = image(ctx, alpha2, STAMP, STAMP, { ColorSpace: 'DeviceGray' });
      place(page, DUPLICATE_NAMES.stampOther, image(ctx, colour, STAMP, STAMP, { ColorSpace: 'DeviceRGB', SMask: other }), 420, 120, 120, 120);
    }
  }
  return doc.save();
}
