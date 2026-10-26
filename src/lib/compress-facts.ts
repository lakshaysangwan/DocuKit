/**
 * What Compress PDF tells the visitor about one page, built only from what the
 * compression pass reported (`applied` and the per-image outcomes), so every
 * sentence is true of the file: nothing here is estimated.
 *
 * Pure, so the wording is unit-tested.
 */
import { HARSH_IMAGE_SCALE } from './pdf-compress-presets';
import { formatBytes } from './utils';
import type { CompressApplied, CompressImageOutcome, ImageKeptReason } from '../types/worker-messages';

export interface FactsInput {
  /** Before the run (a one-page preview) or after it (the real output). */
  phase: 'preview' | 'result';
  /** Zero-based page the facts are about. */
  pageIndex: number;
  applied: CompressApplied;
  /** Every reported image; the ones drawn on `pageIndex` are picked out here. */
  images?: CompressImageOutcome[];
  /** Which page of the reported document is `pageIndex`. Defaults to `pageIndex` (a one-page preview passes 0). */
  reportPageIndex?: number;
  returnedOriginal?: boolean;
  /** Whether pdf.js found any text on the page; undefined while unknown. */
  pageHasText?: boolean;
  /** Target size mode: the limit as the visitor typed it, e.g. "100 KB". */
  targetLabel?: string;
  /** Target size mode: whether the output is over the limit. */
  targetMissed?: boolean;
}

export interface Facts {
  /** "Preview of page 2" / "Result for page 2". */
  heading: string;
  /** The facts, one sentence each. */
  lines: string[];
  /** Bytes of the images this page draws, before and after. Absent when the page has none. */
  pageImageBytes?: { before: number; after: number };
  /** Target size mode, when images were re-encoded to fit: what it took. */
  targetApplied?: string;
  /** Target size mode, at the harsh end of the scale. */
  qualityWarning?: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const REASONS: Record<ImageKeptReason, [one: string, many: string]> = {
  masked: ['it uses transparency or masking', 'they use transparency or masking'],
  unsupported: ['its format is not one this tool re-encodes', 'their format is not one this tool re-encodes'],
  small: ['it is too small to gain anything', 'they are too small to gain anything'],
  'not-smaller': ['re-encoding did not make it smaller', 're-encoding did not make them smaller'],
  'quality-90-plus': [
    'at quality 90 or more without scaling, re-encoding would only lose quality',
    'at quality 90 or more without scaling, re-encoding would only lose quality',
  ],
  failed: ['it could not be read', 'they could not be read'],
};

const REASON_ORDER: ImageKeptReason[] = ['masked', 'unsupported', 'quality-90-plus', 'small', 'not-smaller', 'failed'];

/** "48%": the share of each side an image keeps. */
export const scalePercent = (scale: number) => `${Math.round(scale * 100)}%`;

function settingsPhrase(applied: CompressApplied): string {
  let out = `JPEG quality ${applied.jpegQuality}`;
  out += applied.imageScale < 1 ? `, scaled to ${scalePercent(applied.imageScale)} of their width and height` : ' at full width and height';
  if (applied.grayscale) out += ', in grayscale';
  return out;
}

export function buildFacts(input: FactsInput): Facts {
  const { phase, pageIndex, applied, returnedOriginal, pageHasText } = input;
  const pageNumber = pageIndex + 1;
  const heading = phase === 'preview' ? `Preview of page ${pageNumber}` : `Result for page ${pageNumber}`;
  const reportPage = input.reportPageIndex ?? pageIndex;
  const onPage = input.images?.filter((image) => image.pages.includes(reportPage));
  const lines: string[] = [];

  if (returnedOriginal) {
    lines.push('Compressing did not make this file smaller, so the result is your original file, unchanged.');
  } else if (applied.lossless) {
    lines.push('Images are not re-encoded; document properties are cleared.');
  } else if (onPage) {
    const n = onPage.length;
    if (n === 0) {
      lines.push('There are no images on this page, so nothing on it is re-encoded.');
    } else {
      const done = onPage.filter((image) => image.action === 'recompressed').length;
      const kept = new Map<ImageKeptReason, number>();
      for (const image of onPage) {
        if (image.action === 'kept' && image.reason) kept.set(image.reason, (kept.get(image.reason) ?? 0) + 1);
      }
      const parts: string[] = [];
      if (done > 0) {
        parts.push(
          n === 1
            ? `The image on this page is re-encoded at ${settingsPhrase(applied).replace('their', 'its')}`
            : `${done} of ${n} images on this page re-encoded at ${settingsPhrase(applied)}`,
        );
      } else {
        parts.push(n === 1 ? 'The image on this page is not re-encoded' : `None of the ${n} images on this page is re-encoded`);
      }
      for (const reason of REASON_ORDER) {
        const count = kept.get(reason);
        if (!count) continue;
        const [one, many] = REASONS[reason];
        if (done === 0 && count === n) {
          parts[0] += ` (${plural(count, one, many)})`;
        } else {
          parts.push(`${count} left as ${plural(count, 'it was', 'they were')} (${plural(count, one, many)})`);
        }
      }
      lines.push(`${parts.join('; ')}.`);
    }
    lines.push('Text and vector graphics are not changed; document properties are cleared.');
  }

  if (pageHasText === false) {
    lines.push(
      onPage && onPage.length > 0
        ? 'This page has no selectable text: any text you see on it is part of an image and is compressed with it.'
        : 'This page has no selectable text.',
    );
  }

  const facts: Facts = { heading, lines };

  if (onPage && onPage.length > 0) {
    facts.pageImageBytes = {
      before: onPage.reduce((sum, image) => sum + image.bytesBefore, 0),
      after: onPage.reduce((sum, image) => sum + image.bytesAfter, 0),
    };
  }

  if (phase === 'result' && applied.ladderStep !== undefined && input.targetLabel) {
    if (applied.lossless) {
      lines.unshift(`To fit under ${input.targetLabel}, no image had to be re-encoded.`);
    } else {
      const size = applied.imageScale < 1 ? `at ${scalePercent(applied.imageScale)} of their width and height` : 'at their full width and height';
      facts.targetApplied = `To ${input.targetMissed ? 'come as close as possible to' : 'fit under'} ${input.targetLabel}, images were set to JPEG quality ${applied.jpegQuality} ${size}.`;
      if (applied.imageScale <= HARSH_IMAGE_SCALE) {
        facts.qualityWarning =
          'This is the harsh end of what Target size does: images lost more than half their width and height. Check the pages before you download.';
      }
    }
  }

  return facts;
}

/** "Images on this page: 245 KB → 61 KB". */
export function pageBytesLine(bytes: { before: number; after: number }): string {
  return `Images on this page: ${formatBytes(bytes.before)} → ${formatBytes(bytes.after)}`;
}
