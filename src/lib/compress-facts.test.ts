import { describe, it, expect } from 'vitest';
import { buildFacts, pageBytesLine } from './compress-facts';
import type { CompressApplied, CompressImageOutcome } from '../types/worker-messages';

const HIGH: CompressApplied = { lossless: false, jpegQuality: 50, imageScale: 0.48, grayscale: false };
const LOW: CompressApplied = { lossless: true, jpegQuality: 90, imageScale: 1, grayscale: false };

function image(over: Partial<CompressImageOutcome>): CompressImageOutcome {
  return {
    pages: [0],
    width: 1000,
    height: 1000,
    outWidth: 480,
    outHeight: 480,
    bytesBefore: 100_000,
    bytesAfter: 20_000,
    action: 'recompressed',
    ...over,
  };
}

const kept = (reason: CompressImageOutcome['reason'], over: Partial<CompressImageOutcome> = {}) =>
  image({ action: 'kept', reason, outWidth: 1000, outHeight: 1000, bytesAfter: 100_000, ...over });

describe('buildFacts', () => {
  it('counts the images on this page, with the settings used and why the rest were left', () => {
    const images = [
      ...Array.from({ length: 12 }, () => image({})),
      kept('masked'),
      kept('masked'),
      image({ pages: [1] }), // another page's image is not counted
    ];
    const facts = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images });
    expect(facts.heading).toBe('Result for page 1');
    expect(facts.lines[0]).toBe(
      '12 of 14 images on this page re-encoded at JPEG quality 50, scaled to 48% of their width and height; ' +
        '2 left as they were (they use transparency or masking).',
    );
    expect(facts.lines[1]).toBe('Text and vector graphics are not changed; document properties are cleared.');
    expect(facts.pageImageBytes).toEqual({ before: 14 * 100_000, after: 12 * 20_000 + 2 * 100_000 });
    expect(pageBytesLine(facts.pageImageBytes!)).toBe('Images on this page: 1.3 MB → 429.7 KB');
  });

  it('names the page and says preview before the run', () => {
    const facts = buildFacts({ phase: 'preview', pageIndex: 3, reportPageIndex: 0, applied: HIGH, images: [image({})] });
    expect(facts.heading).toBe('Preview of page 4');
    expect(facts.lines[0]).toBe('The image on this page is re-encoded at JPEG quality 50, scaled to 48% of its width and height.');
  });

  it('Low: images are not re-encoded; document properties are cleared', () => {
    const facts = buildFacts({ phase: 'result', pageIndex: 0, applied: LOW, images: [kept(undefined)] });
    expect(facts.lines).toEqual(['Images are not re-encoded; document properties are cleared.']);
  });

  it('full size and grayscale are said as they are, and no DPI is mentioned', () => {
    const facts = buildFacts({
      phase: 'result',
      pageIndex: 0,
      applied: { ...HIGH, jpegQuality: 75, imageScale: 1, grayscale: true },
      images: [image({}), image({})],
    });
    expect(facts.lines[0]).toBe('2 of 2 images on this page re-encoded at JPEG quality 75, in grayscale, at full width and height.');
    expect(facts.lines.join(' ')).not.toMatch(/dpi/i);
  });

  it('a DPI setting is reported per image, from what was actually reduced', () => {
    const dpi = { ...HIGH, imageScale: 1, targetDpi: 96 };
    const reduced = image({ width: 1000, outWidth: 320, placedDpi: 300 });
    const kept = image({ width: 480, outWidth: 480, height: 480, outHeight: 480, placedDpi: 80 });
    const one = buildFacts({ phase: 'result', pageIndex: 0, applied: dpi, images: [reduced] });
    expect(one.lines[0]).toBe('The image on this page is re-encoded at JPEG quality 50 and reduced to 96 DPI as drawn on the page (from 300 DPI).');
    const some = buildFacts({ phase: 'result', pageIndex: 0, applied: dpi, images: [reduced, kept, image({ outWidth: 1000, outHeight: 1000 })] });
    expect(some.lines[0]).toBe('3 of 3 images on this page re-encoded at JPEG quality 50; 1 of them reduced to 96 DPI as drawn on the page.');
    const both = buildFacts({ phase: 'result', pageIndex: 0, applied: { ...dpi, grayscale: true }, images: [reduced, reduced] });
    expect(both.lines[0]).toBe('2 of 2 images on this page re-encoded at JPEG quality 50, in grayscale; both reduced to 96 DPI as drawn on the page.');
    const none = buildFacts({ phase: 'result', pageIndex: 0, applied: dpi, images: [kept] });
    expect(none.lines[0]).toBe('The image on this page is re-encoded at JPEG quality 50 at full width and height.');
  });

  it('every image left as it was, each kind of reason grouped', () => {
    const facts = buildFacts({
      phase: 'result',
      pageIndex: 0,
      applied: HIGH,
      images: [kept('masked'), kept('unsupported'), kept('unsupported'), kept('small')],
    });
    expect(facts.lines[0]).toBe(
      'None of the 4 images on this page is re-encoded; 1 left as it was (it uses transparency or masking); ' +
        '2 left as they were (their format is not one this tool re-encodes); 1 left as it was (it is too small to gain anything).',
    );
    const one = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [kept('masked')] });
    expect(one.lines[0]).toBe('The image on this page is not re-encoded (it uses transparency or masking).');
  });

  it('a page with no images', () => {
    const facts = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({ pages: [1] })] });
    expect(facts.lines[0]).toBe('There are no images on this page, so nothing on it is re-encoded.');
    expect(facts.pageImageBytes).toBeUndefined();
  });

  it('no selectable text: said only when known, and explained when the page has images', () => {
    const scan = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({})], pageHasText: false });
    expect(scan.lines.at(-1)).toBe(
      'This page has no selectable text: any text you see on it is part of an image and is compressed with it.',
    );
    const unknown = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({})] });
    expect(unknown.lines.join(' ')).not.toMatch(/selectable/);
    const text = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({})], pageHasText: true });
    expect(text.lines.join(' ')).not.toMatch(/selectable/);
  });

  it('says when an image the page draws was stored more than once', () => {
    const one = buildFacts({ phase: 'result', pageIndex: 0, applied: LOW, images: [image({ copiesMerged: 2 })] });
    expect(one.lines).toContain('The file stored the image on this page 3 times over; it is now stored once.');
    const two = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({ copiesMerged: 1 }), image({ copiesMerged: 4 }), image({})] });
    expect(two.lines).toContain('The file stored 2 of the images on this page more than once; each is now stored once.');
    expect(buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({})] }).lines.join(' ')).not.toMatch(/stored/);
    // Handed back unchanged: nothing was merged in the file the visitor gets.
    expect(buildFacts({ phase: 'result', pageIndex: 0, applied: LOW, images: [image({ copiesMerged: 2 })], returnedOriginal: true }).lines.join(' ')).not.toMatch(/stored/);
  });

  it('says text is left alone: no setting removes fonts', () => {
    const facts = buildFacts({ phase: 'result', pageIndex: 0, applied: HIGH, images: [image({})] });
    expect(facts.lines[1]).toBe('Text and vector graphics are not changed; document properties are cleared.');
  });

  it('the original handed back is said plainly', () => {
    const facts = buildFacts({
      phase: 'result',
      pageIndex: 0,
      applied: HIGH,
      images: [kept('not-smaller')],
      returnedOriginal: true,
    });
    expect(facts.lines).toEqual(['Compressing did not make this file smaller, so the result is your original file, unchanged.']);
  });

  describe('Target size', () => {
    const target = (over: Partial<CompressApplied>, extra: { targetMissed?: boolean } = {}) =>
      buildFacts({
        phase: 'result',
        pageIndex: 0,
        applied: { ...HIGH, ladderSteps: 12, ...over },
        images: [image({})],
        targetLabel: '100 KB',
        ...extra,
      });

    it('says what it took', () => {
      const facts = target({ ladderStep: 6, jpegQuality: 50, imageScale: 0.75 });
      expect(facts.targetApplied).toBe('To fit under 100 KB, images were set to JPEG quality 50 at 75% of their width and height.');
      expect(facts.qualityWarning).toBeUndefined();
    });

    it('warns at the harsh end', () => {
      const facts = target({ ladderStep: 11, jpegQuality: 25, imageScale: 0.25 });
      expect(facts.targetApplied).toBe('To fit under 100 KB, images were set to JPEG quality 25 at 25% of their width and height.');
      expect(facts.qualityWarning).toMatch(/harsh end/);
      expect(target({ ladderStep: 8, imageScale: 0.5 }).qualityWarning).toBeDefined();
    });

    it('a missed target is not called a fit', () => {
      const facts = target({ ladderStep: 11, jpegQuality: 25, imageScale: 0.25 }, { targetMissed: true });
      expect(facts.targetApplied).toMatch(/^To come as close as possible to 100 KB/);
    });

    it('the lossless step: nothing to report about images', () => {
      const facts = target({ ladderStep: 0, lossless: true, imageScale: 1 });
      expect(facts.targetApplied).toBeUndefined();
      expect(facts.qualityWarning).toBeUndefined();
      expect(facts.lines[0]).toBe('To fit under 100 KB, no image had to be re-encoded.');
    });

    it('is never said about a preview', () => {
      const facts = buildFacts({
        phase: 'preview',
        pageIndex: 0,
        applied: { ...HIGH, ladderStep: 11, ladderSteps: 12, imageScale: 0.25 },
        images: [image({})],
        targetLabel: '100 KB',
      });
      expect(facts.targetApplied).toBeUndefined();
      expect(facts.qualityWarning).toBeUndefined();
    });
  });
});
