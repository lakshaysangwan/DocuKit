import { describe, expect, it } from 'vitest';
import {
  buildImageFacts,
  canPreviewLive,
  extForMime,
  flattenOnWhite,
  hasTransparency,
  outputFileName,
  savedPercent,
  searchTargetQuality,
  sniffImageMime,
  uniqueNames,
} from './compress-image';
import type { CompressImageStats } from '../types/worker-messages';

const bytes = (...parts: (number[] | string)[]) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  while (out.length < 32) out.push(0);
  return new Uint8Array(out);
};

describe('sniffImageMime', () => {
  it('reads the real format from the signature', () => {
    expect(sniffImageMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageMime(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBe('image/avif');
    expect(sniffImageMime(bytes([0, 0, 0, 0x18], 'ftypheic'))).toBe('image/heic');
    expect(sniffImageMime(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(bytes('BM'))).toBe('image/bmp');
  });

  it('says null for anything else, and for too few bytes', () => {
    expect(sniffImageMime(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('names', () => {
  it('names the download by the format of its bytes', () => {
    expect(outputFileName('holiday.png', 'image/webp')).toBe('holiday-compressed.webp');
    expect(outputFileName('scan.final.JPG', 'image/jpeg')).toBe('scan.final-compressed.jpg');
    expect(outputFileName('noext', 'image/avif')).toBe('noext-compressed.avif');
    expect(extForMime('image/png')).toBe('png');
  });

  it('makes names unique for a ZIP or a folder', () => {
    expect(uniqueNames(['a.jpg', 'b.jpg', 'A.jpg', 'a.jpg'])).toEqual(['a.jpg', 'b.jpg', 'A (2).jpg', 'a (3).jpg']);
    expect(uniqueNames(['x.webp', 'x (2).webp', 'x.webp'])).toEqual(['x.webp', 'x (2).webp', 'x (3).webp']);
  });
});

describe('transparency', () => {
  it('finds a pixel that is not opaque', () => {
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
  });

  it('flattens onto white: clear becomes white, half becomes the blend, opaque is untouched', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 128, 10, 20, 30, 255]);
    flattenOnWhite(px);
    expect([...px]).toEqual([255, 255, 255, 255, 127, 127, 127, 255, 10, 20, 30, 255]);
  });
});

describe('searchTargetQuality', () => {
  // Size grows with quality: 1 KB per quality step.
  const encoder = () => {
    const tried: number[] = [];
    const encodeAt = async (q: number) => {
      tried.push(q);
      return new ArrayBuffer(q * 1000);
    };
    return { tried, encodeAt };
  };

  it('finds the highest quality that fits', async () => {
    const { encodeAt, tried } = encoder();
    const r = await searchTargetQuality(encodeAt, 43_500);
    expect(r).toMatchObject({ quality: 43, met: true });
    expect(r.bytes.byteLength).toBe(43_000);
    expect(tried.length).toBeLessThanOrEqual(10);
  });

  it('stops at once when the top quality fits', async () => {
    const { encodeAt, tried } = encoder();
    expect(await searchTargetQuality(encodeAt, 1e9)).toMatchObject({ quality: 95, met: true });
    expect(tried).toEqual([95]);
  });

  it('reports a miss with the smallest result reached', async () => {
    const { encodeAt } = encoder();
    const r = await searchTargetQuality(encodeAt, 1000);
    expect(r).toMatchObject({ quality: 5, met: false });
    expect(r.bytes.byteLength).toBe(5000);
  });
});

describe('preview', () => {
  it('follows the slider for JPEG and WebP of normal size only', () => {
    expect(canPreviewLive('jpeg', 1200 * 800)).toBe(true);
    expect(canPreviewLive('webp', 12_000_000)).toBe(true);
    expect(canPreviewLive('webp', 12_000_001)).toBe(false);
    expect(canPreviewLive('avif', 1000)).toBe(false);
    expect(canPreviewLive('png', 1000)).toBe(false);
  });
});

describe('buildImageFacts', () => {
  const stats = (over: Partial<CompressImageStats>): CompressImageStats => ({
    mime: 'image/webp',
    width: 1200,
    height: 800,
    encodedFormat: 'webp',
    encodedQuality: 75,
    encodedBytes: 9000,
    returnedOriginal: false,
    flattenedOnWhite: false,
    ...over,
  });
  const text = (f: ReturnType<typeof buildImageFacts>, key: string) => f.facts.find((x) => x.key === key)?.text;

  it('says what the file is', () => {
    const f = buildImageFacts(25_600, 9000, stats({}));
    expect(f.outcome).toBe('65% smaller');
    expect(f.warning).toBe(false);
    expect(text(f, 'format')).toBe('Format: WebP');
    expect(text(f, 'quality')).toBe('Quality: 75');
    expect(text(f, 'pixels')).toBe('Pixel size: 1200 × 800 px (unchanged)');
    expect(text(f, 'bytes')).toBe('Size: 25 KB → 8.8 KB');
    expect(text(f, 'saved')).toBe('Saved: 65%');
    expect(text(f, 'metadata')).toMatch(/EXIF .* is not carried over/);
  });

  it('says plainly when the original was kept', () => {
    const f = buildImageFacts(25_600, 25_600, stats({ mime: 'image/jpeg', encodedBytes: 31_000, returnedOriginal: true }));
    expect(f.outcome).toMatch(/^Original kept/);
    expect(f.warning).toBe(true);
    expect(text(f, 'format')).toBe('Format: JPEG — your original file, unchanged.');
    expect(text(f, 'original')).toBe('Your original is kept: as WebP at quality 75 it came to 30.3 KB, which is not smaller than 25 KB.');
    expect(text(f, 'metadata')).toMatch(/kept as it was/);
    expect(text(f, 'quality')).toBeUndefined();
  });

  it('gives the quality a target needed', () => {
    const f = buildImageFacts(500_000, 99_000, stats({ encodedQuality: 43, target: { bytes: 102_400, met: true } }));
    expect(text(f, 'quality')).toBe('Quality 43 was needed to fit under 100 KB.');
    expect(text(f, 'target-missed')).toBeUndefined();
  });

  it('reports a missed target with the size reached', () => {
    const f = buildImageFacts(25_600, 6300, stats({ mime: 'image/jpeg', encodedFormat: 'jpeg', encodedQuality: 5, encodedBytes: 6300, target: { bytes: 1024, met: false } }));
    expect(f.outcome).toBe('Not under 1 KB');
    expect(f.warning).toBe(true);
    expect(text(f, 'target-missed')).toBe(
      'Could not get under 1 KB: the smallest this image gets is 6.2 KB, as JPEG at quality 5. Make it smaller in pixels with Resize Image, then try again.',
    );
  });

  it('explains PNG and the white background', () => {
    const png = buildImageFacts(700_000, 650_000, stats({ mime: 'image/png', encodedFormat: 'png', encodedQuality: null }));
    expect(text(png, 'quality')).toMatch(/^Quality: lossless/);
    const jpeg = buildImageFacts(700_000, 60_000, stats({ mime: 'image/jpeg', encodedFormat: 'jpeg', flattenedOnWhite: true }));
    expect(text(jpeg, 'background')).toBe('Transparent areas are filled with white, because JPEG cannot store transparency.');
  });

  it('says when a file came out larger', () => {
    expect(savedPercent(1000, 1100)).toBe(-10);
    const f = buildImageFacts(1000, 1100, stats({}));
    expect(f.outcome).toBe('10% larger than your original');
    expect(text(f, 'saved')).toBe('Saved: nothing — 10% larger than your original.');
  });
});
