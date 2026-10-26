/**
 * PDF compression as a plain function over an ArrayBuffer.
 *
 * Lives outside the worker (like `image-ops.ts`) because the image-recompression
 * step needs a 2D drawing surface: it runs inside `pdf-worker.ts` normally, and
 * inline on the main thread on browsers with no `OffscreenCanvas`, where a
 * worker cannot draw at all. One implementation, two realms.
 */
import { createCanvas2D } from './canvas-2d';
import { deduplicateImages } from './pdf-dedupe';
import { imageEffectiveDpi, type PlacedDpi } from './pdf-image-placement';
import { encodeImageData } from './image-codec';
import { imagePages, pageImageRefs } from './pdf-page-images';
import type {
  CompressApplied,
  CompressImageOutcome,
  CompressPdfOptions,
  ImageKeptReason,
} from '../types/worker-messages';
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
  /** Duplicate image objects merged into an identical one (lossless, every level). */
  imagesMerged: number;
  /** The settings the pass that produced `buffer` used. */
  applied: CompressApplied;
  /** With `options.report`: what happened to each image a page draws. */
  images?: CompressImageOutcome[];
  /** The output was not smaller, so these are the original bytes. */
  returnedOriginal?: boolean;
}

export async function compressPdf(
  buffer: ArrayBuffer,
  options: CompressPdfOptions,
  sendProgress: ProgressFn
): Promise<CompressResult> {
  const result = options.targetBytes && options.targetBytes > 0
    ? await compressPdfToTarget(buffer, options.targetBytes, sendProgress, !!options.report)
    : await compressPdfOnce(buffer, options, sendProgress);
  // Re-saving a small, already-tight PDF can add a few bytes. Hand back the
  // original rather than a "compressed" file that is no smaller than the input.
  if (options.preview || result.buffer.byteLength < buffer.byteLength) return result;
  return {
    ...result,
    buffer: buffer.slice(0),
    imagesRecompressed: 0,
    imagesMerged: 0,
    returnedOriginal: true,
    // Every image is as it was in the original, whatever the pass did to it.
    images: result.images?.map((image) => ({
      ...image,
      action: 'kept' as const,
      reason: image.action === 'recompressed' ? ('not-smaller' as const) : image.reason,
      outWidth: image.width,
      outHeight: image.height,
      bytesAfter: image.bytesBefore,
      copiesMerged: undefined,
    })),
  };
}

/**
 * Settings tried in target-size mode, gentlest first. Index 0 is the lossless
 * structural pass; each later step trades more image quality for size.
 */
