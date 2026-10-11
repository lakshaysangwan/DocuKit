/**
 * Fixture: every kind of embedded image that Compress PDF's lossy image pass
 * must not damage.
 *
 * Page 1 reproduces a real document that came out of Compress PDF almost
 * entirely black. Its structure is what HTML-to-PDF converters and annotation
 * tools produce: ordinary vector text on a white page, a few JPEG logos (one
 * with a soft mask, all with an identity /Decode array), and on top a
 * *full-page* RGB image that is transparent nearly everywhere — it carries both
 * a /SMask (8-bit alpha) and a /Mask (1-bit stencil), and the RGB samples under
 * the transparent pixels are black. Re-encode that image without its masks and
 * the hidden black becomes the page.
 *
 * Page 2 is a grid of small images, one per image kind, over a coloured
 * background: the kinds a naive "inflate, treat as 8-bit RGB/gray, write a JPEG"
 * pass gets wrong (inverted /Decode, PNG predictors, CMYK, palettes, spot
 * colours, colour-key and stencil masks, 1-bit data) next to the plain kinds
 * that are safe to recompress.
 *
 * Everything is drawn from a seeded generator, so the pixels are identical on
 * every run. Built with pdf-lib's low-level object API because its image
 * embedders cannot express most of these dictionaries. No Playwright import:
 * the unit tests build the same document.
 */
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFStream,
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

type Dict = Record<string, unknown>;
type Rgb = [number, number, number];

const PAGE: [number, number] = [595, 842];

/** mulberry32 — small, fast, and the same sequence everywhere. */
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

/**
 * A smooth, bright-biased tone with a little noise: photo-like, so a JPEG of it
 * is far smaller than the Flate stream (the lossy pass only replaces an image
 * when that is true), and asymmetric about mid-grey, so an inverted or
 * mis-decoded copy is unmistakable.
 */
function tone(x: number, y: number, phase: number, rand: () => number): number {
  return clamp(165 + 60 * Math.sin((x + phase) / 19) * Math.cos((y - phase) / 23) + (rand() - 0.5) * 10);
}

function imageStream(ctx: PDFContext, data: Uint8Array, width: number, height: number, dict: Dict): PDFRef {
  return ctx.register(
    ctx.flateStream(data, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ...dict })
  );
}

/** Register `ref` under an exact resource name and paint it into a rectangle. */
function place(page: PDFPage, name: string, ref: PDFRef, x: number, y: number, w: number, h: number): void {
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(w, 0, 0, h, x, y),
    drawObject(name),
    popGraphicsState()
  );
}

/** Pack one bit per pixel, rows padded to a byte, most significant bit first. */
function packBits(width: number, height: number, bit: (x: number, y: number) => boolean): Uint8Array {
  const stride = Math.ceil(width / 8);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bit(x, y)) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

// ── Page 1: the full-page transparent overlay ────────────────────────────────

const OVERLAY_W = 396;
const OVERLAY_H = 560;
/** Image rows the coloured band sits under, and the rows the test patches use. */
const BAND_ROWS: [number, number] = [427, 507];
const PATCH_ROWS: [number, number] = [440, 495];

/** Where the tests sample page 1, as fractions of the page from its top-left. */
export const OVERLAY_PAGE = {
  /** Fill of the band the overlay's patches sit over. */
  bandColour: [51, 153, 204] as Rgb,
  /** Nominal colour of the overlay's opaque and half-transparent patches. */
  patchColour: [220, 60, 30] as Rgb,
  points: {
    /** Bare page under a fully transparent part of the overlay. */
    blank: { x: 0.5, y: 0.65 },
    /** Band under alpha 0 — must show the band, not the black hidden beneath. */
    bandTransparent: { x: 66 / OVERLAY_W, y: 467 / OVERLAY_H },
    /** Band under alpha 128 — a blend of band and patch. */
    bandHalf: { x: 198 / OVERLAY_W, y: 467 / OVERLAY_H },
    /** Band under alpha 255 — the patch. */
    bandOpaque: { x: 330 / OVERLAY_W, y: 467 / OVERLAY_H },
  },
  /** Resource names of the images on the page. */
  names: { overlay: 'I0', logo: 'Logo', logoMasked: 'LogoMasked' },
} as const;

