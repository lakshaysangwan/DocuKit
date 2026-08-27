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
  const { PDFDocument, PDFName, PDFRawStream, PDFDict } = await import('pdf-lib');

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

  // Re-encode embedded JPEG images at lower quality onto a 2D canvas.
  if (options.level !== 'low') {
    sendProgress(15, 'Compressing images…');
    const context = doc.context;

    // Collect image refs: we use untyped access since pdf-lib internals aren't fully typed
    const allObjects = context.enumerateIndirectObjects();
    type PdfObj = { dict?: { get(k: unknown): unknown }; contents?: Uint8Array };
    const imageEntries: Array<{ ref: unknown; obj: PdfObj }> = [];

    for (const [ref, rawObj] of allObjects) {
      const obj = rawObj as PdfObj;
      if (!obj.dict || typeof obj.dict.get !== 'function') continue;
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      if (subtype && subtype.toString() === '/Image') {
        imageEntries.push({ ref, obj });
      }
    }

    imagesTotal = imageEntries.length;
    for (let i = 0; i < imageEntries.length; i++) {
      const { ref, obj } = imageEntries[i];
      sendProgress(
        15 + Math.round(((i + 1) / imageEntries.length) * 60),
        `Compressing image ${i + 1}/${imageEntries.length}…`
      );

      try {
        const dict = obj.dict!;
        const filter = dict.get(PDFName.of('Filter'));
        if (!filter) continue;
        const filterName = filter.toString();

        const rawBytes = obj.contents;
        if (!rawBytes || rawBytes.byteLength < 1024) continue;

        const widthObj = dict.get(PDFName.of('Width'));
        const heightObj = dict.get(PDFName.of('Height'));
        if (!widthObj || !heightObj) continue;

        const width = Number(widthObj.toString());
        const height = Number(heightObj.toString());
        if (width <= 0 || height <= 0 || width > 10000 || height > 10000) continue;

        // Handle both DCTDecode (JPEG) and FlateDecode (raw pixel) images
        let bmp: ImageBitmap | null = null;

        if (filterName === '/DCTDecode') {
          if (jpegQuality >= 0.9) continue;
          const blob = new Blob([rawBytes as BlobPart], { type: 'image/jpeg' });
          bmp = await createImageBitmap(blob);
        } else if (filterName === '/FlateDecode') {
          // Decompress with DecompressionStream, then reconstruct raw pixels
          try {
            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(new Uint8Array(rawBytes) as Uint8Array<ArrayBuffer>);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            let done = false;
            while (!done) {
              const r = await reader.read();
              done = r.done;
              if (r.value) chunks.push(r.value);
            }
            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
            const pixelData = new Uint8Array(totalLen);
            let offset = 0;
            for (const c of chunks) { pixelData.set(c, offset); offset += c.length; }

            const bpc = dict.get(PDFName.of('BitsPerComponent'));
            const bitsPerComp = bpc ? Number(bpc.toString()) : 8;
            if (bitsPerComp !== 8) continue;

            const colorSpace = dict.get(PDFName.of('ColorSpace'));
            const csName = colorSpace ? colorSpace.toString() : '/DeviceRGB';
            const channels = csName.includes('Gray') ? 1 : csName.includes('CMYK') ? 4 : 3;

            if (pixelData.length < width * height * channels) continue;

            const { canvas, ctx } = createCanvas2D(width, height);

            const imageData = ctx.createImageData(width, height);
            const data = imageData.data;
            for (let px = 0; px < width * height; px++) {
              if (channels === 3) {
                data[px * 4] = pixelData[px * 3];
                data[px * 4 + 1] = pixelData[px * 3 + 1];
                data[px * 4 + 2] = pixelData[px * 3 + 2];
              } else if (channels === 1) {
                data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = pixelData[px];
              } else if (channels === 4) {
                const c = pixelData[px * 4] / 255, m = pixelData[px * 4 + 1] / 255;
                const y = pixelData[px * 4 + 2] / 255, k = pixelData[px * 4 + 3] / 255;
                data[px * 4] = 255 * (1 - c) * (1 - k);
                data[px * 4 + 1] = 255 * (1 - m) * (1 - k);
                data[px * 4 + 2] = 255 * (1 - y) * (1 - k);
              }
              data[px * 4 + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
            bmp = await createImageBitmap(canvas);
          } catch { continue; }
        } else {
          continue; // Skip JBIG2, JPXDecode, etc.
        }

        if (!bmp) continue;

        // Optionally downscale based on target DPI
        let targetW = width;
        let targetH = height;
        if (options.dpi && options.dpi < 150) {
          const scale = options.dpi / 150;
          targetW = Math.max(1, Math.round(width * scale));
          targetH = Math.max(1, Math.round(height * scale));
        }

        const { canvas, ctx } = createCanvas2D(targetW, targetH);

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

        const newDict = PDFDict.withContext(context);
        newDict.set(PDFName.of('Type'), PDFName.of('XObject'));
        newDict.set(PDFName.of('Subtype'), PDFName.of('Image'));
        newDict.set(PDFName.of('Width'), context.obj(targetW));
        newDict.set(PDFName.of('Height'), context.obj(targetH));
        newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
        newDict.set(PDFName.of('BitsPerComponent'), context.obj(8));
        newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        newDict.set(PDFName.of('Length'), context.obj(outBuf.byteLength));
        const replacementStream = PDFRawStream.of(newDict, outBuf);
        context.assign(ref as any, replacementStream);
        imagesRecompressed++;
      } catch {
        continue;
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
