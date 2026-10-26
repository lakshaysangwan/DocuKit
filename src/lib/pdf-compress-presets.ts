/**
 * Compress PDF's levels, in one place, so the controls, the run, the live
 * preview and the facts shown about them all read the same numbers.
 */
import type { CompressPdfOptions } from '../types/worker-messages';

export type CompressLevel = 'low' | 'medium' | 'high' | 'custom' | 'target';

/**
 * The three fixed levels. `dpi` is a real resolution: an image drawn on the
 * page sharper than this is reduced to it (`pdf-image-placement.ts` works out
 * how sharp each image is where it is drawn). Low re-encodes nothing, so its
 * values are not used. High's 96 DPI is what the page shows at 100% on an
 * ordinary screen.
 */
export const LEVEL_PRESETS = {
  low: { dpi: 300, jpegQuality: 90 },
  medium: { dpi: 150, jpegQuality: 75 },
  high: { dpi: 96, jpegQuality: 50 },
} as const;

export interface CompressSettings {
  level: CompressLevel;
  /** Custom only: target resolution in DPI. */
  dpi: number;
  /** Custom only, 1–100. */
  jpegQuality: number;
  /** Custom only. */
  grayscale: boolean;
  /** Target size only, in bytes. */
  targetBytes: number;
}

/**
 * At or below this image scale the result is "the harsh end": images have lost
 * more than half their width and height. Target size warns about it.
 */
export const HARSH_IMAGE_SCALE = 0.5;

/** What the worker is asked to do for these settings. */
export function compressOptionsFor(s: CompressSettings): CompressPdfOptions {
  if (s.level === 'target') return { level: 'custom', targetBytes: s.targetBytes, report: true };
  if (s.level === 'custom') {
    return { level: 'custom', dpi: s.dpi, jpegQuality: s.jpegQuality, grayscale: s.grayscale, report: true };
  }
  const preset = LEVEL_PRESETS[s.level];
  return { level: s.level, dpi: preset.dpi, jpegQuality: preset.jpegQuality, grayscale: false, report: true };
}

/** The same, for a one-page quality preview. */
export function previewOptionsFor(s: CompressSettings): CompressPdfOptions {
  return { ...compressOptionsFor(s), preview: true };
}

/**
 * A key that changes exactly when the output would: settings a level ignores
 * are left out, so moving the Custom sliders does not invalidate a Medium preview.
 */
export function settingsKey(s: CompressSettings): string {
  const o = compressOptionsFor(s);
  return JSON.stringify([o.level, o.dpi, o.jpegQuality, o.grayscale, o.targetBytes]);
}
