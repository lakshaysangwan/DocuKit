/**
 * PDF compression as a plain function over an ArrayBuffer.
 *
 * Lives outside the worker (like `image-ops.ts`) because the image-recompression
 * step needs a 2D drawing surface: it runs inside `pdf-worker.ts` normally, and
 * inline on the main thread on browsers with no `OffscreenCanvas`, where a
 * worker cannot draw at all. One implementation, two realms.
 */
import { createCanvas2D } from './canvas-2d';
import { encodeImageData } from './image-codec';
import type { CompressPdfOptions } from '../types/worker-messages';
import type { PDFContext, PDFDict, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';

export type ProgressFn = (pct: number, label?: string) => void;

/**
 * Number of embedded images the last run had to skip. Individual images are
 * allowed to fail (exotic filters, odd colour spaces), but a run where EVERY
 * image is skipped silently returns a barely-smaller file while still reporting
 * success — the failure mode that made compress-pdf look like a no-op on
 * engines without OffscreenCanvas. `compressPdf` reports it so callers can tell
 * the difference between "nothing to compress" and "nothing worked".
 */
export interface CompressResult {
  buffer: ArrayBuffer;
  imagesTotal: number;
  imagesRecompressed: number;
}

export async function compressPdf(
  buffer: ArrayBuffer,
  options: CompressPdfOptions,
  sendProgress: ProgressFn
): Promise<CompressResult> {
  const result = options.targetBytes && options.targetBytes > 0
    ? await compressPdfToTarget(buffer, options.targetBytes, sendProgress)
    : await compressPdfOnce(buffer, options, sendProgress);
  // Re-saving a small, already-tight PDF can add a few bytes. Hand back the
  // original rather than a "compressed" file that is no smaller than the input.
  return result.buffer.byteLength < buffer.byteLength
    ? result
    : { ...result, buffer: buffer.slice(0), imagesRecompressed: 0 };
}

/**
 * Settings tried in target-size mode, gentlest first. Index 0 is the lossless
 * structural pass; each later step trades more image quality for size.
 */
const TARGET_LADDER: CompressPdfOptions[] = [
  { level: 'low' },
  // Quality first: lowering JPEG quality costs less visibly than discarding pixels.
  { level: 'custom', jpegQuality: 85, imageScale: 1 },
  { level: 'custom', jpegQuality: 75, imageScale: 1 },
  { level: 'custom', jpegQuality: 65, imageScale: 1 },
  { level: 'custom', jpegQuality: 55, imageScale: 1 },
  // Then resolution as well.
  { level: 'custom', jpegQuality: 60, imageScale: 0.75 },
  { level: 'custom', jpegQuality: 50, imageScale: 0.75 },
  { level: 'custom', jpegQuality: 50, imageScale: 0.6 },
  { level: 'custom', jpegQuality: 40, imageScale: 0.5 },
  { level: 'custom', jpegQuality: 35, imageScale: 0.4 },
  { level: 'custom', jpegQuality: 30, imageScale: 0.33 },
  { level: 'custom', jpegQuality: 25, imageScale: 0.25 },
];

/**
 * Compress to fit under `targetBytes`, keeping as much quality as will fit: the
 * result is the gentlest ladder step whose output is small enough.
 *
 * A whole pass costs seconds on a large file, so the ladder is not walked in
 * order. The lossless step is tried first (often enough by itself), then the
 * harshest step to learn whether the target is reachable at all, and only then
 * is the range between them bisected — at most six passes for twelve steps.
 *
 * Only images can be traded for size. When even the harshest step is too big —
 * a document that is mostly text or vector graphics — the smallest result is
 * returned anyway and the caller reports the miss; it is never an error.
 */
async function compressPdfToTarget(
  buffer: ArrayBuffer,
  targetBytes: number,
  sendProgress: ProgressFn,
): Promise<CompressResult> {
  const last = TARGET_LADDER.length - 1;
  // 2 fixed passes + ceil(log2(last - 1)) bisection passes.
  const maxPasses = 2 + Math.ceil(Math.log2(Math.max(2, last - 1)));
  let pass = 0;
  const attempt = async (step: number): Promise<CompressResult> => {
    const base = (pass / maxPasses) * 100;
    pass++;
    return compressPdfOnce(buffer, TARGET_LADDER[step], (pct, label) =>
      sendProgress(Math.min(99, Math.round(base + pct / maxPasses)), `Pass ${pass}: ${label ?? 'compressing…'}`));
  };
  const fits = (r: CompressResult) => r.buffer.byteLength <= targetBytes;

  const gentlest = await attempt(0);
  if (fits(gentlest) || buffer.byteLength <= targetBytes) return gentlest;

  const harshest = await attempt(last);
  if (!fits(harshest)) {
    return harshest.buffer.byteLength <= gentlest.buffer.byteLength ? harshest : gentlest;
  }

  // Invariant: step `hi` fits (and `best` is its result); steps below `lo` do not.
  let lo = 1;
  let hi = last;
  let best = harshest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const result = await attempt(mid);
    if (fits(result)) { best = result; hi = mid; } else { lo = mid + 1; }
  }
  return best;
}

