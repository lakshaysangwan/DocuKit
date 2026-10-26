import { describe, it, expect, vi } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { deduplicateImages } from './pdf-dedupe';
import { compressPdf } from './pdf-compress';
import { makeDuplicateImagesPdf, DUPLICATE_NAMES, DUPLICATE_PAGES } from '../../tests/e2e/fixtures/duplicate-images';
import { makeMaskedImagesPdf } from '../../tests/e2e/fixtures/masked-images';

// qpdf is WebAssembly fetched over HTTP; the structural pass is not under test.
vi.mock('../workers/qpdf-helper', () => ({ qpdfCompress: async (bytes: Uint8Array) => bytes }));

const toArrayBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function imageObjects(doc: PDFDocument) {
  return doc.context.enumerateIndirectObjects().filter(
    ([, obj]) => obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'),
  );
}

function raw(obj: unknown): PDFRawStream {
  if (!(obj instanceof PDFRawStream)) throw new Error('not a stream');
  return obj;
}

const xobject = (doc: PDFDocument, page: number, name: string) =>
  doc.getPages()[page].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of(name));

describe('deduplicateImages', () => {
  it('keeps one object per distinct image and points every page at it', async () => {
    const doc = await PDFDocument.load(await makeDuplicateImagesPdf());
    // Per page: photo, stamp and its mask; page 1 adds the inverted photo and the other stamp with its mask.
    expect(imageObjects(doc)).toHaveLength(DUPLICATE_PAGES * 3 + 3);

    const result = await deduplicateImages(pdfLib, doc.context);
    expect(result.imagesMerged).toBe((DUPLICATE_PAGES - 1) * 3);
    expect(imageObjects(doc)).toHaveLength(6);

    const saved = await PDFDocument.load(await doc.save());
    for (const name of [DUPLICATE_NAMES.photo, DUPLICATE_NAMES.stamp]) {
      const refs = new Set(Array.from({ length: DUPLICATE_PAGES }, (_, p) => xobject(saved, p, name)!.toString()));
      expect(refs.size, name).toBe(1);
    }
    // Same bytes under a different /Decode, and the same colour under a different mask, stay apart.
    expect(xobject(saved, 0, DUPLICATE_NAMES.inverted)!.toString()).not.toBe(xobject(saved, 0, DUPLICATE_NAMES.photo)!.toString());
    const smask = (name: string) => raw(saved.context.lookup(xobject(saved, 0, name))).dict.get(PDFName.of('SMask'))!.toString();
    expect(smask(DUPLICATE_NAMES.stampOther)).not.toBe(smask(DUPLICATE_NAMES.stamp));
  });

  it('finds nothing to merge in a document without repeats', async () => {
    const doc = await PDFDocument.load(await makeMaskedImagesPdf());
    const before = imageObjects(doc).length;
    expect((await deduplicateImages(pdfLib, doc.context)).imagesMerged).toBe(0);
    expect(imageObjects(doc)).toHaveLength(before);
  });
});

describe('compressPdf — repeated images', () => {
  it('Low merges them losslessly, shrinking the file by about their size, and reports it per image', async () => {
    const input = await makeDuplicateImagesPdf();
    const doc = await PDFDocument.load(input);
    const photo = raw(doc.context.lookup(xobject(doc, 0, DUPLICATE_NAMES.photo)));
    const stamp = raw(doc.context.lookup(xobject(doc, 0, DUPLICATE_NAMES.stamp)));
    const mask = raw(doc.context.lookup(stamp.dict.get(PDFName.of('SMask'))));
    const duplicateBytes = (DUPLICATE_PAGES - 1) * (photo.contents.length + stamp.contents.length + mask.contents.length);

    const result = await compressPdf(toArrayBuffer(input), { level: 'low', report: true }, () => {});
    expect(result.imagesMerged).toBe((DUPLICATE_PAGES - 1) * 3);
    expect(input.byteLength - result.buffer.byteLength).toBeGreaterThan(duplicateBytes * 0.95);

    const merged = result.images!.filter((i) => i.copiesMerged);
    expect(merged).toHaveLength(2); // the photo and the stamp; the mask is reached through the stamp
    for (const image of merged) {
      expect(image.copiesMerged).toBe(DUPLICATE_PAGES - 1);
      expect(image.pages).toEqual([0, 1, 2]);
    }
  });
});
