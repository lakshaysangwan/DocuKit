import { describe, it, expect } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { choosePreviewPage, cutProbePage, openProbe, probePdf } from './pdf-compress-probe';
import { pageImageRefs } from './pdf-page-images';
import { makeMaskedImagesPdf, makeOnlyMaskedPdf, SWEEP_TILES } from '../../tests/e2e/fixtures/masked-images';
import type { ProbePageInfo } from '../types/worker-messages';

const page = (pageIndex: number, over: Partial<ProbePageInfo> = {}): ProbePageInfo => ({
  pageIndex,
  images: 0,
  eligible: 0,
  eligibleBytes: 0,
  eligiblePixels: 0,
  ...over,
});

const toArrayBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('choosePreviewPage', () => {
  it('stays on the first page when compression changes something on it', () => {
    expect(
      choosePreviewPage([
        page(0, { images: 5, eligible: 1, eligibleBytes: 10_000 }),
        page(1, { images: 1, eligible: 1, eligibleBytes: 90_000 }),
      ]),
    ).toBe(0);
  });

  it('otherwise picks the page with the most bytes of images compression may change', () => {
    expect(
      choosePreviewPage([
        page(0, { images: 2 }),
        page(1, { images: 1, eligible: 1, eligibleBytes: 90_000 }),
        page(2, { images: 9, eligible: 3, eligibleBytes: 40_000 }),
      ]),
    ).toBe(1);
  });

  it('ties go to the earlier page', () => {
    expect(choosePreviewPage([page(0), page(1, { eligibleBytes: 5, eligible: 1, images: 1 }), page(2, { eligibleBytes: 5, eligible: 1, images: 1 })])).toBe(1);
  });

  it('with nothing compression may change, the page with the most images; with none, the first', () => {
    expect(choosePreviewPage([page(0, { images: 1 }), page(1, { images: 3 }), page(2, { images: 2 })])).toBe(1);
    expect(choosePreviewPage([page(0), page(1)])).toBe(0);
    expect(choosePreviewPage([])).toBe(0);
  });
});

describe('probePdf', () => {
  it('takes an inventory with the pass’s own rule and cuts out the chosen page', async () => {
    const input = await makeMaskedImagesPdf();
    const result = await probePdf(toArrayBuffer(input));
    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    // The sweep page: one image per tile, the safe ones eligible.
    const safe = SWEEP_TILES.filter((t) => t.expect !== 'untouched').length;
    expect(result.pages[1].images).toBe(SWEEP_TILES.length);
    expect(result.pages[1].eligible).toBe(safe);
    expect(result.pageIndex).toBe(choosePreviewPage(result.pages));

    const cut = await pdfLib.PDFDocument.load(result.pagePdf);
    expect(cut.getPageCount()).toBe(1);
    expect(pageImageRefs(pdfLib, cut)[0]).toHaveLength(result.pages[result.pageIndex].images);
  });

  it('cuts out the page asked for', async () => {
    const input = await makeMaskedImagesPdf();
    const result = await probePdf(toArrayBuffer(input), 0);
    expect(result.pageIndex).toBe(0);
    const cut = await pdfLib.PDFDocument.load(result.pagePdf);
    expect(pageImageRefs(pdfLib, cut)[0]).toHaveLength(result.pages[0].images);
  });

  it('a document of masked images has nothing eligible', async () => {
    const result = await probePdf(toArrayBuffer(await makeOnlyMaskedPdf()));
    expect(result.pages.every((p) => p.eligible === 0 && p.eligibleBytes === 0)).toBe(true);
  });
});

describe('openProbe / cutProbePage', () => {
  it('reads the PDF once and cuts any page from it, as often as asked, the same as a one-off probe', async () => {
    const input = await makeMaskedImagesPdf();
    const opened = await openProbe(toArrayBuffer(input));
    for (const pageIndex of [1, 0, 1]) {
      const cut = await cutProbePage(opened, pageIndex);
      const once = await probePdf(toArrayBuffer(input), pageIndex);
      expect(cut.pageIndex).toBe(pageIndex);
      expect(cut.pages).toEqual(once.pages);
      expect(Buffer.from(cut.pagePdf).equals(Buffer.from(once.pagePdf)), `page ${pageIndex}`).toBe(true);
    }
    // The source document is untouched by cutting pages from it.
    expect(opened.doc.getPageCount()).toBe(2);
  });
});
