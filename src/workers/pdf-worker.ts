/**
 * PDF Worker — uses pdf-lib for PDF operations.
 *
 * Week 2: merge, split
 * Week 3: reorder
 * Week 4: sign-visual
 * Week 5: encrypt, decrypt, watermark
 * Week 6: add-page-numbers, crop (cropbox), images-to-pdf
 */

import { compressPdf } from '../lib/pdf-compress';
import type {
  WorkerRequest,
  WorkerResponse,
  MergeOptions,
  SplitOptions,
  ReorderOptions,
  EncryptOptions,
  SignVisualOptions,
  WatermarkOptions,
  PageNumberOptions,
  CropOptions,
  ImagesToPdfOptions,
  CompressPdfOptions,
} from '../types/worker-messages';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toUint8Array(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}

function parseColor(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return [r, g, b];
}

function mmToPoints(mm: number): number {
  return mm * 2.8346;
}

function romanize(num: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
  }
  return result.toLowerCase();
}

function alphanumericPage(num: number): string {
  let result = '';
  while (num > 0) {
    num--;
    result = String.fromCharCode(97 + (num % 26)) + result;
    num = Math.floor(num / 26);
  }
  return result;
}

// ─── Operations ──────────────────────────────────────────────────────────────

async function merge(
  buffers: ArrayBuffer[],
  options: MergeOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument } = await import('pdf-lib');

  sendProgress(5, 'Loading documents…');
  const docs = await Promise.all(
    buffers.map((buf) => PDFDocument.load(toUint8Array(buf), { ignoreEncryption: true }))
  );

  sendProgress(20, 'Merging pages…');
  const merged = await PDFDocument.create();
  const total = docs.reduce((s, d) => s + d.getPageCount(), 0);
  let done = 0;

  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    const count = doc.getPageCount();
    // Honor an optional per-file page selection; default to all pages.
    const selection = options.pageSelections?.[di];
    const indices = (selection && selection.length > 0)
      ? selection.filter((i) => i >= 0 && i < count)
      : Array.from({ length: count }, (_, i) => i);
    const copied = await merged.copyPages(doc, indices);
    copied.forEach((page) => merged.addPage(page));

    if (options.insertBlankPages && di < docs.length - 1) {
      merged.addPage();
    }

    done += count;
    sendProgress(20 + Math.round((done / total) * 70), `Merged ${done}/${total} pages…`);
  }

  sendProgress(95, 'Saving…');
  const bytes = await merged.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

async function split(
  buffer: ArrayBuffer,
  options: SplitOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer | ArrayBuffer[]> {
  const { PDFDocument } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const src = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const total = src.getPageCount();

  async function extractPages(indices: number[]): Promise<ArrayBuffer> {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, indices);
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save({ useObjectStreams: false });
    return bytes.buffer as ArrayBuffer;
  }

  if (options.mode === 'extract' && options.pages) {
    sendProgress(50, 'Extracting pages…');
    const result = await extractPages(options.pages);
    return result;
  }

  if (options.mode === 'remove' && options.pages) {
    const keep = Array.from({ length: total }, (_, i) => i).filter(
      (i) => !options.pages!.includes(i)
    );
    sendProgress(50, 'Removing pages…');
    const result = await extractPages(keep);
    return result;
  }

  if (options.mode === 'ranges' && options.ranges) {
    const results: ArrayBuffer[] = [];
    for (let i = 0; i < options.ranges.length; i++) {
      sendProgress(10 + Math.round(((i + 1) / options.ranges.length) * 80), `Splitting range ${i + 1}…`);
      results.push(await extractPages(options.ranges[i]));
    }
    return results;
  }

  if (options.mode === 'every-n' && options.n) {
    const n = options.n;
    const results: ArrayBuffer[] = [];
    let page = 0;
    let chunk = 0;
    while (page < total) {
      const indices = Array.from({ length: Math.min(n, total - page) }, (_, i) => page + i);
      sendProgress(10 + Math.round(((chunk + 1) / Math.ceil(total / n)) * 80), `Splitting chunk ${chunk + 1}…`);
      results.push(await extractPages(indices));
      page += n;
      chunk++;
    }
    return results;
  }

  if (options.mode === 'each') {
    const results: ArrayBuffer[] = [];
    for (let i = 0; i < total; i++) {
      sendProgress(10 + Math.round(((i + 1) / total) * 80), `Extracting page ${i + 1}/${total}…`);
      results.push(await extractPages([i]));
    }
    return results;
  }

  throw new Error(`Unknown split mode: ${options.mode}`);
}

