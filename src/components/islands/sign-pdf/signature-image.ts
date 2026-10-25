/**
 * Turning what the visitor drew, typed or uploaded into the image that is
 * stamped on the page: trimmed to its ink, never clipped, never stretched.
 *
 * Browser-only (canvas). The pixel work itself is in `lib/sign/ink-bounds.ts`,
 * which is unit-tested.
 */
import { findInkBounds, hasTransparency, padBounds } from '@/lib/sign/ink-bounds';
import { decodeToBitmap } from '@/lib/image-codec';
import {
  extractInk,
  prepareSignature,
  workingScale,
  type ExtractOptions,
  type PreparedSignature,
  type RgbaImage,
} from '@/lib/sign/signature-extract';
import type { SignatureWorkerRequest, SignatureWorkerResponse } from '@/workers/signature-worker';

/** A signature or initials image, and its shape. Stamps point at one of these. */
export interface SigAsset {
  /** PNG (transparent) or JPEG (a photo of a signature) data URL. */
  dataUrl: string;
  /** Width ÷ height of the image. */
  aspect: number;
}

/** Longest side kept for a signature image; more would only bloat the PDF. */
const MAX_EDGE_PX = 1200;
/** Clear pixels left around the ink so antialiased edges are not cut. */
const INK_PADDING_PX = 2;
const JPEG_QUALITY = 0.92;

const SAVED_KEY = 'docukit-signature';

/**
 * Handwriting styles for a typed signature. `stack` is used for both the
 * preview (CSS) and the image (canvas), so the two always match.
 *
 * Each names its web font first (public/fonts, Latin and Latin Extended,
 * declared in global.css) and then script fonts that ship with Windows, macOS,
 * iOS and Android, for letters the web font does not have (Greek, Cyrillic…).
 */
export const SIGNATURE_FONTS = [
  { name: 'Flowing', web: 'Dancing Script', stack: '"Dancing Script", "Segoe Script", "Snell Roundhand", "Apple Chancery", cursive' },
  { name: 'Casual', web: 'Caveat', stack: '"Caveat", "Segoe Print", "Bradley Hand", "Chalkboard SE", cursive' },
  { name: 'Brush', web: 'Pacifico', stack: '"Pacifico", "Brush Script MT", "Lucida Handwriting", "Savoye LET", cursive' },
  { name: 'Formal', web: 'Sacramento', stack: '"Sacramento", "Lucida Handwriting", "Zapfino", "Segoe Script", cursive' },
] as const;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = src;
  });
}

/**
 * Crop a drawing to its ink. Returns null when there is no ink at all (a blank
 * pad, a plain white picture).
 */
export function trimToInk(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): SigAsset | null {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const full = document.createElement('canvas');
  full.width = width;
  full.height = height;
  const ctx = full.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;

  const ink = findInkBounds(pixels, width, height);
  if (!ink) return null;
  const box = padBounds(ink, INK_PADDING_PX, width, height);

  const out = document.createElement('canvas');
  out.width = box.width;
  out.height = box.height;
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(full, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);

  // A photo has no transparency to keep, and is far smaller as a JPEG.
  const transparent = hasTransparency(pixels);
  const dataUrl = transparent ? out.toDataURL('image/png') : out.toDataURL('image/jpeg', JPEG_QUALITY);
  full.width = full.height = 0;
  return { dataUrl, aspect: box.width / box.height };
}

/** The signature pad's canvas, trimmed. Null when nothing has been drawn. */
export function signatureFromCanvas(canvas: HTMLCanvasElement): SigAsset | null {
  return trimToInk(canvas, canvas.width, canvas.height);
}

/**
 * Text in one of the handwriting fonts. The canvas is sized from the text, so a
 * long name is never cut off, and then trimmed to the ink.
 */
