/**
 * Getting an image ready to be a PDF page.
 *
 * A PDF can hold a JPEG or a PNG as it is, and nothing else. It also knows
 * nothing about a photo's EXIF orientation: a phone photo taken upright is
 * often stored sideways with a "turn me" note that browsers obey and PDF
 * readers never see. So before an image is embedded it is made into one of the
 * two formats, upright:
 *
 *   JPEG, upright already      embedded as it is — no quality is lost
 *   JPEG with an orientation   redrawn upright, re-encoded as JPEG
 *   PNG                        embedded as it is
 *   anything else              decoded, re-encoded as PNG when it has
 *   (WebP, GIF, BMP, HEIC)     transparency and as JPEG when it has none
 *
 * The result carries the pixel size the page layout must use and the exact
 * bytes that will be embedded, so a preview drawn from it cannot differ from
 * the file.
 */
import { decodeHeic } from './image-codec';

/** JPEG quality used whenever an image has to be re-encoded (canvas scale, 0–1). */
export const REENCODE_JPEG_QUALITY = 0.92;

export type EmbedMime = 'image/jpeg' | 'image/png';

export interface PreparedImage {
  /** What will be embedded. The original file when nothing had to change. */
  blob: Blob;
  mime: EmbedMime;
  /** Pixel size of `blob`, upright. */
  width: number;
  height: number;
  /** False when the original bytes are used untouched. */
  reencoded: boolean;
  /** True when it was re-encoded only to undo a stored orientation. */
  turned: boolean;
}

export type SniffedType = 'jpeg' | 'png' | 'other';

/** What a file is, from its first bytes — its name and MIME type can both lie. */
export function sniffImageType(bytes: Uint8Array): SniffedType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  return 'other';
}

export interface JpegInfo {
  /** EXIF orientation, 1–8. 1 (upright) when the file says nothing. */
  orientation: number;
  /** Stored pixel size from the frame header, when it was within the bytes given. */
  width?: number;
  height?: number;
}

/** Read the EXIF orientation out of an APP1 segment's payload. */
function exifOrientation(view: DataView, start: number, length: number): number | null {
  // "Exif\0\0", then a TIFF header.
  if (length < 14 || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return null;
  const tiff = start + 6;
  const end = start + length;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 0x002a) return null;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/**
 * Walk a JPEG's segments for its EXIF orientation and stored size. Works on
 * the start of a file: whatever lies beyond `bytes` is simply not reported.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo {
  const info: JpegInfo = { orientation: 1 };
  if (sniffImageType(bytes) !== 'jpeg') return info;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientationSeen = false;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // Markers with no length: restart markers, SOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan
    const length = view.getUint16(at + 2);
    const payload = at + 4;
    const payloadLength = length - 2;
    if (length < 2) break;
    if (marker === 0xe1 && !orientationSeen && payload + payloadLength <= bytes.length) {
      const found = exifOrientation(view, payload, payloadLength);
      if (found !== null) {
        info.orientation = found;
        orientationSeen = true;
      }
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && payload + 5 <= bytes.length) {
      info.height = view.getUint16(payload + 1);
      info.width = view.getUint16(payload + 3);
      break;
    }
    at = payload + payloadLength;
  }
  return info;
}

/** A PNG's stored pixel size, from its IHDR chunk. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffImageType(bytes) !== 'png' || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/* ── Browser only below ───────────────────────────────────────────────────── */

/** How much of a file is read to find its type, orientation and stored size. */
const HEAD_BYTES = 512 * 1024;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decode with an <img>, which is what the preview uses and which applies EXIF
 * orientation in every current browser. For what the browser cannot decode
 * (HEIC outside Safari) fall back to libheif.
 */
async function decode(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('not decodable by the browser'));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
  }
  const bitmap = await decodeHeic(file);
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

function toBlob(canvas: HTMLCanvasElement, type: EmbedMime): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, type === 'image/jpeg' ? REENCODE_JPEG_QUALITY : undefined));
}

/** Redraw a decoded image and encode it as PNG or JPEG. `as: 'auto'` picks by transparency. */
async function reencode(decoded: Decoded, as: EmbedMime | 'auto'): Promise<{ blob: Blob; mime: EmbedMime }> {
  const canvas = document.createElement('canvas');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: as === 'auto' });
  if (!ctx) throw new Error('This image is too large to convert in this browser.');
  try {
    ctx.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
    const mime: EmbedMime =
      as === 'auto' ? (hasTransparency(ctx, decoded.width, decoded.height) ? 'image/png' : 'image/jpeg') : as;
    if (mime === 'image/jpeg') {
      // JPEG has no transparency; anything see-through would come out black.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, decoded.width, decoded.height);
    }
    const blob = await toBlob(canvas, mime);
    if (!blob) throw new Error('This image is too large to convert in this browser.');
    return { blob, mime };
  } finally {
    // Give the pixels back now rather than whenever the canvas is collected.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Make `file` embeddable. Rejects with a message fit to show the visitor when
 * the image cannot be read at all.
 */
export async function prepareImageForPdf(file: Blob): Promise<PreparedImage> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const type = sniffImageType(head);

  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error('This image could not be read.');
  }

  try {
    if (type === 'jpeg') {
      const info = readJpegInfo(head);
      if (info.orientation === 1) {
        // Embedded untouched. The stored size is what the PDF will use.
        return {
          blob: file,
          mime: 'image/jpeg',
          width: info.width ?? decoded.width,
          height: info.height ?? decoded.height,
          reencoded: false,
          turned: false,
        };
      }
      const { blob, mime } = await reencode(decoded, 'image/jpeg');
      return { blob, mime, width: decoded.width, height: decoded.height, reencoded: true, turned: true };
    }

    if (type === 'png') {
      const stored = readPngSize(head);
      // A PNG can carry an orientation too (rare). If the browser shows it at a
      // different size from the one stored, redraw it the way it is shown.
      if (!stored || (stored.width === decoded.width && stored.height === decoded.height)) {
        return { blob: file, mime: 'image/png', width: decoded.width, height: decoded.height, reencoded: false, turned: false };
      }
      const { blob, mime } = await reencode(decoded, 'image/png');
      return { blob, mime, width: decoded.width, height: decoded.height, reencoded: true, turned: true };
    }

    const { blob, mime } = await reencode(decoded, 'auto');
    return { blob, mime, width: decoded.width, height: decoded.height, reencoded: true, turned: false };
  } finally {
    decoded.release();
  }
}
