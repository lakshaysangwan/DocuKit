/**
 * Convert Image: the pure parts — which formats it writes, what they are
 * called on screen, what the download is named, and what the visitor is told
 * about a result.
 *
 * Everything said about a result is built from `ConvertImageStats`, which the
 * conversion fills in from the bytes it returns, so each sentence is true of
 * the file that downloads. Pure, so it is unit-tested.
 */
import { extForMime, formatName, savedPercent } from './compress-image';
import { formatBytes } from './utils';
import type { CompressImageFormat, ConvertImageStats } from '../types/worker-messages';

export type ConvertFormat = CompressImageFormat;

/** The formats Convert Image writes, in the order they are offered. */
export const CONVERT_FORMATS: ConvertFormat[] = ['jpeg', 'png', 'webp', 'avif'];

/** Quality for the lossy formats until the visitor moves the slider. */
export const DEFAULT_QUALITY = 85;

/** The button and action labels: "JPG" is what people search for and what the task pages say. */
export const CONVERT_LABEL: Record<ConvertFormat, string> = {
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  avif: 'AVIF',
};

/** Whether a format can store transparent pixels. */
export const keepsAlpha = (format: ConvertFormat) => format !== 'jpeg';

/** "holiday.png" + JPEG bytes → "holiday.jpg". The extension always follows the bytes. */
export function convertedFileName(inputName: string, mime: string): string {
  const base = inputName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${extForMime(mime)}`;
}

export interface ConvertFact {
  /** Stable id: `fact-<key>` in the page. */
  key: 'format' | 'quality' | 'pixels' | 'bytes' | 'transparency' | 'frames' | 'metadata';
  text: string;
}

export interface ConvertFacts {
  /** One short line: "PNG → JPG · 64% smaller". */
  outcome: string;
  facts: ConvertFact[];
}

/** The facts about one converted image, in plain sentences, from the stats of the bytes that will download. */
export function buildConvertFacts(originalBytes: number, outputBytes: number, s: ConvertImageStats): ConvertFacts {
  const facts: ConvertFact[] = [];
  const from = s.inputMime ? formatName(s.inputMime) : 'your image';
  const to = formatName(s.mime);
  const saved = savedPercent(originalBytes, outputBytes);

  facts.push({ key: 'format', text: s.inputMime ? `Format: ${from} → ${to}` : `Format: ${to}` });
  facts.push({
    key: 'quality',
    text:
      s.quality === null
        ? 'Quality: lossless — PNG keeps every pixel exactly, so there is no quality setting.'
        : `Quality: ${s.quality}`,
  });
  facts.push({ key: 'pixels', text: `Pixel size: ${s.width} × ${s.height} px (unchanged)` });
  facts.push({
    key: 'bytes',
    text: `Size: ${formatBytes(originalBytes)} → ${formatBytes(outputBytes)}${
      saved > 0 ? ` (${saved}% smaller)` : saved < 0 ? ` (${-saved}% larger)` : ''
    }`,
  });
  if (s.flattenedOnWhite) {
    facts.push({
      key: 'transparency',
      text: `Transparent areas are filled with white, because ${to} cannot store transparency.`,
    });
  } else if (s.hadTransparency) {
    facts.push({ key: 'transparency', text: `Transparency kept: ${to} stores it.` });
  }
  if (s.inputMime === 'image/gif') {
    facts.push({ key: 'frames', text: 'A GIF is converted as a still image: its first frame.' });
  }
  facts.push({
    key: 'metadata',
    text: 'Metadata: none — the image is saved again from its pixels, so EXIF (camera, location, date) is not copied. A photo is kept the way up it is shown.',
  });

  const change = saved > 0 ? `${saved}% smaller` : saved < 0 ? `${-saved}% larger` : 'the same size';
  return { outcome: `${s.inputMime ? `${from} → ` : ''}${to} · ${change}`, facts };
}
