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
import { layoutImagePage } from '../lib/images-to-pdf-layout';
import { countUnclosedGraphicsStates } from '../lib/pdf/content-balance';
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

/** Separates content streams when they are read as one. */
const NEWLINE = new Uint8Array([10]);

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

function isEncryptionError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /encrypt/i.test(text);
}

/**
 * Load a PDF that may be encrypted.
 *
 * pdf-lib cannot decrypt content streams, so loading an encrypted file with
 * `ignoreEncryption: true` produces a document whose pages are garbage — it
 * fails silently, which is what the merge path used to do. Encrypted input goes
 * to qpdf instead. When no password was supplied we still try an empty one,
 * which clears owner-password-only files (the common "permissions" case)
 * without asking the user for anything.
 */
async function loadPossiblyEncrypted(
  bytes: Uint8Array,
  password: string | null,
  name: string
) {
  const { PDFDocument } = await import('pdf-lib');

  try {
    // `plain` carries the bytes forward untouched when nothing needed decrypting,
    // so callers that want the original file (not a pdf-lib re-serialisation of
    // it) can have it.
    return { doc: await PDFDocument.load(bytes), plain: bytes };
  } catch (err) {
    if (!isEncryptionError(err)) throw err;
  }

  const { qpdfDecrypt } = await import('./qpdf-helper');
  try {
    const decrypted = await qpdfDecrypt(bytes, password ?? '');
    return { doc: await PDFDocument.load(decrypted), plain: decrypted };
  } catch {
    throw new Error(
      password
        ? `Incorrect password for "${name}".`
        : `"${name}" is password-protected — enter its password to include it.`
    );
  }
}

/** One run of output pages from one input file; `pages` null = all of them. */
interface MergePart {
  file: number;
  pages: number[] | null;
}

/**
 * The merged PDF's pages as runs, in output order: from `segments` when the
 * visitor arranged pages, otherwise one run per file from the per-file
 * selections (or whole files), as a plain merge has always been.
 */
function mergeParts(fileCount: number, options: MergeOptions): MergePart[] {
  if (options.segments && options.segments.length > 0) {
    return options.segments
      .filter((s) => s.file >= 0 && s.file < fileCount)
      .map((s) => ({ file: s.file, pages: s.pages }));
  }
  return Array.from({ length: fileCount }, (_, file) => {
    const selection = options.pageSelections?.[file];
    return { file, pages: selection && selection.length > 0 ? selection : null };
  });
}

/** A run's source pages, clamped to the document. */
function partIndices(part: MergePart, count: number): number[] {
  return part.pages ? part.pages.filter((i) => i >= 0 && i < count) : Array.from({ length: count }, (_, i) => i);
}