async function reorder(
  buffer: ArrayBuffer,
  options: ReorderOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument, degrees } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const src = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const out = await PDFDocument.create();

  sendProgress(40, 'Reordering pages…');
  const copied = await out.copyPages(src, options.order);

  copied.forEach((page, i) => {
    out.addPage(page);
    const rotation = options.rotations[options.order[i]];
    if (rotation) {
      page.setRotation(degrees(rotation));
    }
  });

  sendProgress(90, 'Saving…');
  const bytes = await out.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

async function signVisual(
  buffer: ArrayBuffer,
  options: SignVisualOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts, degrees, rgb } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const doc = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  const total = options.annotations.length;
  for (let i = 0; i < total; i++) {
    const ann = options.annotations[i];
    const page = doc.getPage(ann.pageIndex);
    const opacity = ann.opacity ?? 1;

    sendProgress(10 + Math.round(((i + 1) / total) * 80), `Applying annotation ${i + 1}/${total}…`);

    if (ann.imageDataUrl && (ann.type === 'signature' || ann.type === 'initials')) {
      // Convert base64 data URL to bytes
      const base64 = ann.imageDataUrl.split(',')[1];
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);

      const isPng = ann.imageDataUrl.startsWith('data:image/png');
      const image = isPng
        ? await doc.embedPng(bytes)
        : await doc.embedJpg(bytes);

      page.drawImage(image, {
        x: ann.x,
        y: ann.y,
        width: ann.width,
        height: ann.height,
        rotate: degrees(ann.rotation ?? 0),
        opacity,
      });
    } else if (ann.type === 'text' || ann.type === 'date' || ann.type === 'checkmark') {
      const text = ann.type === 'checkmark' ? '✓' : (ann.text ?? '');
      const [r, g, b] = parseColor(ann.color ?? '#000000');
      page.drawText(text, {
        x: ann.x,
        y: ann.y,
        size: ann.fontSize ?? 12,
        font: helvetica,
        color: rgb(r, g, b),
        rotate: degrees(ann.rotation ?? 0),
        opacity,
      });
    }
  }

  sendProgress(95, 'Saving…');
  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

/**
 * PDF encryption via qpdf-wasm (AES-256).
 * Replaces the previous custom RC4-128 implementation.
 */
async function encrypt(
  buffer: ArrayBuffer,
  options: EncryptOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  sendProgress(10, 'Preparing PDF…');
  const { qpdfEncrypt } = await import('./qpdf-helper');

  sendProgress(30, 'Encrypting with AES-256…');
  const input = new Uint8Array(buffer);
  const result = await qpdfEncrypt(
    input,
    options.userPassword,
    options.ownerPassword ?? options.userPassword,
    '256',
  );

  sendProgress(100, 'Done');
  return result.buffer as ArrayBuffer;
}

/**
 * PDF decryption via qpdf-wasm.
 */
async function decrypt(
  buffer: ArrayBuffer,
  password: string,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  sendProgress(10, 'Preparing PDF…');
  const { qpdfDecrypt } = await import('./qpdf-helper');

  sendProgress(30, 'Decrypting…');
  const input = new Uint8Array(buffer);
  const result = await qpdfDecrypt(input, password);

  sendProgress(100, 'Done');
  return result.buffer as ArrayBuffer;
}

