import { describe, it, expect, vi } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { PDFDocument, PDFName, PDFDict, PDFRef, type PDFContext } from 'pdf-lib';
import { compressPdf, planImagePass, replacementImageDict, readJpegFrame } from './pdf-compress';
import { makeMaskedImagesPdf, makeOnlyMaskedPdf, OVERLAY_PAGE, SWEEP_TILES } from '../../tests/e2e/fixtures/masked-images';

/**
 * The lossy image pass turned a real document's pages black by re-encoding an
 * image it did not understand. What it may touch is now an allow-list, and the
 * decision is a pure function over the image dictionaries — so it is pinned
 * down here, shape by shape, without a browser. The rendered-pixel proof that
 * the decisions are the right ones is tests/e2e/tools/compress-pdf-image-safety.spec.ts,
 * which compresses the same fixture document.
 */

// qpdf is WebAssembly fetched over HTTP; the structural pass is not under test.
vi.mock('../workers/qpdf-helper', () => ({ qpdfCompress: async (bytes: Uint8Array) => bytes }));

const toArrayBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Plan for the image registered under `name` on a page. */
async function plansByName(bytes: Uint8Array, pageIndex: number) {
  const doc = await PDFDocument.load(bytes);
  const planned = planImagePass(pdfLib, doc.context);
  const xobjects = doc.getPages()[pageIndex].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const byName = (name: string) => planned.find((p) => p.ref === xobjects.get(PDFName.of(name)))!;
  return { doc, planned, byName };
}

/**
 * Plan for one image: a plain 8-bit DeviceRGB JPEG with `dict` laid over it.
 * An `undefined` value removes that key; `extra` can register further objects.
 */
function planFor(dict: Record<string, unknown>, extra?: (ctx: PDFContext) => Record<string, unknown>) {
  const ctx = pdfLib.PDFContext.create();
  const entries = {
    Type: 'XObject', Subtype: 'Image', Width: 16, Height: 16, BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB', Filter: 'DCTDecode', ...dict, ...extra?.(ctx),
  };
  const defined = Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
  const ref = ctx.register(ctx.stream(new Uint8Array(2048), defined));
  return planImagePass(pdfLib, ctx).find((p) => p.ref === ref)!.plan;
}

const icc = (n: number, more: Record<string, unknown> = {}) => (ctx: PDFContext) => ({
  ColorSpace: ['ICCBased', ctx.register(ctx.stream(new Uint8Array(8), { N: n, ...more }))],
});

describe('planImagePass — the fixture document', () => {
  it('re-encodes exactly the tiles marked safe, and nothing else', async () => {
    const { byName } = await plansByName(await makeMaskedImagesPdf(), 1);
    for (const tile of SWEEP_TILES) {
      expect(byName(tile.name).plan.reencode, `${tile.name}: ${tile.why}`).toBe(tile.expect === 'reencoded');
    }
  });

  it('leaves a masked image alone, and both of its masks', async () => {
    const { planned, byName } = await plansByName(await makeMaskedImagesPdf(), 0);
    const overlay = byName(OVERLAY_PAGE.names.overlay);
    expect(overlay.plan).toEqual({ reencode: false, reason: 'has a soft mask' });

    // The masks are image XObjects in their own right: 8-bit grey, Flate, large
    // enough to qualify. Only what points at them says they are not pictures.
    for (const key of ['SMask', 'Mask']) {
      const mask = planned.find((p) => p.ref === overlay.stream.dict.get(PDFName.of(key)))!;
      expect(mask.plan, key).toEqual({ reencode: false, reason: 'is the mask of another image' });
    }
  });

  it('finds nothing to re-encode in a document of masked images', async () => {
    const { planned } = await plansByName(await makeOnlyMaskedPdf(), 0);
    expect(planned).toHaveLength(3);
    expect(planned.filter((p) => p.plan.reencode)).toEqual([]);
  });
});

