import { describe, expect, it } from 'vitest';
import { CONVERT_FORMATS, buildConvertFacts, convertedFileName, keepsAlpha } from './convert-image';
import type { ConvertImageStats } from '../types/worker-messages';

const stats = (over: Partial<ConvertImageStats> = {}): ConvertImageStats => ({
  mime: 'image/jpeg',
  width: 1200,
  height: 800,
  quality: 85,
  hadTransparency: false,
  flattenedOnWhite: false,
  inputMime: 'image/png',
  ...over,
});

const text = (f: ReturnType<typeof buildConvertFacts>, key: string) => f.facts.find((x) => x.key === key)?.text;

describe('convertedFileName', () => {
  it('names the file for the format of its bytes, not the input', () => {
    expect(convertedFileName('holiday.png', 'image/jpeg')).toBe('holiday.jpg');
    expect(convertedFileName('IMG_0001.HEIC', 'image/png')).toBe('IMG_0001.png');
    expect(convertedFileName('a.b.webp', 'image/avif')).toBe('a.b.avif');
    expect(convertedFileName('noext', 'image/webp')).toBe('noext.webp');
    expect(convertedFileName('.png', 'image/jpeg')).toBe('image.jpg');
  });
});

describe('formats', () => {
  it('writes exactly the four it can encode, and only JPEG drops alpha', () => {
    expect(CONVERT_FORMATS).toEqual(['jpeg', 'png', 'webp', 'avif']);
    expect(CONVERT_FORMATS.filter((f) => !keepsAlpha(f))).toEqual(['jpeg']);
  });
});

describe('buildConvertFacts', () => {
  it('states format change, quality, pixels and size', () => {
    const f = buildConvertFacts(100_000, 36_000, stats());
    expect(text(f, 'format')).toBe('Format: PNG → JPEG');
    expect(text(f, 'quality')).toBe('Quality: 85');
    expect(text(f, 'pixels')).toBe('Pixel size: 1200 × 800 px (unchanged)');
    expect(text(f, 'bytes')).toMatch(/\(64% smaller\)$/);
    expect(f.outcome).toBe('PNG → JPEG · 64% smaller');
    expect(text(f, 'transparency')).toBeUndefined();
  });

  it('says PNG is lossless and when the file grew', () => {
    const f = buildConvertFacts(10_000, 25_000, stats({ mime: 'image/png', quality: null, inputMime: 'image/jpeg' }));
    expect(text(f, 'quality')).toMatch(/^Quality: lossless/);
    expect(f.outcome).toBe('JPEG → PNG · 150% larger');
  });

  it('names the white background when JPEG flattened transparency', () => {
    const f = buildConvertFacts(1, 1, stats({ hadTransparency: true, flattenedOnWhite: true }));
    expect(text(f, 'transparency')).toBe('Transparent areas are filled with white, because JPEG cannot store transparency.');
  });

  it('says transparency was kept where the target stores it', () => {
    const f = buildConvertFacts(1, 1, stats({ mime: 'image/webp', hadTransparency: true }));
    expect(text(f, 'transparency')).toBe('Transparency kept: WebP stores it.');
  });

  it('says a GIF became its first frame', () => {
    expect(text(buildConvertFacts(1, 1, stats({ inputMime: 'image/gif' })), 'frames')).toMatch(/first frame/);
    expect(text(buildConvertFacts(1, 1, stats()), 'frames')).toBeUndefined();
  });

  it('copes with an input format it could not name', () => {
    const f = buildConvertFacts(1, 1, stats({ inputMime: null }));
    expect(text(f, 'format')).toBe('Format: JPEG');
    expect(f.outcome).toBe('JPEG · the same size');
  });
});