async function compressPdfOnce(
  buffer: ArrayBuffer,
  options: CompressPdfOptions,
  sendProgress: ProgressFn
): Promise<CompressResult> {
  const pdfLib = await import('pdf-lib');
  const { PDFDocument, PDFName, PDFRawStream } = pdfLib;

  sendProgress(5, 'Loading PDF…');
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });

  // Determine JPEG quality from options
  const jpegQuality = (options.jpegQuality ?? 75) / 100;
  let imagesTotal = 0;
  let imagesRecompressed = 0;

  sendProgress(10, 'Stripping metadata…');
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');

  // Strip embedded fonts if requested
  if (options.stripFonts) {
    sendProgress(12, 'Stripping fonts (warning: text may become invisible)…');
    // We clear out the /Font mappings in every page's Resource dictionary
    doc.getPages().forEach((page) => {
      const res = page.node.Resources();
      if (res) {
        const fonts = res.get(PDFName.of('Font'));
        if (fonts && fonts.constructor.name === 'PDFDict') {
          const fDict = fonts as any;
          const kArray = fDict.keys();
          kArray.forEach((k: any) => fDict.delete(k));
        }
      }
    });
  }

  // Re-encode embedded images as JPEG — only those on the allow-list in
  // `planImagePass`; every other image is left exactly as it is.
  if (options.level !== 'low') {
    sendProgress(15, 'Compressing images…');
    const context = doc.context;
    const planned = planImagePass(pdfLib, context);
    // Downscale factor: explicit (target-size mode), or derived from the requested DPI.
    const scale = options.imageScale ?? (options.dpi && options.dpi < 150 ? options.dpi / 150 : 1);

    imagesTotal = planned.length;
    for (let i = 0; i < planned.length; i++) {
      const { ref, stream, plan } = planned[i];
      sendProgress(
        15 + Math.round(((i + 1) / planned.length) * 60),
        `Compressing image ${i + 1}/${planned.length}…`
      );
      if (!plan.reencode) continue;

      let bmp: ImageBitmap | undefined;
      try {
        const { width, height, channels } = plan;
        const rawBytes = stream.contents;
        if (rawBytes.byteLength < 1024) continue;

        if (plan.source === 'jpeg') {
          // Re-encoding a JPEG at high quality and the same size only costs a
          // generation of quality; it is worth doing when it is also downsampled.
          if (jpegQuality >= 0.9 && scale >= 1) continue;
          // The stream has to be the image its dictionary describes: a baseline
          // or progressive 8-bit JPEG of that size with that many components.
          // A CMYK JPEG labelled RGB, say, is not something to guess at.
          const frame = readJpegFrame(rawBytes);
          if (!frame || frame.width !== width || frame.height !== height || frame.components !== channels) continue;
          const blob = new Blob([rawBytes as BlobPart], { type: 'image/jpeg' });
          // 'none': the PDF's colour space says what the samples mean, so a
          // profile embedded in the JPEG itself must not be applied on top.
          bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
        } else {
          const pixelData = await inflate(rawBytes);
          // Exactly one byte per sample, or this is not the layout we think it is.
          if (pixelData.length !== width * height * channels) continue;

          const { canvas, ctx } = createCanvas2D(width, height);
          const imageData = ctx.createImageData(width, height);
          const data = imageData.data;
          for (let px = 0; px < width * height; px++) {
            if (channels === 3) {
              data[px * 4] = pixelData[px * 3];
              data[px * 4 + 1] = pixelData[px * 3 + 1];
              data[px * 4 + 2] = pixelData[px * 3 + 2];
            } else {
              data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = pixelData[px];
            }
            data[px * 4 + 3] = 255;
          }
          ctx.putImageData(imageData, 0, 0);
          bmp = await createImageBitmap(canvas);
        }

        let targetW = width;
        let targetH = height;
        if (scale < 1) {
          targetW = Math.max(1, Math.round(width * scale));
          targetH = Math.max(1, Math.round(height * scale));
        }

        const { ctx } = createCanvas2D(targetW, targetH);

        ctx.drawImage(bmp, 0, 0, targetW, targetH);

        if (options.grayscale) {
          const imgData = ctx.getImageData(0, 0, targetW, targetH);
          const d = imgData.data;
          for (let p = 0; p < d.length; p += 4) {
            const g = d[p] * 0.3 + d[p+1] * 0.59 + d[p+2] * 0.11;
            d[p] = d[p+1] = d[p+2] = g;
          }
          ctx.putImageData(imgData, 0, 0);
        }

        // Encode via jSquash/mozjpeg rather than the canvas encoder: canvas JPEG
        // output differs by engine (Firefox is markedly less efficient at the same
        // quality, enough that "Medium" stopped shrinking the file at all), while
        // mozjpeg is deterministic across engines and compresses better.
        const outData = ctx.getImageData(0, 0, targetW, targetH);
        const outBuf = new Uint8Array(
          await encodeImageData(outData, 'jpeg', Math.round(jpegQuality * 100)),
        );

        // Only replace if actually smaller
        if (outBuf.byteLength >= rawBytes.byteLength) continue;

        const newDict = replacementImageDict(pdfLib, context, stream.dict, {
          width: targetW,
          height: targetH,
          sourceChannels: channels,
          length: outBuf.byteLength,
        });
        context.assign(ref, PDFRawStream.of(newDict, outBuf));
        imagesRecompressed++;
      } catch {
        continue;
      } finally {
        bmp?.close();
      }
    }
  }

  sendProgress(85, 'Saving compressed PDF…');
  const savedBytes = await doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  // Final lossless structural pass: object streams + max-level flate recompression.
  // This is the only reduction at the "Low" tier (no image recompression there) and
  // squeezes extra bytes out of every tier. Falls back to the pdf-lib output if qpdf
  // can't improve on it.
  sendProgress(92, 'Optimizing structure…');
  try {
    const { qpdfCompress } = await import('../workers/qpdf-helper');
    const optimized = await qpdfCompress(new Uint8Array(savedBytes));
    if (optimized.byteLength < savedBytes.byteLength) {
      return {
        buffer: optimized.buffer.slice(
          optimized.byteOffset,
          optimized.byteOffset + optimized.byteLength,
        ) as ArrayBuffer,
        imagesTotal,
        imagesRecompressed,
      };
    }
  } catch {
    /* keep pdf-lib output */
  }

  return { buffer: savedBytes.buffer as ArrayBuffer, imagesTotal, imagesRecompressed };
}