export async function signatureFromText(text: string, fontIndex: number): Promise<SigAsset | null> {
  const font = SIGNATURE_FONTS[fontIndex] ?? SIGNATURE_FONTS[0];
  const sizePx = 96;
  // Wait for the web font (and, through unicode-range, only the subsets these
  // letters need) before drawing: a canvas does not wait, and would draw the
  // first signature in the fallback font.
  try {
    await document.fonts.load(`${sizePx}px "${font.web}"`, text);
  } catch {
    // The fallback font still gives a usable signature.
  }

  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  if (!measure) return null;
  measure.font = `${sizePx}px ${font.stack}`;
  const metrics = measure.measureText(text);
  // Script fonts swing well outside their advance width; leave a full em each
  // side and let the trim remove what was not needed.
  canvas.width = Math.min(8000, Math.ceil(metrics.width + sizePx * 2));
  canvas.height = sizePx * 3;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${sizePx}px ${font.stack}`;
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, sizePx, canvas.height / 2);
  return trimToInk(canvas, canvas.width, canvas.height);
}

/** A picture of a signature, decoded upright and reduced to the working size. */
export interface SignaturePhoto {
  /** The picture at working size (long edge at most 2000 px). */
  canvas: HTMLCanvasElement;
  pixels: ImageData;
  /** Whether it already has see-through pixels (a PNG cut out beforehand). */
  transparent: boolean;
}

/**
 * Decode an uploaded picture: JPEG, PNG, WebP natively, HEIC/HEIF (and AVIF
 * where the browser cannot) through the shared codecs. EXIF orientation is
 * applied, so a phone photo comes out upright.
 */
export async function readSignaturePhoto(file: File): Promise<SignaturePhoto> {
  const bitmap = await decodeToBitmap(file);
  try {
    const scale = workingScale(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No canvas.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    return { canvas, pixels, transparent: hasTransparency(pixels.data) };
  } finally {
    bitmap.close();
  }
}

/** The picture as it is, trimmed to what is not white paper (the "Original" choice). */
export function signatureFromPhoto(photo: SignaturePhoto): SigAsset | null {
  return trimToInk(photo.canvas, photo.canvas.width, photo.canvas.height);
}

/** Cleaned ink as the stamp image: a PNG with alpha, so the page shows through. */
export function signatureFromInk(ink: RgbaImage): SigAsset | null {
  if (!ink.width || !ink.height) return null;
  const full = document.createElement('canvas');
  full.width = ink.width;
  full.height = ink.height;
  const ctx = full.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(ink.data), ink.width, ink.height), 0, 0);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(ink.width, ink.height));
  let out = full;
  if (scale < 1) {
    out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(ink.width * scale));
    out.height = Math.max(1, Math.round(ink.height * scale));
    const outCtx = out.getContext('2d');
    if (!outCtx) return null;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(full, 0, 0, out.width, out.height);
  }
  const dataUrl = out.toDataURL('image/png');
  return { dataUrl, aspect: out.width / out.height };
}

/**
 * Runs the ink extraction in a worker (it takes over 100 ms on a phone
 * photo), keeping the prepared photo there between slider moves. Falls back
 * to running in the page where a worker cannot start.
 */
export class InkExtractor {
  private worker: Worker | null = null;
  private inline: PreparedSignature | null = null;
  private pixels: ImageData | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: SignatureWorkerResponse) => void; reject: (e: Error) => void }>();

  constructor() {
    try {
      this.worker = new Worker(new URL('../../../workers/signature-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<SignatureWorkerResponse>) => {
        const job = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        job?.resolve(e.data);
      };
      this.worker.onerror = () => this.fallBack();
    } catch {
      this.worker = null;
    }
  }

  /** Stop using the worker; every waiting request is answered in the page. */
  private fallBack() {
    this.worker?.terminate();
    this.worker = null;
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const job of jobs) job.reject(new Error('worker'));
  }

  private send(msg: SignatureWorkerRequest, transfer: Transferable[] = []): Promise<SignatureWorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      this.worker!.postMessage(msg, transfer);
    });
  }

  async prepare(pixels: ImageData): Promise<void> {
    this.pixels = pixels;
    this.inline = null;
    if (this.worker) {
      const buffer = pixels.data.slice().buffer;
      try {
        const r = await this.send({ id: this.nextId++, type: 'prepare', width: pixels.width, height: pixels.height, buffer }, [buffer]);
        if (!r.ok) throw new Error(r.error);
        return;
      } catch {
        this.fallBack();
      }
    }
    this.inline = prepareSignature(pixels);
  }

  async extract(options: ExtractOptions): Promise<RgbaImage | null> {
    if (this.worker) {
      try {
        const r = await this.send({ id: this.nextId++, type: 'extract', options });
        if (!r.ok) throw new Error(r.error);
        return r.ink ? { data: new Uint8ClampedArray(r.ink.buffer), width: r.ink.width, height: r.ink.height } : null;
      } catch {
        this.fallBack();
      }
    }
    if (!this.inline && this.pixels) this.inline = prepareSignature(this.pixels);
    if (!this.inline) return null;
    return extractInk(this.inline, options)?.image ?? null;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.inline = null;
    this.pixels = null;
  }
}

/**
 * Remember the signature for this tab. sessionStorage only: it is gone when the
 * tab closes and is never sent anywhere.
 */
export function saveSignature(asset: SigAsset): void {
  try {
    sessionStorage.setItem(SAVED_KEY, asset.dataUrl);
  } catch {
    // Storage is full or blocked: the signature simply is not remembered.
  }
}

export function forgetSignature(): void {
  try {
    sessionStorage.removeItem(SAVED_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** The signature saved earlier in this tab, if there is one and it still decodes. */
export async function loadSavedSignature(): Promise<SigAsset | null> {
  let dataUrl: string | null;
  try {
    dataUrl = sessionStorage.getItem(SAVED_KEY);
  } catch {
    return null;
  }
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return null;
  try {
    const img = await loadImage(dataUrl);
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return { dataUrl, aspect: img.naturalWidth / img.naturalHeight };
  } catch {
    return null;
  }
}

/** "Ada Lovelace" → "AL". Falls back to the first two characters. */
export function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join('');
}