export const TARGET_LADDER: CompressPdfOptions[] = [
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
  report: boolean,
): Promise<CompressResult> {
  const last = TARGET_LADDER.length - 1;
  // 2 fixed passes + ceil(log2(last - 1)) bisection passes.
  const maxPasses = 2 + Math.ceil(Math.log2(Math.max(2, last - 1)));
  let pass = 0;
  const attempt = async (step: number): Promise<CompressResult> => {
    const base = (pass / maxPasses) * 100;
    pass++;
    const result = await compressPdfOnce(buffer, { ...TARGET_LADDER[step], report }, (pct, label) =>
      sendProgress(Math.min(99, Math.round(base + pct / maxPasses)), `Pass ${pass}: ${label ?? 'compressing…'}`));
    // Which step this is travels with the result, so the caller can say what it took.
    return { ...result, applied: { ...result.applied, ladderStep: step, ladderSteps: TARGET_LADDER.length, targetBytes } };
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

  // The settings, worked out once: the pass and the report read the same values.
  const jpegQuality = (options.jpegQuality ?? 75) / 100;
  const lossless = options.level === 'low';
  // Resolution: either one factor for every image (target-size mode), or a
  // target DPI — an image drawn sharper than that on the page is reduced to it,
  // judged by its largest placement and along width and height separately
  // (see pdf-image-placement.ts).
  const targetDpi = options.imageScale === undefined && options.dpi && options.dpi > 0 ? options.dpi : undefined;
  const fixedScale = Math.min(1, options.imageScale ?? 1);
  const applied: CompressApplied = {
    lossless,
    jpegQuality: options.jpegQuality ?? 75,
    imageScale: lossless || targetDpi ? 1 : fixedScale,
    grayscale: !lossless && !!options.grayscale,
    ...(!lossless && targetDpi ? { targetDpi } : {}),
  };
  let imagesTotal = 0;
  let imagesRecompressed = 0;

  // Lossless and first, so a repeated image is also re-encoded only once.
  sendProgress(7, 'Merging repeated images…');
  let copies = new Map<PDFRef, number>();
  let imagesMerged = 0;
  try {
    const merged = await deduplicateImages(pdfLib, doc.context);
    copies = merged.copies;
    imagesMerged = merged.imagesMerged;
  } catch {
    /* leave the document as it was loaded */
  }

  // How sharp each image is where it is drawn; images without a reliable
  // figure are absent and keep their resolution.
  let placedDpi = new Map<PDFRef, PlacedDpi>();
  if (!lossless && targetDpi) {
    try {
      placedDpi = imageEffectiveDpi(pdfLib, doc);
    } catch {
      /* no figures: nothing is reduced for resolution */
    }
  }
  const scaleFor = (ref: PDFRef): { x: number; y: number } => {
    if (!targetDpi) return { x: fixedScale, y: fixedScale };
    const dpi = placedDpi.get(ref);
    if (!dpi) return { x: 1, y: 1 };
    return { x: dpi.x > targetDpi ? targetDpi / dpi.x : 1, y: dpi.y > targetDpi ? targetDpi / dpi.y : 1 };
  };

  // Per-image outcomes, for the images some page draws, in page order.
  const outcomes = new Map<PDFRef, CompressImageOutcome>();
  if (options.report) {
    for (const [ref, pages] of imagePages(pageImageRefs(pdfLib, doc))) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const size = (key: string) => {
        const value = stream.dict.lookup(PDFName.of(key));
        return value instanceof pdfLib.PDFNumber ? value.asNumber() : 0;
      };
      const width = size('Width');
      const height = size('Height');
      const bytes = stream.contents.byteLength;
      outcomes.set(ref, {
        pages, width, height, outWidth: width, outHeight: height, bytesBefore: bytes, bytesAfter: bytes, action: 'kept',
        ...(copies.has(ref) ? { copiesMerged: copies.get(ref) } : {}),
        ...(placedDpi.has(ref) ? { placedDpi: Math.round(Math.max(placedDpi.get(ref)!.x, placedDpi.get(ref)!.y)) } : {}),
      });
    }
  }

  sendProgress(10, 'Stripping metadata…');
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');

  // Re-encode embedded images as JPEG — only those on the allow-list in
  // `planImagePass`; every other image is left exactly as it is.
  if (options.level !== 'low') {
    sendProgress(15, 'Compressing images…');
    const context = doc.context;
    const planned = planImagePass(pdfLib, context);

    imagesTotal = planned.length;
    for (let i = 0; i < planned.length; i++) {
      const { ref, stream, plan } = planned[i];
      sendProgress(
        15 + Math.round(((i + 1) / planned.length) * 60),
        `Compressing image ${i + 1}/${planned.length}…`
      );
      const outcome = outcomes.get(ref);
      const keep = (reason: ImageKeptReason) => {
        if (outcome) outcome.reason = reason;
      };
      if (!plan.reencode) { keep(keptReason(plan.reason)); continue; }

      // A soft-masked image keeps its size: its mask must still fit it pixel for pixel.
      const scale = plan.reencode && plan.alpha ? { x: 1, y: 1 } : scaleFor(ref);
      let bmp: ImageBitmap | undefined;
      try {
        const { width, height, channels } = plan;
        const rawBytes = stream.contents;
        if (rawBytes.byteLength < 1024) { keep('small'); continue; }

        if (plan.source === 'jpeg') {
          // Re-encoding a JPEG at high quality and the same size only costs a
          // generation of quality; it is worth doing when it is also downsampled.
          if (jpegQuality >= 0.9 && scale.x >= 1 && scale.y >= 1) { keep('quality-90-plus'); continue; }
          // The stream has to be the image its dictionary describes: a baseline
          // or progressive 8-bit JPEG of that size with that many components.
          // A CMYK JPEG labelled RGB, say, is not something to guess at.
          const frame = readJpegFrame(rawBytes);
          if (!frame || frame.width !== width || frame.height !== height || frame.components !== channels) {
            keep('unsupported');
            continue;
          }
          const blob = new Blob([rawBytes as BlobPart], { type: 'image/jpeg' });
          // 'none': the PDF's colour space says what the samples mean, so a
          // profile embedded in the JPEG itself must not be applied on top.
          bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
        } else {
          const pixelData = await inflate(rawBytes);
          // Exactly one byte per sample, or this is not the layout we think it is.
          if (pixelData.length !== width * height * channels) { keep('unsupported'); continue; }
          // The mask itself is not touched; it only has to be readable as the
          // one-alpha-per-pixel plane the plan took it for.
          if (plan.alpha && (await inflate(plan.alpha.contents)).length !== width * height) { keep('masked'); continue; }

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
        if (scale.x < 1) targetW = Math.max(1, Math.round(width * scale.x));
        if (scale.y < 1) targetH = Math.max(1, Math.round(height * scale.y));

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
        if (outBuf.byteLength >= rawBytes.byteLength) { keep('not-smaller'); continue; }

        const newDict = replacementImageDict(pdfLib, context, stream.dict, {
          width: targetW,
          height: targetH,
          sourceChannels: channels,
          length: outBuf.byteLength,
        });
        context.assign(ref, PDFRawStream.of(newDict, outBuf));
        imagesRecompressed++;
        if (outcome) {
          Object.assign(outcome, { action: 'recompressed', outWidth: targetW, outHeight: targetH, bytesAfter: outBuf.byteLength });
        }
      } catch {
        keep('failed');
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
  const images = options.report ? [...outcomes.values()] : undefined;
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
        imagesMerged,
        applied,
        images,
      };
    }
  } catch {
    /* keep pdf-lib output */
  }

  return { buffer: savedBytes.buffer as ArrayBuffer, imagesTotal, imagesRecompressed, imagesMerged, applied, images };
}

/** The reason code for a plan that says "leave it", for the report. */
export function keptReason(planReason: string): ImageKeptReason {
  return /mask/.test(planReason) ? 'masked' : 'unsupported';
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
 *  - it has no /Mask (stencil or colour key: a JPEG would no longer match it);
 *  - it has no /SMask — except a FlateDecode image whose /SMask is itself a
 *    plain mask: 8-bit /DeviceGray FlateDecode, the same width and height, no
 *    /Decode, /DecodeParms or /Matte. That image is re-encoded at its own size
 *    (so the mask still fits it pixel for pixel) and keeps the very same
 *    /SMask. The colour under hidden pixels is kept too: renderers blend it
 *    into edge pixels when they scale an image, so replacing it changes how
 *    edges look, and on MuPDF renders a JPEG of the original samples stays
 *    closest to the original page. A JPEG under a soft mask is left alone;
 *  - /Filter is exactly /DCTDecode or /FlateDecode, with no /DecodeParms
 *    (so no PNG/TIFF predictor, and nothing chained);
 *  - /BitsPerComponent is 8;
 *  - /ColorSpace is /DeviceGray, /DeviceRGB, [/CalRGB …] or a three-component
 *    [/ICCBased …] with the default range;
 *  - /Decode is absent or the identity mapping.
 */
export type ImagePlan =
  | { reencode: false; reason: string }
  | {
      reencode: true;
      source: 'jpeg' | 'flate';
      width: number;
      height: number;
      channels: 1 | 3;
      /** The image's soft mask, kept as it is; present only for a soft-masked image. */
      alpha?: PDFRawStream;
    };

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
  const softMask = dict.lookup(lib.PDFName.of('SMask'));
  if (softMask === undefined) return planPlainImage(lib, dict);
  // One reason for every soft-masked image left alone, whatever else it is.
  const masked: ImagePlan = { reencode: false, reason: 'has a soft mask' };
  if (dict.lookup(lib.PDFName.of('Mask')) !== undefined) return masked;
  const plan = planPlainImage(lib, dict, true);
  if (!plan.reencode || plan.source !== 'flate') return masked;
  const alpha = plainSoftMask(lib, softMask, plan.width, plan.height);
  return alpha ? { ...plan, alpha } : masked;
}

/**
 * The soft mask as a stream whose inflated bytes are exactly one alpha value
 * per pixel of an image of this size, or undefined when it is anything else.
 */
function plainSoftMask(lib: PdfLib, mask: PDFObject, width: number, height: number): PDFRawStream | undefined {
  const { PDFName, PDFNumber, PDFRawStream } = lib;
  if (!(mask instanceof PDFRawStream)) return undefined;
  const get = (key: string) => mask.dict.lookup(PDFName.of(key));
  const int = (key: string) => {
    const value = get(key);
    return value instanceof PDFNumber ? value.asNumber() : undefined;
  };
  if (get('Subtype') !== PDFName.of('Image')) return undefined;
  if (get('Filter') !== PDFName.of('FlateDecode')) return undefined;
  for (const key of ['DecodeParms', 'DP', 'Decode', 'Matte', 'ImageMask', 'SMask', 'Mask']) {
    if (get(key) !== undefined) return undefined;
  }
  if (get('ColorSpace') !== PDFName.of('DeviceGray')) return undefined;
  if (int('BitsPerComponent') !== 8 || int('Width') !== width || int('Height') !== height) return undefined;
  return mask;
}

/** The decision for an image apart from any soft mask (`softMaskChecked`: the caller handles it). */
function planPlainImage(lib: PdfLib, dict: PDFDict, softMaskChecked = false): ImagePlan {
  const { PDFName, PDFNumber, PDFBool, PDFArray } = lib;
  const get = (key: string) => dict.lookup(PDFName.of(key));
  const skip = (reason: string): ImagePlan => ({ reencode: false, reason });
  const int = (key: string) => {
    const value = get(key);
    return value instanceof PDFNumber && Number.isInteger(value.asNumber()) ? value.asNumber() : undefined;
  };

  if (get('ImageMask') === PDFBool.True) return skip('is a stencil mask');
  if (!softMaskChecked && get('SMask') !== undefined) return skip('has a soft mask');
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