async function merge(
  buffers: ArrayBuffer[],
  options: MergeOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument } = await import('pdf-lib');
  const parts = mergeParts(buffers.length, options);
  const used = new Set(parts.map((p) => p.file));

  // Decrypt up front either way — MuPDF would refuse the encrypted bytes too.
  // A file none of whose pages is used is not opened (nor asked for its password).
  const loaded = await Promise.all(
    buffers.map(async (buf, i) => {
      if (!used.has(i)) return null;
      const name = options.fileNames?.[i] ?? `File ${i + 1}`;
      const password = options.passwords?.[i] ?? null;
      const { doc, plain } = await loadPossiblyEncrypted(toUint8Array(buf), password, name);
      return { doc, plain, name };
    })
  );

  if (options.preserveBookmarks) {
    const { mergeWithOutlines } = await import('./mupdf-merge');
    // Hand MuPDF the original bytes. Round-tripping them through pdf-lib first
    // would rewrite the very structures this path exists to preserve, and pdf-lib
    // has no concept of an outline to rewrite them faithfully. Runs of the same
    // file share its `sourceKey`, so it is opened once and its outline and links
    // are remapped once, against every page it contributes.
    const inputs = parts.map((part) => {
      const { plain, name } = loaded[part.file]!;
      return { bytes: plain, pages: part.pages, name, sourceKey: part.file };
    });
    const merged = await mergeWithOutlines(inputs, options.insertBlankPages ?? false, sendProgress);
    return merged.buffer as ArrayBuffer;
  }

  sendProgress(5, 'Loading documents…');

  sendProgress(20, 'Merging pages…');
  const merged = await PDFDocument.create();

  // Copy each file's pages in ONE call, however many runs it is split into, so
  // its fonts and images are copied once rather than once per run.
  const copied = new Map<number, Map<number, Awaited<ReturnType<typeof merged.copyPages>>[number]>>();
  for (const file of used) {
    const doc = loaded[file]!.doc;
    const count = doc.getPageCount();
    const wanted = [...new Set(parts.filter((p) => p.file === file).flatMap((p) => partIndices(p, count)))];
    const pages = await merged.copyPages(doc, wanted);
    copied.set(file, new Map(wanted.map((src, i) => [src, pages[i]])));
  }

  const total = parts.reduce((s, p) => s + partIndices(p, loaded[p.file]!.doc.getPageCount()).length, 0);
  let done = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const pages = copied.get(part.file)!;
    for (const src of partIndices(part, loaded[part.file]!.doc.getPageCount())) {
      merged.addPage(pages.get(src)!);
      done++;
    }
    // A blank goes where one document ends and the next begins — never between
    // two runs of the same file, and never after the last page.
    const next = parts[pi + 1];
    if (options.insertBlankPages && next && next.file !== part.file) merged.addPage();
    sendProgress(20 + Math.round((done / Math.max(total, 1)) * 70), `Merged ${done}/${total} pages…`);
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

  // Copy each distinct source page once. pdf-lib's copier is per-call and caches
  // by object, so asking for the same index twice in one call would yield one
  // shared page — rotating either copy would rotate both. Repeat occurrences
  // therefore get their own copyPages call, which keeps them independent while
  // leaving the common (no-duplicates) case at a single copy pass.
  const distinct = [...new Set(options.order.filter((i) => i >= 0))];
  const copiedDistinct = await out.copyPages(src, distinct);
  const firstCopy = new Map<number, (typeof copiedDistinct)[number]>();
  distinct.forEach((srcIdx, i) => firstCopy.set(srcIdx, copiedDistinct[i]));

  // Blank pages adopt the size of the nearest preceding real page so they don't
  // arrive as Letter in the middle of an A4 document.
  const srcPageCount = src.getPageCount();
  let blankSize: [number, number] = srcPageCount > 0
    ? (() => { const { width, height } = src.getPage(0).getSize(); return [width, height]; })()
    : [612, 792];

  const used = new Set<number>();
  for (let pos = 0; pos < options.order.length; pos++) {
    const srcIdx = options.order[pos];
    let page;

    if (srcIdx < 0) {
      page = out.addPage(blankSize);
    } else {
      if (used.has(srcIdx)) {
        [page] = await out.copyPages(src, [srcIdx]);
      } else {
        page = firstCopy.get(srcIdx)!;
        used.add(srcIdx);
      }
      out.addPage(page);
      const { width, height } = page.getSize();
      blankSize = [width, height];
    }

    const rotation = options.rotations[pos];
    if (rotation) {
      page.setRotation(degrees(rotation));
    }
  }

  sendProgress(90, 'Saving…');
  const bytes = await out.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