function addOverlay(ctx: PDFContext, page: PDFPage): void {
  const rand = seeded(1);
  const W = OVERLAY_W;
  const H = OVERLAY_H;
  // Zero-initialised: RGB under every transparent pixel is black, as exporters leave it.
  const colour = new Uint8Array(W * H * 3);
  const alpha = new Uint8Array(W * H);
  const put = (x: number, y: number, c: Rgb, a: number) => {
    const i = y * W + x;
    colour.set(c, i * 3);
    alpha[i] = a;
  };
  const navy: Rgb = [20, 30, 90];

  // A solid "stamp" bar, and a speckled region whose alpha is noisy enough that
  // the mask stream itself is large — a mask is an image XObject too, and must
  // not be mistaken for a grey photo and turned into a JPEG.
  for (let y = 60; y < 76; y++) for (let x = 40; x < 200; x++) put(x, y, navy, 255);
  for (let y = 250; y < 330; y++) {
    for (let x = 40; x < 360; x++) if (rand() < 0.15) put(x, y, navy, 64 + Math.floor(rand() * 192));
  }
  // Over the coloured band: left third stays transparent, middle third is half
  // transparent, right third is an opaque, noisy patch.
  const [pr, pg, pb] = OVERLAY_PAGE.patchColour;
  for (let y = PATCH_ROWS[0]; y < PATCH_ROWS[1]; y++) {
    for (let x = 132; x < W; x++) {
      const wobble = 12 * Math.sin(x / 9) * Math.cos(y / 7) + (rand() - 0.5) * 16;
      put(x, y, [clamp(pr + wobble), clamp(pg + wobble), clamp(pb + wobble)], x < 264 ? 128 : 255);
    }
  }

  const softMask = imageStream(ctx, alpha, W, H, { BitsPerComponent: 8, ColorSpace: 'DeviceGray' });
  // Stencil: a set bit masks the pixel out.
  const stencil = imageStream(ctx, packBits(W, H, (x, y) => alpha[y * W + x] === 0), W, H, {
    BitsPerComponent: 1,
    ImageMask: true,
  });
  const overlay = imageStream(ctx, colour, W, H, {
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
    SMask: softMask,
    Mask: stencil,
    Interpolate: true,
  });
  place(page, OVERLAY_PAGE.names.overlay, overlay, 0, 0, PAGE[0], PAGE[1]);
}

async function addOverlayPage(doc: PDFDocument, jpgs?: { logo: Uint8Array; logoMasked: Uint8Array }): Promise<void> {
  const ctx = doc.context;
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Vector content: what the page really consists of.
  page.drawText('Laboratory report (synthetic)', { x: 150, y: 790, size: 16, font, color: rgb(0, 0, 0) });
  for (let i = 0; i < 10; i++) {
    page.drawText(`Analyte ${i + 1}    ${(4.2 + i * 1.37).toFixed(2)}    reference 3.50 - 17.00`, {
      x: 60, y: 690 - i * 20, size: 11, font, color: rgb(0.1, 0.1, 0.1),
    });
  }
  for (const y of [706, 484]) {
    page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: rgb(0, 0, 0) });
  }
  for (const x of [50, 545]) {
    page.drawLine({ start: { x, y: 484 }, end: { x, y: 706 }, thickness: 1, color: rgb(0, 0, 0) });
  }
  const [br, bg, bb] = OVERLAY_PAGE.bandColour;
  const top = PAGE[1] * (1 - BAND_ROWS[0] / OVERLAY_H);
  const bottom = PAGE[1] * (1 - BAND_ROWS[1] / OVERLAY_H);
  page.drawRectangle({ x: 0, y: bottom, width: PAGE[0], height: top - bottom, color: rgb(br / 255, bg / 255, bb / 255) });

  if (jpgs) {
    // Both logos carry an explicit identity /Decode, as the source document's
    // do. It changes nothing, so it must not stop the plain logo being
    // recompressed — that is where this file's savings come from.
    const identityDecode = () => ctx.obj([0, 1, 0, 1, 0, 1]);

    const logo = await doc.embedJpg(jpgs.logo);
    await logo.embed();
    ctx.lookup(logo.ref, PDFStream).dict.set(PDFName.of('Decode'), identityDecode());
    place(page, OVERLAY_PAGE.names.logo, logo.ref, 40, 770, 90, 60);

    const masked = await doc.embedJpg(jpgs.logoMasked);
    await masked.embed();
    const maskedDict = ctx.lookup(masked.ref, PDFStream).dict;
    maskedDict.set(PDFName.of('Decode'), identityDecode());
    maskedDict.set(
      PDFName.of('SMask'),
      imageStream(ctx, new Uint8Array(100 * 100).fill(255), 100, 100, { BitsPerComponent: 8, ColorSpace: 'DeviceGray' })
    );
    place(page, OVERLAY_PAGE.names.logoMasked, masked.ref, 480, 762, 54, 72);
  }

  // Last, so it lies over everything — exactly as in the source document.
  addOverlay(ctx, page);
}

// ── Page 2: one tile per image kind ──────────────────────────────────────────

const TILE = 128;
const TILE_PT = 110;