async function watermark(
  buffer: ArrayBuffer,
  options: WatermarkOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts, degrees, rgb } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const doc = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const pages = doc.getPages();

  const targetPages = pages.filter((_, i) => {
    if (options.applyTo === 'all') return true;
    if (options.applyTo === 'odd') return i % 2 === 0;
    if (options.applyTo === 'even') return i % 2 === 1;
    if (options.applyTo === 'range') return options.pageRange?.includes(i) ?? false;
    return true;
  });

  const opacity = (options.opacity ?? 50) / 100;
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  let embeddedImage: Awaited<ReturnType<typeof doc.embedPng>> | null = null;

  if (options.type === 'image' && options.imageDataUrl) {
    const base64 = options.imageDataUrl.split(',')[1];
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);
    const isPng = options.imageDataUrl.startsWith('data:image/png');
    embeddedImage = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  }

  const total = targetPages.length;
  for (let i = 0; i < total; i++) {
    sendProgress(10 + Math.round(((i + 1) / total) * 80), `Watermarking page ${i + 1}/${total}…`);
    const page = targetPages[i];
    const { width, height } = page.getSize();
    const rot = options.rotation ?? -45;
    const [r, g, b] = parseColor(options.color ?? '#000000');

    if (options.type === 'text' && options.text) {
      const fontSize = options.fontSize ?? 60;
      const textWidth = font.widthOfTextAtSize(options.text, fontSize);
      const textHeight = font.heightAtSize(fontSize);

      if (options.placement === 'center') {
        page.drawText(options.text, {
          x: width / 2 - textWidth / 2,
          y: height / 2 - textHeight / 2,
          size: fontSize,
          font,
          color: rgb(r, g, b),
          opacity,
          rotate: degrees(rot),
        });
      } else {
        // Tiled
        const spacing = options.tileSpacing ?? 200;
        for (let tx = 0; tx < width + spacing; tx += spacing) {
          for (let ty = 0; ty < height + spacing; ty += spacing) {
            page.drawText(options.text, {
              x: tx - textWidth / 2,
              y: ty,
              size: fontSize,
              font,
              color: rgb(r, g, b),
              opacity,
              rotate: degrees(rot),
            });
          }
        }
      }
    } else if (options.type === 'image' && embeddedImage) {
      const imgW = options.placement === 'tiled' ? 150 : Math.min(width * 0.5, 300);
      const scale = imgW / embeddedImage.width;
      const imgH = embeddedImage.height * scale;

      if (options.placement === 'center') {
        page.drawImage(embeddedImage, {
          x: width / 2 - imgW / 2,
          y: height / 2 - imgH / 2,
          width: imgW,
          height: imgH,
          opacity,
          rotate: degrees(rot),
        });
      } else {
        const spacing = (options.tileSpacing ?? 200) + imgW;
        for (let tx = 0; tx < width + spacing; tx += spacing) {
          for (let ty = 0; ty < height + spacing; ty += spacing) {
            page.drawImage(embeddedImage, { x: tx, y: ty, width: imgW, height: imgH, opacity });
          }
        }
      }
    }
  }

  sendProgress(95, 'Saving…');
  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

async function addPageNumbers(
  buffer: ArrayBuffer,
  options: PageNumberOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const doc = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const pages = doc.getPages();
  const total = pages.length;

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [r, g, b] = parseColor(options.color ?? '#000000');
  const marginX = mmToPoints(options.marginX ?? 20);
  const marginY = mmToPoints(options.marginY ?? 15);
  const fontSize = options.fontSize ?? 10;

  for (let i = options.skipFirstN ?? 0; i < total; i++) {
    sendProgress(10 + Math.round(((i + 1) / total) * 80), `Numbering page ${i + 1}/${total}…`);
    const page = pages[i];
    const { width, height } = page.getSize();
    const pageNum = i - (options.skipFirstN ?? 0) + (options.startNumber ?? 1);

    let label: string;
    switch (options.format) {
      case 'n': label = String(pageNum); break;
      case 'page-n': label = `Page ${pageNum}`; break;
      case 'page-n-of-total': label = `Page ${pageNum} of ${total - (options.skipFirstN ?? 0)}`; break;
      case 'n-of-total': label = `${pageNum}/${total - (options.skipFirstN ?? 0)}`; break;
      case 'roman': label = romanize(pageNum); break;
      case 'alpha': label = alphanumericPage(pageNum); break;
      default: label = String(pageNum);
    }

    const textWidth = font.widthOfTextAtSize(label, fontSize);

    let x: number;
    let y: number;

    switch (options.position) {
      case 'bottom-center': x = width / 2 - textWidth / 2; y = marginY; break;
      case 'bottom-left': x = marginX; y = marginY; break;
      case 'bottom-right': x = width - marginX - textWidth; y = marginY; break;
      case 'top-center': x = width / 2 - textWidth / 2; y = height - marginY - fontSize; break;
      case 'top-left': x = marginX; y = height - marginY - fontSize; break;
      case 'top-right': x = width - marginX - textWidth; y = height - marginY - fontSize; break;
      default: x = width / 2 - textWidth / 2; y = marginY;
    }

    page.drawText(label, { x, y, size: fontSize, font, color: rgb(r, g, b) });
  }

  sendProgress(95, 'Saving…');
  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

async function crop(
  buffer: ArrayBuffer,
  options: CropOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const doc = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const pages = doc.getPages();

  const targetIndices =
    options.applyTo === 'all'
      ? pages.map((_, i) => i)
      : options.applyTo === 'current' && options.pageIndex !== undefined
        ? [options.pageIndex]
        : options.pageRange ?? [];

  const { top, right, bottom, left } = options.margins;

  for (let i = 0; i < targetIndices.length; i++) {
    sendProgress(10 + Math.round(((i + 1) / targetIndices.length) * 80));
    const page = pages[targetIndices[i]];
    const { width, height } = page.getSize();
    page.setCropBox(left, bottom, width - left - right, height - bottom - top);
  }

  sendProgress(95, 'Saving…');
  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

async function imagesToPdf(
  buffers: ArrayBuffer[],
  mimeTypes: string[],
  options: ImagesToPdfOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument, rgb } = await import('pdf-lib');

  sendProgress(5, 'Creating PDF…');
  const doc = await PDFDocument.create();

  // Standard page sizes in points [width, height]
  const PAGE_SIZES: Record<string, [number, number]> = {
    a4: [595.28, 841.89],
    letter: [612, 792],
    legal: [612, 1008],
  };

  const total = buffers.length;

  for (let i = 0; i < total; i++) {
    sendProgress(5 + Math.round(((i + 1) / total) * 85), `Adding image ${i + 1}/${total}…`);

    const bytes = toUint8Array(buffers[i]);
    const mime = mimeTypes[i];

    let image: Awaited<ReturnType<typeof doc.embedPng>>;
    if (mime === 'image/png') {
      image = await doc.embedPng(bytes);
    } else {
      image = await doc.embedJpg(bytes);
    }

    const imgW = image.width;
    const imgH = image.height;

    let pageW: number;
    let pageH: number;

    if (options.pageSize === 'fit') {
      pageW = imgW;
      pageH = imgH;
    } else if (options.pageSize === 'custom' && options.customWidth && options.customHeight) {
      pageW = options.customWidth;
      pageH = options.customHeight;
    } else {
      [pageW, pageH] = PAGE_SIZES[options.pageSize] ?? PAGE_SIZES.a4;
    }

    const page = doc.addPage([pageW, pageH]);

    const { top, right, bottom, left } = options.margins;
    const availW = pageW - left - right;
    const availH = pageH - top - bottom;

    let drawX = left;
    let drawY = bottom;
    let drawW = availW;
    let drawH = availH;

    if (options.placement === 'center') {
      const scale = Math.min(availW / imgW, availH / imgH);
      drawW = imgW * scale;
      drawH = imgH * scale;
      drawX = left + (availW - drawW) / 2;
      drawY = bottom + (availH - drawH) / 2;
    } else if (options.placement === 'fit') {
      const scale = Math.min(availW / imgW, availH / imgH);
      drawW = imgW * scale;
      drawH = imgH * scale;
      drawX = left + (availW - drawW) / 2;
      drawY = bottom + (availH - drawH) / 2;
    } else if (options.placement === 'cover') {
      const scale = Math.max(availW / imgW, availH / imgH);
      drawW = imgW * scale;
      drawH = imgH * scale;
      drawX = left + (availW - drawW) / 2;
      drawY = bottom + (availH - drawH) / 2;
    }
    // 'stretch' uses full availW/availH as-is

    if (options.backgroundColor) {
      const [r, g, b] = parseColor(options.backgroundColor);
      page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(r, g, b) });
    }

    page.drawImage(image, { x: drawX, y: drawY, width: drawW, height: drawH });
  }

  sendProgress(95, 'Saving…');
  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}


// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const progressPort = (msg as WorkerRequest & { progressPort: MessagePort }).progressPort;

  function sendProgress(percent: number, label?: string) {
    progressPort?.postMessage({ percent, label });
  }

  const start = Date.now();

  try {
    sendProgress(0, 'Starting…');

    let response: WorkerResponse;

    switch (msg.op) {
      case 'merge': {
        const result = await merge(msg.buffers, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'split': {
        const result = await split(msg.buffer, msg.options, sendProgress);
        if (Array.isArray(result)) {
          response = { status: 'success-multi', results: result, stats: { durationMs: Date.now() - start } };
        } else {
          response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        }
        break;
      }

      case 'reorder': {
        const result = await reorder(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'sign-visual': {
        const result = await signVisual(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'compress-pdf': {
        const { buffer: result, imagesTotal, imagesRecompressed } = await compressPdf(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { originalSize: msg.buffer.byteLength, outputSize: result.byteLength, durationMs: Date.now() - start, imagesTotal, imagesRecompressed } };
        break;
      }

      case 'encrypt': {
        const result = await encrypt(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'decrypt': {
        const result = await decrypt(msg.buffer, msg.password, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'watermark': {
        const result = await watermark(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'add-page-numbers': {
        const result = await addPageNumbers(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'crop': {
        const result = await crop(msg.buffer, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      case 'images-to-pdf': {
        const result = await imagesToPdf(msg.buffers, msg.mimeTypes, msg.options, sendProgress);
        response = { status: 'success', result, stats: { outputSize: result.byteLength, durationMs: Date.now() - start } };
        break;
      }

      default:
        response = {
          status: 'error',
          message: `Operation "${(msg as { op: string }).op}" not implemented in pdf-worker`,
        };
    }

    sendProgress(100, 'Done');
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  } finally {
    progressPort?.close();
  }
};
