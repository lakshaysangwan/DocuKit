/**
 * How sharp each image is where it is drawn: its effective resolution, in
 * pixels per inch of the page, worked out from the content streams.
 *
 * A PDF image has a pixel size but no resolution of its own; the page decides
 * how large it is drawn (the current transformation matrix at its `Do`). An
 * image 3000 pixels wide drawn 10 inches wide is 300 DPI there. Compress PDF's
 * DPI setting reduces an image only when it is sharper than the setting
 * everywhere it is drawn — so the largest placement decides. Width and height
 * are measured separately: an image can be drawn stretched, sharper across
 * than down.
 *
 * Conservative by construction: an image gets a figure only when every place
 * that can draw it was read. It gets none (and keeps its resolution) when it is
 * named by resources this does not interpret — annotation appearances, tiling
 * patterns, Type 3 glyphs, forms nothing draws — or by a content stream that
 * could not be decoded or parsed.
 *
 * Pure pdf-lib, no canvas: runs in the PDF worker on every engine.
 */
import type { PDFDict, PDFDocument, PDFObject, PDFRef } from 'pdf-lib';

type PdfLib = typeof import('pdf-lib');
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** Forms nested deeper than this are not followed (their images get no figure). */
const MAX_FORM_DEPTH = 12;

/** m1 × m2 in PDF's row-vector convention: apply m1, then m2. */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

// ─── A minimal content-stream reader ─────────────────────────────────────────

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (c: number) => !WHITE.has(c) && !DELIM.has(c);

type Operand = number | string | null;

/**
 * Calls `onOperator` for each operator with the numbers and names before it
 * (names as "/Name"; anything else as null). Strings, arrays, dictionaries and
 * inline image data are skipped over. Throws on what it cannot follow.
 */
export function readOperators(bytes: Uint8Array, onOperator: (op: string, operands: Operand[]) => void): void {
  const n = bytes.length;
  let i = 0;
  let operands: Operand[] = [];
  const word = (start: number) => {
    let end = start;
    while (end < n && isRegular(bytes[end])) end++;
    return end;
  };
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

  while (i < n) {
    const c = bytes[i];
    if (WHITE.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; continue; } // % comment
    if (c === 0x28) { // (string), nested parentheses and escapes
      let depth = 0;
      for (; i < n; i++) {
        const ch = bytes[i];
        if (ch === 0x5c) { i++; continue; }
        if (ch === 0x28) depth++;
        else if (ch === 0x29 && --depth === 0) { i++; break; }
      }
      if (depth !== 0) throw new Error('unterminated string');
      operands.push(null);
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) { i += 2; operands.push(null); continue; } // << — contents are ordinary tokens
      const end = bytes.indexOf(0x3e, i);
      if (end < 0) throw new Error('unterminated hex string');
      i = end + 1;
      operands.push(null);
      continue;
    }
    if (c === 0x3e) { i += bytes[i + 1] === 0x3e ? 2 : 1; continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; operands.push(null); continue; }
    if (c === 0x29) throw new Error('stray )');
    if (c === 0x2f) { // /Name
      const end = word(i + 1);
      operands.push(text(i, end));
      i = end;
      continue;
    }
    const end = word(i);
    const token = text(i, end);
    i = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) { operands.push(Number(token)); continue; }
    if (token === 'true' || token === 'false' || token === 'null') { operands.push(null); continue; }
    if (token === 'BI') {
      // Inline image: its dictionary up to ID, one whitespace byte, then binary
      // data up to an EI that stands as a word of its own.
      let id = -1;
      for (let j = i; j + 1 < n; j++) {
        if (bytes[j] === 0x49 && bytes[j + 1] === 0x44 && WHITE.has(bytes[j - 1]) && (j + 2 >= n || !isRegular(bytes[j + 2]))) { id = j; break; }
      }
      if (id < 0) throw new Error('inline image without ID');
      let j = id + 3;
      for (; j + 1 < n; j++) {
        if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && WHITE.has(bytes[j - 1]) && (j + 2 >= n || !isRegular(bytes[j + 2]))) break;
      }
      if (j + 1 >= n) throw new Error('inline image without EI');
      i = j + 2;
      operands = [];
      continue;
    }
    onOperator(token, operands);
    operands = [];
  }
}

// ─── Walking pages and forms ────────────────────────────────────────────────

/** Pixels per inch along an image's own width (`x`) and height (`y`). */
export interface PlacedDpi {
  x: number;
  y: number;
}

/**
 * For each image some page draws, the lowest resolution it is drawn at along
 * its width and along its height. Images with no reliable figure are absent.
 */