// ─── Which images may be re-encoded ──────────────────────────────────────────

type PdfLib = typeof import('pdf-lib');

/**
 * What the lossy pass may do with one image XObject.
 *
 * Re-encoding means: decode the samples, optionally resample, write a JPEG. That
 * is only harmless when the samples are plain 8-bit grey or RGB values that mean
 * the same thing after the round trip. Anything else — transparency, an inverted
 * /Decode, palette indices, ink amounts, CMYK, predictor-filtered rows — comes
 * out visibly wrong, not merely softer. So this is an allow-list: an image is
 * re-encoded only when every one of these holds, and is otherwise left exactly
 * as it is, bytes and dictionary both.
 *
 *  - it is not used as another image's /SMask or /Mask, and is not a stencil
 *    (/ImageMask true) — a mask is alpha, not a picture;
 *  - it has no /SMask and no /Mask of its own (a JPEG has no alpha channel, and
 *    resampling or JPEG ringing would drag the colour hidden under transparent
 *    pixels into the visible ones);
 *  - /Filter is exactly /DCTDecode or /FlateDecode, with no /DecodeParms
 *    (so no PNG/TIFF predictor, and nothing chained);
 *  - /BitsPerComponent is 8;
 *  - /ColorSpace is /DeviceGray, /DeviceRGB, [/CalRGB …] or a three-component
 *    [/ICCBased …] with the default range;
 *  - /Decode is absent or the identity mapping.
 */