export interface SweepTile {
  /** Resource name on page 2. */
  name: string;
  /**
   * `reencoded`: safe to recompress, and expected to become a JPEG at every
   * lossy setting. `untouched`: must come out with the same dictionary and the
   * same decoded bytes.
   */
  expect: 'reencoded' | 'untouched';
  /** What makes this kind what it is. */
  why: string;
  /** Position on the page in points, origin bottom-left. */
  x: number;
  y: number;
  size: number;
}

type TileSpec = Pick<SweepTile, 'name' | 'expect' | 'why'> & { build: (ctx: PDFContext) => PDFRef };

const N = TILE * TILE;
const inDisc = (x: number, y: number) => (x - TILE / 2) ** 2 + (y - TILE / 2) ** 2 < (TILE / 3) ** 2;

/** Interleaved `channels`-per-pixel tone data. */
function plane(channels: number, seed: number, map: (v: number, c: number) => number = (v) => v): Uint8Array {
  const rand = seeded(seed);
  const out = new Uint8Array(N * channels);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      for (let c = 0; c < channels; c++) out[(y * TILE + x) * channels + c] = map(tone(x, y, c * 40, rand), c);
    }
  }
  return out;
}

/** PNG "Sub" filtering of 8-bit RGB rows — what /Predictor 15 streams contain. */
function pngSubFilter(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const row = width * bpp;
  const out = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (row + 1)] = 1; // filter type: Sub
    for (let i = 0; i < row; i++) {
      const left = i >= bpp ? data[y * row + i - bpp] : 0;
      out[y * (row + 1) + 1 + i] = (data[y * row + i] - left) & 0xff;
    }
  }
  return out;
}

const rgb8 = { BitsPerComponent: 8, ColorSpace: 'DeviceRGB' };

