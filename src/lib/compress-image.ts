/**
 * Compress Image: the pure parts — what format some bytes really are, how a
 * target size is searched for, how transparency is flattened for JPEG, what the
 * download is called, and what the visitor is told about a result.
 *
 * Everything said about a result is built from `CompressImageStats`, which the
 * compression pass fills in from the bytes it returns, so each sentence is true
 * of the file that downloads. Pure, so it is unit-tested.
 */
import { formatBytes } from './utils';
import type { CompressImageFormat, CompressImageStats } from '../types/worker-messages';

/** Lowest and highest quality the target-size search tries. */
export const TARGET_MIN_QUALITY = 5;
export const TARGET_MAX_QUALITY = 95;

/**
 * Above this many pixels the quality preview waits to be asked for instead of
 * following the slider: each update would take seconds.
 */
export const LIVE_PIXEL_LIMIT = 12_000_000;

/** The formats a lossy quality setting applies to. PNG has none. */
export const hasQuality = (format: CompressImageFormat) => format !== 'png';

/** Whether the quality preview follows the slider for this format and size (AVIF is slow to encode). */
export function canPreviewLive(format: CompressImageFormat, pixels: number): boolean {
  return (format === 'jpeg' || format === 'webp') && pixels > 0 && pixels <= LIVE_PIXEL_LIMIT;
}

const FORMAT_MIME: Record<CompressImageFormat, string> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  png: 'image/png',
  avif: 'image/avif',
};

export const mimeForFormat = (format: CompressImageFormat) => FORMAT_MIME[format];

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/**
 * The real format of encoded image bytes, from their signature — never from a
 * file name or a requested format. Null when it is not one this site knows.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brands = ascii(bytes, 8, Math.min(bytes.length, 40));
    if (/avi[fs]/.test(brands)) return 'image/avif';
    if (/hei[cfsx]|mif1|msf1|hevc/.test(brands)) return 'image/heic';
  }
  return null;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
};

const NAME: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/heic': 'HEIC',
};

export const extForMime = (mime: string) => EXT[mime] ?? 'img';
export const formatName = (mime: string) => NAME[mime] ?? 'image';
export const formatLabel = (format: CompressImageFormat) => NAME[FORMAT_MIME[format]];

/** "holiday.png" + WebP bytes → "holiday-compressed.webp". */
export function outputFileName(inputName: string, mime: string): string {
  const base = inputName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}-compressed.${extForMime(mime)}`;
}

/** Make names unique, as a ZIP and a folder need: the second "a.jpg" becomes "a (2).jpg". */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const taken = new Set(names.map((n) => n.toLowerCase()));
  return names.map((name) => {
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let k = n;
    let candidate = `${stem} (${k})${ext}`;
    while (taken.has(candidate.toLowerCase())) candidate = `${stem} (${++k})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** True when any pixel of RGBA data is not fully opaque. */
export function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

/**
 * Composite RGBA pixels onto white, in place, leaving every pixel opaque. JPEG
 * cannot store transparency; without this its encoder keeps the colour under a
 * transparent pixel, which is usually black.
 */
export function flattenOnWhite(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    rgba[i] = Math.round(rgba[i] * k + 255 * (1 - k));
    rgba[i + 1] = Math.round(rgba[i + 1] * k + 255 * (1 - k));
    rgba[i + 2] = Math.round(rgba[i + 2] * k + 255 * (1 - k));
    rgba[i + 3] = 255;
  }
}

export interface TargetSearchResult {
  bytes: ArrayBuffer;
  quality: number;
  /** Whether `bytes` is within the target. When false, `bytes` is the smallest reached (the lowest quality). */
  met: boolean;
}

/**
 * The highest quality whose encode fits in `targetBytes`. Tries the top
 * quality first (a small image fits at once), then the lowest (if even that
 * does not fit, the target cannot be met and the smallest result is returned),
 * then halves the range between them. File size rises with quality, so this
 * finds the exact quality in at most about nine encodes.
 */
export async function searchTargetQuality(
  encodeAt: (quality: number) => Promise<ArrayBuffer>,
  targetBytes: number,
  min = TARGET_MIN_QUALITY,
  max = TARGET_MAX_QUALITY,
): Promise<TargetSearchResult> {
  const top = await encodeAt(max);
  if (top.byteLength <= targetBytes) return { bytes: top, quality: max, met: true };
  const bottom = await encodeAt(min);
  if (bottom.byteLength > targetBytes) return { bytes: bottom, quality: min, met: false };
  let lo = min;
  let loBytes = bottom;
  let hi = max;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const encoded = await encodeAt(mid);
    if (encoded.byteLength <= targetBytes) {
      lo = mid;
      loBytes = encoded;
    } else {
      hi = mid;
    }
  }
  return { bytes: loBytes, quality: lo, met: true };
}

