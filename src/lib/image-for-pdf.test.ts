import { describe, expect, it } from 'vitest';
import { readJpegInfo, readPngSize, sniffImageType } from './image-for-pdf';

const u16 = (v: number, little = false) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
const u32 = (v: number, little = false) =>
  little
    ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
    : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

const segment = (marker: number, payload: number[]) => [0xff, marker, ...u16(payload.length + 2), ...payload];

/** An APP1 segment whose only tag is Orientation. */
function exif(orientation: number, little: boolean): number[] {
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(0x002a, little),
    ...u32(8, little), // IFD0 follows the header
    ...u16(1, little), // one entry
    ...u16(0x0112, little), // Orientation
    ...u16(3, little), // SHORT
    ...u32(1, little),
    ...u16(orientation, little),
    ...u16(0, little),
    ...u32(0, little), // no next IFD
  ];
  return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}

const SOI = [0xff, 0xd8];
const JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DQT = segment(0xdb, new Array(65).fill(1));
/** A frame header: precision, height, width, one component. */
const sof = (marker: number, width: number, height: number) =>
  segment(marker, [8, ...u16(height), ...u16(width), 1, 1, 0x11, 0]);

const jpeg = (...parts: number[][]) => new Uint8Array([...SOI, ...parts.flat()]);

describe('sniffImageType', () => {
  it('goes by the first bytes, not by a name or MIME type', () => {
    expect(sniffImageType(jpeg(JFIF))).toBe('jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('png');
    expect(sniffImageType(new TextEncoder().encode('RIFF....WEBP'))).toBe('other');
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBe('other');
    expect(sniffImageType(new Uint8Array(0))).toBe('other');
  });
});

describe('readJpegInfo', () => {
  it('is upright when the file carries no EXIF', () => {
    expect(readJpegInfo(jpeg(JFIF, DQT, sof(0xc0, 1200, 800)))).toEqual({ orientation: 1, width: 1200, height: 800 });
  });

  it.each([1, 3, 6, 8])('reads orientation %i in either byte order', (orientation) => {
    for (const little of [false, true]) {
      const info = readJpegInfo(jpeg(JFIF, exif(orientation, little), DQT, sof(0xc2, 4032, 3024)));
      expect(info).toEqual({ orientation, width: 4032, height: 3024 });
    }
  });

  it('reports the stored size, which is not the displayed size for a turned photo', () => {
    // Stored landscape, shown portrait: the caller must not use these as the page shape.
    const info = readJpegInfo(jpeg(exif(6, false), sof(0xc0, 1200, 800)));
    expect(info.orientation).toBe(6);
    expect([info.width, info.height]).toEqual([1200, 800]);
  });

  it('does not mistake a Huffman table for a frame header', () => {
    const dht = segment(0xc4, new Array(20).fill(0));
    expect(readJpegInfo(jpeg(dht, sof(0xc0, 10, 20)))).toEqual({ orientation: 1, width: 10, height: 20 });
  });

  it('ignores an out-of-range orientation and a non-EXIF APP1', () => {
    expect(readJpegInfo(jpeg(exif(9, false), sof(0xc0, 4, 4))).orientation).toBe(1);
    const xmp = segment(0xe1, [...new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x/>')]);
    expect(readJpegInfo(jpeg(xmp, exif(6, true), sof(0xc0, 4, 4))).orientation).toBe(6);
  });

  it('survives a file cut short, and anything that is not a JPEG', () => {
    const whole = jpeg(JFIF, exif(6, false), DQT, sof(0xc0, 1200, 800));
    for (let cut = 0; cut < whole.length; cut++) {
      expect(() => readJpegInfo(whole.subarray(0, cut))).not.toThrow();
    }
    // Cut before the frame header: the orientation is still found, the size is not.
    const noFrame = readJpegInfo(jpeg(JFIF, exif(6, false), DQT));
    expect(noFrame).toEqual({ orientation: 6 });
    expect(readJpegInfo(new Uint8Array([1, 2, 3, 4]))).toEqual({ orientation: 1 });
  });
});

describe('readPngSize', () => {
  it('reads the IHDR size', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...u32(13), 0x49, 0x48, 0x44, 0x52,
      ...u32(800), ...u32(600),
    ]);
    expect(readPngSize(png)).toEqual({ width: 800, height: 600 });
    expect(readPngSize(png.subarray(0, 20))).toBeNull();
    expect(readPngSize(jpeg(JFIF))).toBeNull();
  });
});