const TILE_SPECS: TileSpec[] = [
  {
    name: 'PlainRgb', expect: 'reencoded', why: '8-bit DeviceRGB, FlateDecode, no extras',
    build: (ctx) => imageStream(ctx, plane(3, 11), TILE, TILE, rgb8),
  },
  {
    name: 'PlainGray', expect: 'reencoded', why: '8-bit DeviceGray, FlateDecode, no extras',
    build: (ctx) => imageStream(ctx, plane(1, 12), TILE, TILE, { BitsPerComponent: 8, ColorSpace: 'DeviceGray' }),
  },
  {
    name: 'CalRgb', expect: 'reencoded', why: 'three-component CIE-based space; the samples pass through, so the space is kept',
    build: (ctx) => imageStream(ctx, plane(3, 13), TILE, TILE, {
      BitsPerComponent: 8,
      ColorSpace: ['CalRGB', {
        WhitePoint: [0.9505, 1, 1.089],
        Gamma: [1.4, 1.4, 1.4],
        Matrix: [0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505],
      }],
    }),
  },
  {
    name: 'IdentityDecode', expect: 'reencoded', why: '/Decode [0 1 0 1 0 1] is the default mapping written out',
    build: (ctx) => imageStream(ctx, plane(3, 14), TILE, TILE, { ...rgb8, Decode: [0, 1, 0, 1, 0, 1] }),
  },
  {
    name: 'InvertedDecode', expect: 'untouched', why: '/Decode [1 0] inverts the samples',
    build: (ctx) => imageStream(ctx, plane(1, 15), TILE, TILE, { BitsPerComponent: 8, ColorSpace: 'DeviceGray', Decode: [1, 0] }),
  },
  {
    name: 'Predictor', expect: 'untouched', why: '/DecodeParms /Predictor 15: the inflated bytes are PNG-filtered rows, not pixels',
    build: (ctx) => imageStream(ctx, pngSubFilter(plane(3, 16), TILE, TILE, 3), TILE, TILE, {
      ...rgb8, DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: TILE },
    }),
  },
  {
    name: 'Cmyk', expect: 'untouched', why: 'DeviceCMYK: converting to RGB shifts the colours',
    build: (ctx) => imageStream(ctx, plane(4, 17, (v, c) => (c === 3 ? 0 : 255 - v)), TILE, TILE, { BitsPerComponent: 8, ColorSpace: 'DeviceCMYK' }),
  },
  {
    name: 'IndexedRgb', expect: 'untouched', why: 'samples are palette indices (RGB palette)',
    build: (ctx) => {
      let palette = '';
      for (let i = 0; i < 256; i++) {
        palette += [255 - i, (i * 3) & 0xff, 128 + (i >> 1)].map((v) => v.toString(16).padStart(2, '0')).join('');
      }
      return imageStream(ctx, plane(1, 18), TILE, TILE, {
        BitsPerComponent: 8, ColorSpace: ['Indexed', 'DeviceRGB', 255, PDFHexString.of(palette)],
      });
    },
  },
  {
    name: 'IndexedGray', expect: 'untouched', why: 'samples are palette indices (grey palette, reversed)',
    build: (ctx) => {
      let palette = '';
      for (let i = 0; i < 256; i++) palette += (255 - i).toString(16).padStart(2, '0');
      return imageStream(ctx, plane(1, 19), TILE, TILE, {
        BitsPerComponent: 8, ColorSpace: ['Indexed', 'DeviceGray', 255, PDFHexString.of(palette)],
      });
    },
  },
  {
    name: 'Separation', expect: 'untouched', why: 'spot colour: a sample is an amount of ink, so 255 is dark',
    build: (ctx) => imageStream(ctx, plane(1, 20, (v) => 255 - v), TILE, TILE, {
      BitsPerComponent: 8,
      ColorSpace: ['Separation', 'SpotInk', 'DeviceGray', { FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 }],
    }),
  },
  {
    name: 'ColourKey', expect: 'untouched', why: '/Mask array: pure black is keyed out, and JPEG would no longer leave it pure',
    build: (ctx) => {
      const data = plane(3, 21);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) if (inDisc(x, y)) data.fill(0, (y * TILE + x) * 3, (y * TILE + x) * 3 + 3);
      }
      return imageStream(ctx, data, TILE, TILE, { ...rgb8, Mask: [0, 0, 0, 0, 0, 0] });
    },
  },
  {
    name: 'StencilMasked', expect: 'untouched', why: '/Mask stream: a 1-bit stencil cuts a hole in the image',
    build: (ctx) => {
      const data = plane(3, 22);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) if (inDisc(x, y)) data.fill(0, (y * TILE + x) * 3, (y * TILE + x) * 3 + 3);
      }
      const stencil = imageStream(ctx, packBits(TILE, TILE, inDisc), TILE, TILE, { BitsPerComponent: 1, ImageMask: true });
      return imageStream(ctx, data, TILE, TILE, { ...rgb8, Mask: stencil });
    },
  },
  {
    name: 'OneBit', expect: 'untouched', why: '1 bit per component',
    build: (ctx) => {
      const rand = seeded(23);
      const bits = packBits(TILE, TILE, (x, y) => ((x >> 4) + (y >> 4)) % 2 === 0 || rand() < 0.3);
      return imageStream(ctx, bits, TILE, TILE, { BitsPerComponent: 1, ColorSpace: 'DeviceGray' });
    },
  },
  {
    name: 'StencilPainted', expect: 'untouched', why: '/ImageMask true: a stencil painted in the current fill colour, as in scanned text',
    build: (ctx) => {
      const rand = seeded(24);
      const bits = packBits(TILE, TILE, (x, y) => inDisc(x, y) || rand() < 0.3);
      return imageStream(ctx, bits, TILE, TILE, { BitsPerComponent: 1, ImageMask: true });
    },
  },
];

const tilePosition = (i: number) => ({
  x: 40 + (i % 4) * 135,
  y: PAGE[1] - 170 - Math.floor(i / 4) * 150,
  size: TILE_PT,
});

/** The tiles on page 2, in order, with where each one is drawn. */
export const SWEEP_TILES: SweepTile[] = TILE_SPECS.map(({ name, expect, why }, i) => ({
  name, expect, why, ...tilePosition(i),
}));

function addSweepPage(doc: PDFDocument): void {
  const page = doc.addPage(PAGE);
  // A coloured ground, so a hole in an image shows the page through it.
  page.drawRectangle({ x: 0, y: 0, width: PAGE[0], height: PAGE[1], color: rgb(0.8, 0.9, 0.86) });
  // Fill colour for the painted stencil.
  page.drawRectangle({ x: 0, y: 0, width: 1, height: 1, color: rgb(0.5, 0.1, 0.4) });
  TILE_SPECS.forEach((tile, i) => {
    const { x, y, size } = tilePosition(i);
    place(page, tile.name, tile.build(doc.context), x, y, size, size);
  });
}

/**
 * The two-page fixture. `jpgs` are any two baseline JPEGs (the generator passes
 * the canvas-made photos); without them page 1 has no logos, which is all the
 * unit tests need.
 */
export async function makeMaskedImagesPdf(jpgs?: { logo: Uint8Array; logoMasked: Uint8Array }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await addOverlayPage(doc, jpgs);
  addSweepPage(doc);
  return doc.save();
}

/**
 * Page 1's overlay alone: a document in which every image is masked or is a
 * mask, so the lossy pass has nothing it may touch.
 */
export async function makeOnlyMaskedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await addOverlayPage(doc);
  return doc.save();
}
