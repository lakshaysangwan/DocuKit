/**
 * Watermark fonts: the three bold standard PDF fonts.
 *
 * Their metrics — and the WinAnsi check — live in `standard-fonts.ts`, shared
 * with Add Page Numbers; this module names the three a watermark may use.
 *
 * Pure: no DOM, no pdf-lib.
 */
import { STANDARD_FONT_CSS } from './standard-fonts';

export { fontExtentEm, textWidthEm, unsupportedChars } from './standard-fonts';

export type WatermarkFont = 'Helvetica-Bold' | 'Times-Bold' | 'Courier-Bold';

export const WATERMARK_FONTS: readonly { value: WatermarkFont; label: string; css: string }[] = [
  { value: 'Helvetica-Bold', label: 'Helvetica', css: STANDARD_FONT_CSS.helvetica },
  { value: 'Times-Bold', label: 'Times', css: STANDARD_FONT_CSS.times },
  { value: 'Courier-Bold', label: 'Courier', css: STANDARD_FONT_CSS.courier },
];

export function isWatermarkFont(value: unknown): value is WatermarkFont {
  return value === 'Helvetica-Bold' || value === 'Times-Bold' || value === 'Courier-Bold';
}