export type ImagePlan =
  | { reencode: false; reason: string }
  | { reencode: true; source: 'jpeg' | 'flate'; width: number; height: number; channels: 1 | 3 };

export interface PlannedImage {
  ref: PDFRef;
  stream: PDFRawStream;
  plan: ImagePlan;
}

const MAX_IMAGE_SIDE = 10000;

/** Every image XObject in the document, with the decision for each. */
export function planImagePass(lib: PdfLib, context: PDFContext): PlannedImage[] {
  const { PDFName, PDFRawStream } = lib;
  const images: Array<{ ref: PDFRef; stream: PDFRawStream }> = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
      images.push({ ref, stream: obj });
    }
  }

  // Masks are found before anything is decided: a mask stream is an image
  // XObject too, and looks exactly like a small grey photo unless you know what
  // points at it.
  const masks = new Set<PDFObject>();
  for (const { stream } of images) {
    for (const key of ['SMask', 'Mask']) {
      const target = stream.dict.lookup(PDFName.of(key));
      if (target instanceof PDFRawStream) masks.add(target);
    }
  }

  return images.map(({ ref, stream }) => ({
    ref,
    stream,
    plan: masks.has(stream)
      ? { reencode: false, reason: 'is the mask of another image' }
      : planImage(lib, stream.dict),
  }));
}

function planImage(lib: PdfLib, dict: PDFDict): ImagePlan {
  const { PDFName, PDFNumber, PDFBool, PDFArray } = lib;
  const get = (key: string) => dict.lookup(PDFName.of(key));
  const skip = (reason: string): ImagePlan => ({ reencode: false, reason });
  const int = (key: string) => {
    const value = get(key);
    return value instanceof PDFNumber && Number.isInteger(value.asNumber()) ? value.asNumber() : undefined;
  };

  if (get('ImageMask') === PDFBool.True) return skip('is a stencil mask');
  if (get('SMask') !== undefined) return skip('has a soft mask');
  if (get('Mask') !== undefined) return skip('has a stencil or colour-key mask');

  const filter = get('Filter');
  const source = filter === PDFName.of('DCTDecode') ? 'jpeg' : filter === PDFName.of('FlateDecode') ? 'flate' : undefined;
  if (!source) return skip('filter is not a single DCTDecode or FlateDecode');
  if (get('DecodeParms') !== undefined || get('DP') !== undefined) return skip('has decode parameters');

  const width = int('Width');
  const height = int('Height');
  if (!width || !height || width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return skip('has no usable size');
  }
  if (int('BitsPerComponent') !== 8) return skip('is not 8 bits per component');

  const channels = passThroughChannels(lib, get('ColorSpace'));
  if (!channels) return skip('colour space is not plain grey or RGB');

  const decode = get('Decode');
  if (decode !== undefined) {
    const identity =
      decode instanceof PDFArray &&
      decode.size() === channels * 2 &&
      decode.asArray().every((_, i) => {
        const value = decode.lookup(i);
        return value instanceof PDFNumber && value.asNumber() === i % 2;
      });
    if (!identity) return skip('has a non-identity /Decode');
  }

  return { reencode: true, source, width, height, channels };
}