/* ── What the visitor is told ─────────────────────────────────────────────── */

export interface ImageFact {
  /** Stable id: `fact-<key>` in the page. */
  key: 'format' | 'quality' | 'pixels' | 'bytes' | 'saved' | 'background' | 'metadata' | 'original' | 'target-missed';
  text: string;
}

export interface ImageFacts {
  /** One short line: "64% smaller" / "Original kept" / "Not under 100 KB". */
  outcome: string;
  /** Whole percent saved; negative when the output is larger. */
  savedPct: number;
  /** The output is not what the visitor asked for (original kept, or target missed). */
  warning: boolean;
  facts: ImageFact[];
}

/** Whole percent saved going from `before` to `after` bytes; negative when larger. */
export function savedPercent(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}

/** Size limits are shown as typed, in this site's binary units. */
export const targetLabel = (bytes: number) => formatBytes(bytes, 0);

/**
 * The facts about one compressed image, in plain sentences, from the stats of
 * the bytes that will download.
 */
export function buildImageFacts(originalBytes: number, outputBytes: number, s: CompressImageStats): ImageFacts {
  const facts: ImageFact[] = [];
  const saved = savedPercent(originalBytes, outputBytes);
  const encodedName = formatLabel(s.encodedFormat);
  const tried =
    s.encodedQuality === null ? `as a lossless ${encodedName}` : `as ${encodedName} at quality ${s.encodedQuality}`;
  const targetMissed = !!s.target && !s.target.met;

  if (s.returnedOriginal) {
    facts.push({ key: 'format', text: `Format: ${formatName(s.mime)} — your original file, unchanged.` });
    facts.push({
      key: 'original',
      text: `Your original is kept: ${tried} it came to ${formatBytes(s.encodedBytes)}, which is not smaller than ${formatBytes(originalBytes)}.`,
    });
  } else {
    facts.push({ key: 'format', text: `Format: ${formatName(s.mime)}` });
    if (s.encodedQuality === null) {
      facts.push({ key: 'quality', text: 'Quality: lossless — PNG keeps every pixel exactly, so there is no quality setting.' });
    } else if (s.target?.met) {
      facts.push({
        key: 'quality',
        text: `Quality ${s.encodedQuality} was needed to fit under ${targetLabel(s.target.bytes)}.`,
      });
    } else {
      facts.push({ key: 'quality', text: `Quality: ${s.encodedQuality}` });
    }
  }

  facts.push({ key: 'pixels', text: `Pixel size: ${s.width} × ${s.height} px (unchanged)` });
  facts.push({ key: 'bytes', text: `Size: ${formatBytes(originalBytes)} → ${formatBytes(outputBytes)}` });
  facts.push({
    key: 'saved',
    text: s.returnedOriginal
      ? 'Saved: nothing — the file is your original.'
      : saved > 0
        ? `Saved: ${saved}%`
        : saved === 0
          ? 'Saved: nothing — the same size as your original.'
          : `Saved: nothing — ${-saved}% larger than your original.`,
  });

  if (targetMissed && s.target) {
    facts.push({
      key: 'target-missed',
      text: `Could not get under ${targetLabel(s.target.bytes)}: ${
        s.returnedOriginal
          ? `even ${tried} it came to ${formatBytes(s.encodedBytes)}, so your original (${formatBytes(outputBytes)}) is kept.`
          : `the smallest this image gets is ${formatBytes(outputBytes)}, ${tried}.`
      } Make it smaller in pixels with Resize Image, then try again.`,
    });
  }

  if (s.flattenedOnWhite && !s.returnedOriginal) {
    facts.push({
      key: 'background',
      text: 'Transparent areas are filled with white, because JPEG cannot store transparency.',
    });
  }

  facts.push({
    key: 'metadata',
    text: s.returnedOriginal
      ? 'Metadata: kept as it was in your original, EXIF included.'
      : 'Metadata: none — the image is re-encoded from its pixels, so EXIF (camera, location, date) is not carried over.',
  });

  let outcome: string;
  if (targetMissed && s.target) outcome = `Not under ${targetLabel(s.target.bytes)}`;
  else if (s.returnedOriginal) outcome = 'Original kept — compressing did not make it smaller';
  else if (saved > 0) outcome = `${saved}% smaller`;
  else outcome = saved === 0 ? 'The same size as your original' : `${-saved}% larger than your original`;

  return { outcome, savedPct: saved, warning: targetMissed || s.returnedOriginal || saved < 0, facts };
}