describe('planImagePass — one shape at a time', () => {
  it('accepts plain 8-bit JPEG and Flate images in grey or RGB', () => {
    expect(planFor({})).toEqual({ reencode: true, source: 'jpeg', width: 16, height: 16, channels: 3 });
    expect(planFor({ Filter: 'FlateDecode', ColorSpace: 'DeviceGray' }))
      .toEqual({ reencode: true, source: 'flate', width: 16, height: 16, channels: 1 });
  });

  it('accepts three-component CalRGB and ICCBased, whose samples pass through unchanged', () => {
    expect(planFor({ ColorSpace: ['CalRGB', { WhitePoint: [0.95, 1, 1.09] }] })).toMatchObject({ reencode: true, channels: 3 });
    expect(planFor({}, icc(3))).toMatchObject({ reencode: true, channels: 3 });
  });

  it('accepts an identity /Decode, which changes nothing', () => {
    expect(planFor({ Decode: [0, 1, 0, 1, 0, 1] }).reencode).toBe(true);
    expect(planFor({ ColorSpace: 'DeviceGray', Decode: [0, 1] }).reencode).toBe(true);
  });

  const refused: Array<[string, Record<string, unknown>, ((ctx: PDFContext) => Record<string, unknown>)?]> = [
    ['inverted /Decode', { ColorSpace: 'DeviceGray', Decode: [1, 0] }],
    ['partial-range /Decode', { ColorSpace: 'DeviceGray', Decode: [0, 0.5] }],
    ['/Decode of the wrong length', { ColorSpace: 'DeviceGray', Decode: [0, 1, 0, 1, 0, 1] }],
    ['colour-key /Mask', { Mask: [0, 0, 0, 0, 0, 0] }],
    ['stencil (/ImageMask)', { ImageMask: true, BitsPerComponent: 1, ColorSpace: undefined }],
    ['PNG predictor', { Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 3, Columns: 16 } }],
    ['TIFF predictor', { Filter: 'FlateDecode', DecodeParms: { Predictor: 2 } }],
    ['chained filters', { Filter: ['FlateDecode', 'DCTDecode'] }],
    ['JPEG 2000', { Filter: 'JPXDecode' }],
    ['JBIG2', { Filter: 'JBIG2Decode', BitsPerComponent: 1, ColorSpace: 'DeviceGray' }],
    ['CCITT fax', { Filter: 'CCITTFaxDecode', BitsPerComponent: 1, ColorSpace: 'DeviceGray' }],
    ['LZW', { Filter: 'LZWDecode' }],
    ['no filter', { Filter: undefined }],
    ['1 bit per component', { Filter: 'FlateDecode', BitsPerComponent: 1, ColorSpace: 'DeviceGray' }],
    ['16 bits per component', { Filter: 'FlateDecode', BitsPerComponent: 16 }],
    ['missing /BitsPerComponent', { BitsPerComponent: undefined }],
    ['DeviceCMYK', { ColorSpace: 'DeviceCMYK' }],
    ['Indexed', { ColorSpace: ['Indexed', 'DeviceGray', 255, pdfLib.PDFHexString.of('00ff')] }],
    ['Separation', { ColorSpace: ['Separation', 'Spot', 'DeviceGray', { FunctionType: 2, Domain: [0, 1], N: 1 }] }],
    ['DeviceN', { ColorSpace: ['DeviceN', ['Cyan', 'Spot'], 'DeviceCMYK', { FunctionType: 2, Domain: [0, 1], N: 1 }] }],
    ['Lab', { ColorSpace: ['Lab', { WhitePoint: [0.95, 1, 1.09] }] }],
    ['CalGray', { ColorSpace: ['CalGray', { WhitePoint: [0.95, 1, 1.09], Gamma: 2.2 }] }],
    ['ICCBased with four components', {}, icc(4)],
    ['ICCBased with one component', {}, icc(1)],
    ['ICCBased with a non-default range', {}, icc(3, { Range: [0, 100, -128, 127, -128, 127] })],
    ['missing colour space', { ColorSpace: undefined }],
    ['an absurd size', { Width: 20000 }],
    ['a zero size', { Height: 0 }],
  ];
  for (const [name, dict, extra] of refused) {
    it(`leaves alone: ${name}`, () => {
      expect(planFor(dict, extra).reencode).toBe(false);
    });
  }
});