/**
 * Component count of a colour space whose 8-bit samples can go through a JPEG
 * round trip unchanged in meaning, or undefined for every other space.
 */
function passThroughChannels(lib: PdfLib, space: PDFObject | undefined): 1 | 3 | undefined {
  const { PDFName, PDFArray, PDFDict, PDFStream, PDFNumber } = lib;
  if (space === PDFName.of('DeviceRGB')) return 3;
  if (space === PDFName.of('DeviceGray')) return 1;
  if (space instanceof PDFArray && space.size() === 2) {
    const family = space.lookup(0);
    const params = space.lookup(1);
    if (family === PDFName.of('CalRGB') && params instanceof PDFDict) return 3;
    if (family === PDFName.of('ICCBased') && params instanceof PDFStream) {
      const n = params.dict.lookup(PDFName.of('N'));
      const defaultRange = params.dict.lookup(PDFName.of('Range')) === undefined;
      if (n instanceof PDFNumber && n.asNumber() === 3 && defaultRange) return 3;
    }
  }
  return undefined;
}

/**
 * The dictionary for a re-encoded image: the original with only what the
 * re-encode changed. Starting from the original rather than from nothing keeps
 * everything else that affects how the image is shown — /Interpolate, /Intent,
 * /OC (layer visibility), and the colour space itself, so an ICC-tagged image
 * stays ICC-tagged.
 */
export function replacementImageDict(
  lib: PdfLib,
  context: PDFContext,
  original: PDFDict,
  out: { width: number; height: number; sourceChannels: 1 | 3; length: number },
): PDFDict {
  const { PDFName } = lib;
  const dict = original.clone(context);
  // The identity /Decode is sized for the old component count, and decode
  // parameters belong to the old filter.
  for (const key of ['Decode', 'DecodeParms', 'DP', 'DL']) dict.delete(PDFName.of(key));
  dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
  dict.set(PDFName.of('Width'), context.obj(out.width));
  dict.set(PDFName.of('Height'), context.obj(out.height));
  dict.set(PDFName.of('BitsPerComponent'), context.obj(8));
  dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  dict.set(PDFName.of('Length'), context.obj(out.length));
  // The JPEG we write always has three components. Grey samples become equal
  // R, G and B, which is the same colour in DeviceRGB; three-component sources
  // keep the space they came in.
  if (out.sourceChannels === 1) dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  return dict;
}

/**
 * Size and component count from a JPEG's frame header, or null when it is not a
 * baseline/progressive 8-bit JPEG (lossless, arithmetic-coded and 12-bit files
 * are not something a browser will decode).
 */
export function readJpegFrame(bytes: Uint8Array): { width: number; height: number; components: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no payload
    if (marker === 0xd9 || marker === 0xda) return null; // image data before any frame header
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (i + 9 >= bytes.length || bytes[i + 4] !== 8) return null;
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
      };
    }
    // Any other start-of-frame: lossless, hierarchical or arithmetic coding.
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return null;
    i += 2 + length;
  }
  return null;
}

/** Undo FlateDecode (zlib). */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  // Not awaited: the readable side has to be drained for these to settle. A
  // corrupt stream rejects both; the read below is where that is reported.
  writer.write(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) { chunks.push(value); total += value.length; }
    if (done) break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