export function imageEffectiveDpi(lib: PdfLib, doc: PDFDocument): Map<PDFRef, PlacedDpi> {
  const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef: Ref, PDFRawStream, decodePDFRawStream } = lib;
  const context = doc.context;

  /** Smallest pixels-per-point seen for each image, per axis. */
  const lowest = new Map<PDFRef, PlacedDpi>();
  /** Images named by a resource dictionary some unread content could draw from. */
  const unknown = new Set<PDFRef>();
  /** Objects whose content was read: pages and forms. */
  const read = new Set<PDFObject>();

  const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);
  const matrixOf = (o: PDFObject | undefined): Matrix => {
    if (!(o instanceof PDFArray) || o.size() !== 6) return IDENTITY;
    const m = o.asArray().map((_, k) => num(o.lookup(k)));
    return m.every((v) => v !== undefined && Number.isFinite(v)) ? (m as Matrix) : IDENTITY;
  };

  /** Every image (directly, or inside forms) a resource dictionary names. */
  const imagesUnder = (resources: PDFDict | undefined, out: Set<PDFRef>, seen = new Set<PDFObject>()) => {
    const xobjects = resources?.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
      if (!(value instanceof Ref)) continue;
      const target = context.lookup(value);
      if (!(target instanceof PDFRawStream) || seen.has(target)) continue;
      seen.add(target);
      const subtype = target.dict.lookup(PDFName.of('Subtype'));
      if (subtype === PDFName.of('Image')) out.add(value);
      else if (subtype === PDFName.of('Form')) {
        const inner = target.dict.lookup(PDFName.of('Resources'));
        imagesUnder(inner instanceof PDFDict ? inner : undefined, out, seen);
      }
    }
  };
  const giveUp = (resources: PDFDict | undefined) => imagesUnder(resources, unknown);

  const contentBytes = (contents: PDFObject | undefined): Uint8Array => {
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((v) => context.lookup(v))
      : contents === undefined ? [] : [contents instanceof Ref ? context.lookup(contents) : contents];
    const parts = streams.map((s) => {
      if (!(s instanceof PDFRawStream)) throw new Error('content is not a stream');
      return decodePDFRawStream(s).decode();
    });
    // Separate streams of one page are one sequence of operators, split anywhere.
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length + 1, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; out[at++] = 0x0a; }
    return out;
  };

  const run = (bytes: Uint8Array, resources: PDFDict | undefined, start: Matrix, unit: number, depth: number, onStack: Set<PDFObject>) => {
    const stack: Matrix[] = [];
    let ctm = start;
    readOperators(bytes, (op, args) => {
      if (op === 'q') stack.push(ctm);
      else if (op === 'Q') ctm = stack.pop() ?? ctm;
      else if (op === 'cm') {
        if (args.length >= 6 && args.slice(-6).every((a) => typeof a === 'number')) {
          ctm = multiply(args.slice(-6) as Matrix, ctm);
        } else {
          throw new Error('cm without six numbers');
        }
      } else if (op === 'Do') {
        const name = args[args.length - 1];
        if (typeof name !== 'string') return;
        const xobjects = resources?.lookup(PDFName.of('XObject'));
        const ref = xobjects instanceof PDFDict ? xobjects.get(PDFName.of(name.slice(1))) : undefined;
        if (!(ref instanceof Ref)) return;
        const target = context.lookup(ref);
        if (!(target instanceof PDFRawStream)) return;
        const subtype = target.dict.lookup(PDFName.of('Subtype'));
        if (subtype === PDFName.of('Image')) {
          const width = num(target.dict.lookup(PDFName.of('Width')));
          const height = num(target.dict.lookup(PDFName.of('Height')));
          // The unit square's two sides on the page, in points.
          const across = Math.hypot(ctm[0], ctm[1]) * unit;
          const down = Math.hypot(ctm[2], ctm[3]) * unit;
          if (!width || !height || !(across > 0) || !(down > 0)) { unknown.add(ref); return; }
          const seen = lowest.get(ref);
          lowest.set(ref, { x: Math.min(seen?.x ?? Infinity, width / across), y: Math.min(seen?.y ?? Infinity, height / down) });
        } else if (subtype === PDFName.of('Form')) {
          const inner = target.dict.lookup(PDFName.of('Resources'));
          const formResources = inner instanceof PDFDict ? inner : resources;
          if (depth >= MAX_FORM_DEPTH || onStack.has(target)) { giveUp(formResources); return; }
          read.add(target);
          onStack.add(target);
          try {
            run(decodePDFRawStream(target).decode(), formResources, multiply(matrixOf(target.dict.lookup(PDFName.of('Matrix'))), ctm), unit, depth + 1, onStack);
          } catch {
            giveUp(formResources);
          } finally {
            onStack.delete(target);
          }
        }
      }
    });
  };

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    read.add(page.node);
    const unit = num(page.node.lookup(PDFName.of('UserUnit'))) ?? 1;
    try {
      run(contentBytes(page.node.get(PDFName.of('Contents'))), resources, IDENTITY, unit > 0 ? unit : 1, 0, new Set());
    } catch {
      giveUp(resources);
    }
  }

  // Anything else that has resources and was not read — an annotation's
  // appearance, a pattern, a Type 3 font, a form nothing draws — could draw its
  // images at any size.
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : undefined;
    if (!dict || read.has(obj) || read.has(dict)) continue;
    if (dict.lookup(PDFName.of('Type')) === PDFName.of('Pages')) continue; // inherited by pages, which were read
    const resources = dict.lookup(PDFName.of('Resources'));
    if (resources instanceof PDFDict) giveUp(resources);
  }

  const out = new Map<PDFRef, PlacedDpi>();
  for (const [ref, perPoint] of lowest) if (!unknown.has(ref)) out.set(ref, { x: perPoint.x * 72, y: perPoint.y * 72 });
  return out;
}