describe('replacementImageDict', () => {
  const build = (dict: Record<string, unknown>, sourceChannels: 1 | 3) => {
    const ctx = pdfLib.PDFContext.create();
    const original = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: 100, Height: 80, BitsPerComponent: 8, Filter: 'FlateDecode', ...dict });
    const next = replacementImageDict(pdfLib, ctx, original, { width: 50, height: 40, sourceChannels, length: 1234 });
    return { original, next, text: next.toString() };
  };

  it('describes the new JPEG', () => {
    const { text } = build({ ColorSpace: 'DeviceRGB' }, 3);
    expect(text).toContain('/Width 50');
    expect(text).toContain('/Height 40');
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Length 1234');
    expect(text).toContain('/ColorSpace /DeviceRGB');
  });

  it('keeps what else decides how the image is shown', () => {
    const layer = PDFRef.of(7);
    const { next } = build({ ColorSpace: 'DeviceRGB', Interpolate: true, Intent: 'Perceptual', OC: layer, Decode: [0, 1, 0, 1, 0, 1] }, 3);
    expect(next.get(PDFName.of('Interpolate'))?.toString()).toBe('true');
    expect(next.get(PDFName.of('Intent'))?.toString()).toBe('/Perceptual');
    expect(next.get(PDFName.of('OC'))).toBe(layer);
    // …but not the identity /Decode, sized for the old component count.
    expect(next.get(PDFName.of('Decode'))).toBeUndefined();
  });

  it('keeps a three-component colour space rather than flattening it to DeviceRGB', () => {
    const profile = PDFRef.of(9);
    const { next } = build({ ColorSpace: ['ICCBased', profile] }, 3);
    expect(next.get(PDFName.of('ColorSpace'))?.toString()).toBe('[ /ICCBased 9 0 R ]');
  });

  it('labels a grey source DeviceRGB, since the JPEG written has three components', () => {
    const { next, original } = build({ ColorSpace: 'DeviceGray', Decode: [0, 1] }, 1);
    expect(next.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceRGB'));
    // The original dictionary is not modified: it is still in use if the JPEG turns out no smaller.
    expect(original.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceGray'));
    expect(original.get(PDFName.of('Decode'))).toBeDefined();
  });
});

describe('readJpegFrame', () => {
  const frame = (marker: number, precision: number, width: number, height: number, components: number) =>
    Uint8Array.from([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, // an APP0 segment to step over
      0xff, marker, 0x00, 0x11, precision, height >> 8, height & 0xff, width >> 8, width & 0xff, components,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);

  it('reads baseline and progressive frame headers', () => {
    expect(readJpegFrame(frame(0xc0, 8, 1200, 800, 3))).toEqual({ width: 1200, height: 800, components: 3 });
    expect(readJpegFrame(frame(0xc2, 8, 640, 480, 1))).toEqual({ width: 640, height: 480, components: 1 });
  });

  it('reports four components, so a CMYK JPEG is never taken for RGB', () => {
    expect(readJpegFrame(frame(0xc0, 8, 10, 10, 4))?.components).toBe(4);
  });

  it('rejects what a browser will not decode, and what is not a JPEG', () => {
    expect(readJpegFrame(frame(0xc1, 12, 10, 10, 3)), '12-bit').toBeNull();
    expect(readJpegFrame(frame(0xc3, 8, 10, 10, 3)), 'lossless').toBeNull();
    expect(readJpegFrame(frame(0xc9, 8, 10, 10, 3)), 'arithmetic').toBeNull();
    expect(readJpegFrame(new TextEncoder().encode('%PDF-1.7 not an image'))).toBeNull();
    expect(readJpegFrame(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00]))).toBeNull();
    expect(readJpegFrame(new Uint8Array(0))).toBeNull();
  });
});

describe('compressPdf', () => {
  const noProgress = () => {};

  // No canvas exists here, so these only run because nothing reaches the
  // re-encode step — which is the point: a document of masked images must be an
  // ordinary result, in Target size mode too, not an error or an endless search.
  for (const options of [{ level: 'medium' }, { level: 'high', dpi: 72, jpegQuality: 50 }, { level: 'custom', targetBytes: 1024 }] as const) {
    it(`returns a document of masked images intact (${JSON.stringify(options)})`, async () => {
      const input = await makeOnlyMaskedPdf();
      const result = await compressPdf(toArrayBuffer(input), options, noProgress);

      expect(result.imagesTotal).toBe(3);
      expect(result.imagesRecompressed).toBe(0);
      expect(result.buffer.byteLength).toBeLessThanOrEqual(input.byteLength);

      const before = await plansByName(input, 0);
      const after = await plansByName(new Uint8Array(result.buffer), 0);
      expect(after.doc.getPageCount()).toBe(1);
      const overlay = (p: typeof before) => p.byName(OVERLAY_PAGE.names.overlay).stream;
      expect(overlay(after).dict.toString()).toBe(overlay(before).dict.toString());
      expect(Buffer.from(overlay(after).contents).equals(Buffer.from(overlay(before).contents))).toBe(true);
    });
  }

  it('hands back the original when re-saving would not make the file smaller', async () => {
    // No Info dictionary: compressing adds one (to blank the metadata), so the
    // re-saved file is larger than this already-minimal input.
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]);
    const input = await doc.save();

    for (const level of ['low', 'medium', 'high'] as const) {
      const result = await compressPdf(toArrayBuffer(input), { level }, noProgress);
      expect(Buffer.from(result.buffer).equals(Buffer.from(input)), level).toBe(true);
    }
  });
});
