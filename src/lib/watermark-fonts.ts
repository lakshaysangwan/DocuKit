/**
 * Watermark fonts: the three bold standard PDF fonts, and how wide a line of
 * text is in each.
 *
 * The watermark is written with a standard font (no font file is embedded), so
 * its width on the page is fixed by the font's published metrics rather than
 * by whatever font the browser has. The preview sizes every watermark from
 * these same numbers, so the box drawn on screen is the box written to the file.
 *
 * The standard fonts can only draw the WinAnsi (Western European) characters;
 * `unsupportedChars` lists what a text uses outside that set, so the tool can
 * say so before anything is written.
 *
 * Generated from pdf-lib's own copies of Adobe's AFM files; a unit test checks
 * every width against pdf-lib.
 *
 * Pure: no DOM, no pdf-lib.
 */

export type WatermarkFont = 'Helvetica-Bold' | 'Times-Bold' | 'Courier-Bold';

export const WATERMARK_FONTS: readonly { value: WatermarkFont; label: string; css: string }[] = [
  { value: 'Helvetica-Bold', label: 'Helvetica', css: "Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif" },
  { value: 'Times-Bold', label: 'Times', css: "'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif" },
  { value: 'Courier-Bold', label: 'Courier', css: "'Courier New', Courier, 'Liberation Mono', 'Nimbus Mono PS', monospace" },
];

/** Every character the standard fonts can draw, in the order of the width tables. */
const CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ ¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™";

interface Metrics {
  /** Top of the font's letters above the baseline, in thousandths of the size. */
  ascent: number;
  /** Bottom of its descenders below the baseline (negative), in thousandths of the size. */
  descent: number;
  widths: readonly number[];
}

// prettier-ignore
const METRICS: Record<WatermarkFont, Metrics> = {
  'Helvetica-Bold': {
    ascent: 718,
    descent: -207,
    widths: [
      278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
      556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
      667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
      611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 278,
      333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333,
      365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722,
      778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556,
      556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556, 1000, 944,
      667, 556, 556, 611, 500, 556, 333, 333, 556, 1000, 278, 278, 278, 500, 500, 500, 556, 556, 350, 1000, 1000, 333, 333, 556,
      1000,
    ],
  },
  'Times-Bold': {
    ascent: 683,
    descent: -217,
    widths: [
      250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500,
      500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
      611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500,
      556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520, 250,
      333, 500, 500, 500, 500, 220, 500, 333, 747, 300, 500, 570, 747, 333, 400, 570, 300, 300, 333, 556, 540, 250, 333, 300,
      330, 500, 750, 750, 750, 500, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 389, 389, 389, 389, 722, 722,
      778, 778, 778, 778, 778, 570, 778, 722, 722, 722, 722, 722, 611, 556, 500, 500, 500, 500, 500, 500, 722, 444, 444, 444,
      444, 444, 278, 278, 278, 278, 500, 556, 500, 500, 500, 500, 500, 570, 500, 556, 556, 556, 556, 500, 556, 500, 1000, 722,
      556, 389, 500, 667, 444, 500, 333, 333, 500, 1000, 333, 333, 333, 500, 500, 500, 500, 500, 350, 1000, 1000, 333, 333, 500,
      1000,
    ],
  },
  'Courier-Bold': {
    ascent: 629,
    descent: -157,
    widths: [
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600,
      600,
    ],
  },
};

const INDEX = new Map<string, number>(Array.from(CHARS, (c, i) => [c, i] as const));

export function isWatermarkFont(value: unknown): value is WatermarkFont {
  return value === 'Helvetica-Bold' || value === 'Times-Bold' || value === 'Courier-Bold';
}

/** The characters of `text` a standard font cannot draw, each once, in order. */
export function unsupportedChars(text: string): string[] {
  const out: string[] = [];
  for (const c of text) if (!INDEX.has(c) && !out.includes(c)) out.push(c);
  return out;
}

/** Width of `text` as a multiple of the font size. Characters the font cannot draw count as nothing. */
export function textWidthEm(font: WatermarkFont, text: string): number {
  const { widths } = METRICS[font];
  let total = 0;
  for (const c of text) {
    const i = INDEX.get(c);
    if (i !== undefined) total += widths[i];
  }
  return total / 1000;
}

/** Ascent and descent (negative) as multiples of the font size. */
export function fontExtentEm(font: WatermarkFont): { ascent: number; descent: number } {
  const { ascent, descent } = METRICS[font];
  return { ascent: ascent / 1000, descent: descent / 1000 };
}
