import { describe, expect, it } from 'vitest';
import {
  DIRECT_DOWNLOAD_LIMIT,
  DOWNLOAD_GAP_MS,
  pageFileName,
  stripPdfExtension,
} from './multi-download';

describe('pageFileName', () => {
  it('uses the source page number, not the position in the selection', () => {
    const selection = [1, 3, 5];
    expect(selection.map((p) => pageFileName('report', p, 5, 'png'))).toEqual([
      'report-page-1.png',
      'report-page-3.png',
      'report-page-5.png',
    ]);
  });

  it('pads to the width of the page count', () => {
    expect(pageFileName('report', 3, 9, 'png')).toBe('report-page-3.png');
    expect(pageFileName('report', 3, 10, 'png')).toBe('report-page-03.png');
    expect(pageFileName('report', 3, 99, 'jpeg')).toBe('report-page-03.jpeg');
    expect(pageFileName('report', 3, 100, 'webp')).toBe('report-page-003.webp');
    expect(pageFileName('report', 100, 100, 'avif')).toBe('report-page-100.avif');
  });

  it('gives names that sort in page order', () => {
    const pages = [1, 2, 9, 10, 11, 100, 120];
    const names = pages.map((p) => pageFileName('doc', p, 120, 'png'));
    expect([...names].sort()).toEqual(names);
  });

  it('never truncates a page number wider than the stated count', () => {
    expect(pageFileName('doc', 12, 5, 'png')).toBe('doc-page-12.png');
    expect(pageFileName('doc', 1, 0, 'png')).toBe('doc-page-1.png');
  });

  it('keeps the base name as given, dots and spaces included', () => {
    expect(pageFileName('Q3 report v1.2', 2, 12, 'png')).toBe('Q3 report v1.2-page-02.png');
  });
});

describe('stripPdfExtension', () => {
  it('removes only a trailing .pdf, in any case', () => {
    expect(stripPdfExtension('report.pdf')).toBe('report');
    expect(stripPdfExtension('REPORT.PDF')).toBe('REPORT');
    expect(stripPdfExtension('my.pdf.notes.pdf')).toBe('my.pdf.notes');
    expect(stripPdfExtension('scan')).toBe('scan');
  });
});

describe('direct-download limits', () => {
  it('finishes a full run of separate downloads within a click’s activation window', () => {
    // Transient user activation lasts about five seconds; the last download of
    // the largest allowed batch has to start well inside it.
    expect((DIRECT_DOWNLOAD_LIMIT - 1) * DOWNLOAD_GAP_MS).toBeLessThan(4000);
  });
});