async function signVisual(
  buffer: ArrayBuffer,
  options: SignVisualOptions,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream, degrees, popGraphicsState, rgb } =
    await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const doc = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  /**
   * Graphics states the page's own content opens and never closes. pdf-lib
   * isolates existing content in one q…Q, which is enough for a well-formed
   * page; a page that leaves two or more open would have our stamps drawn in
   * whatever coordinate system it left behind (see lib/pdf/content-balance.ts).
   */
  const unclosedStates = (page: ReturnType<typeof doc.getPage>): number => {
    try {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray
        ? contents.asArray().map((entry) => doc.context.lookup(entry))
        : [contents];
      const parts: Uint8Array[] = [];
      let length = 0;
      for (const stream of streams) {
        if (!(stream instanceof PDFRawStream)) continue;
        const decoded = decodePDFRawStream(stream).decode();
        parts.push(decoded, NEWLINE);
        length += decoded.length + 1;
      }
      const content = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        content.set(part, offset);
        offset += part.length;
      }
      return countUnclosedGraphicsStates(content);
    } catch {
      // A stream that cannot be decoded cannot be counted; leave the page as it is.
      return 0;
    }
  };
  const repaired = new Set<number>();

  // One embedded image per distinct picture: a signature copied to every page
  // of a 200-page file is stored once and drawn 200 times, not stored 200 times.
  const embedded = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();

  const total = options.annotations.length;
  for (let i = 0; i < total; i++) {
    const ann = options.annotations[i];
    const page = doc.getPage(ann.pageIndex);
    const opacity = ann.opacity ?? 1;

    // Once per page, before the first stamp: close what the page left open.
    if (!repaired.has(ann.pageIndex)) {
      repaired.add(ann.pageIndex);
      const open = unclosedStates(page);
      if (open > 0) page.pushOperators(...Array.from({ length: open }, () => popGraphicsState()));
    }

    sendProgress(10 + Math.round(((i + 1) / total) * 80), `Applying annotation ${i + 1}/${total}…`);

    if (ann.imageDataUrl && (ann.type === 'signature' || ann.type === 'initials')) {
      let image = embedded.get(ann.imageDataUrl);
      if (!image) {
        // Convert base64 data URL to bytes
        const base64 = ann.imageDataUrl.split(',')[1];
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);

        const isPng = ann.imageDataUrl.startsWith('data:image/png');
        image = isPng
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        embedded.set(ann.imageDataUrl, image);
      }

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
  // The owner password is never defaulted to the open password: that would make
  // whoever opens the file its owner, and the permissions would bind no one.
  const result = await qpdfEncrypt(input, {
    userPassword: options.userPassword,
    ownerPassword: options.ownerPassword ?? '',
    permissions: options.permissions,
  });

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
  const { PDFDocument, StandardFonts, degrees, rgb, PDFArray, PDFName } = await import('pdf-lib');

  sendProgress(10, 'Loading document…');
  const doc = await PDFDocument.load(toUint8Array(buffer), { ignoreEncryption: true });
  const pages = doc.getPages();

  /**
   * Move the watermark underneath the page's existing content.
   *
   * pdf-lib has no z-order API: every draw call appends to the page's content
   * stream, so a watermark always lands on top. But `addContentStream` first
   * normalises /Contents into an array and pushes our stream last, so moving
   * that last entry to the front paints it before everything else — which is
   * exactly "behind". pdf-lib wraps each draw in q/Q, so the graphics state the
   * original content inherits is unchanged.
   *
   * Call this once per page, after that page's draw calls — and only if something
   * was drawn, or the "last entry" is part of the original content instead.
   */
  const moveLastContentStreamToBack = (page: (typeof pages)[number]) => {
    const contents = page.node.get(PDFName.of('Contents'));
    if (!(contents instanceof PDFArray) || contents.size() < 2) return;
    const last = contents.get(contents.size() - 1);
    contents.remove(contents.size() - 1);
    contents.insert(0, last);
  };

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
    let drew = false;

    if (options.type === 'text' && options.text) {
      drew = true;
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
      drew = true;
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

    if (drew && options.layer === 'behind') moveLastContentStreamToBack(page);
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

  // The three PDF base-14 families, so the output needs no embedded font file.
  const STANDARD_FONTS = {
    Helvetica: StandardFonts.Helvetica,
    'Times-Roman': StandardFonts.TimesRoman,
    Courier: StandardFonts.Courier,
  } as const;
  const fontKey = (options.font ?? 'Helvetica') as keyof typeof STANDARD_FONTS;
  const font = await doc.embedFont(STANDARD_FONTS[fontKey] ?? StandardFonts.Helvetica);
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

    // The geometry is shared with the on-screen preview, so the two cannot disagree.
    const { pageW, pageH, draw } = layoutImagePage(image, options);
    const page = doc.addPage([pageW, pageH]);

    if (options.backgroundColor) {
      const [r, g, b] = parseColor(options.backgroundColor);
      page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(r, g, b) });
    }

    page.drawImage(image, { x: draw.x, y: draw.y, width: draw.w, height: draw.h });
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
