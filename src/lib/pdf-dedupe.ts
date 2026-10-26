/**
 * Lossless: store each repeated image once.
 *
 * Many PDFs carry the same picture as several separate objects — a logo on
 * every page, a scanner's identical page background, a signature stamped
 * twice — because the program that wrote them embedded it afresh each time.
 * Two image objects are interchangeable when everything a reader uses to draw
 * them is the same: the stream bytes and every entry of the dictionary
 * (/Filter, /DecodeParms, /ColorSpace, /BitsPerComponent, /Width, /Height,
 * /Decode, /Intent, …), with anything the dictionary points to — a /SMask or
 * /Mask, an ICC profile, a palette — compared by its content in the same way,
 * not by its object number. Every reference to a duplicate is then pointed at
 * one of them and the others are deleted, so the pixels drawn are the very
 * same bytes as before.
 *
 * qpdf has no option for this (it keeps distinct objects distinct), so it is
 * done here on pdf-lib's object graph, before the image pass: a merged image is
 * then also re-encoded only once.
 *
 * Pure pdf-lib plus WebCrypto: runs in the PDF worker and on the main thread.
 */
import type { PDFContext, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';

type PdfLib = typeof import('pdf-lib');

/** Deeper than any real image dictionary nests; past it nothing is merged. */
const MAX_DEPTH = 12;

export interface DedupeResult {
  /** Image objects removed because an identical one was kept. */
  imagesMerged: number;
  /** Encoded bytes of every stream removed (images and what only they used). */
  bytesMerged: number;
  /** For each image kept in place of others: how many identical copies it replaced. */
  copies: Map<PDFRef, number>;
}

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Merge identical image XObjects, and identical streams those images use
 * (masks, ICC profiles, palettes), throughout the document.
 */
export async function deduplicateImages(lib: PdfLib, context: PDFContext): Promise<DedupeResult> {
  const { PDFName, PDFRawStream, PDFRef: Ref, PDFDict, PDFArray } = lib;
  const none: DedupeResult = { imagesMerged: 0, bytesMerged: 0, copies: new Map() };
  if (typeof crypto === 'undefined' || !crypto.subtle) return none;

  const isImage = (s: PDFRawStream) => s.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image');

  // Candidates: every image, and every stream reachable from an image's
  // dictionary. Nothing else is touched (page content, fonts, forms).
  const candidates = new Map<string, { ref: PDFRef; stream: PDFRawStream }>();
  const addReachable = (obj: PDFObject | undefined, depth: number) => {
    if (!obj || depth > MAX_DEPTH) return;
    if (obj instanceof Ref) {
      const target = context.lookup(obj);
      if (target instanceof PDFRawStream) {
        if (candidates.has(obj.toString())) return;
        candidates.set(obj.toString(), { ref: obj, stream: target });
        addReachable(target.dict, depth + 1);
      } else {
        addReachable(target, depth + 1);
      }
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) addReachable(value, depth + 1);
    } else if (obj instanceof PDFArray) {
      for (const value of obj.asArray()) addReachable(value, depth + 1);
    }
  };
  let images = 0;
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && isImage(obj)) {
      images++;
      addReachable(ref, 0);
    }
  }
  if (images < 2) return none;

  // A digest of each candidate's bytes.
  const digests = new Map<string, string>();
  for (const [key, { stream }] of candidates) {
    const bytes = stream.contents;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    digests.set(key, toHex(await crypto.subtle.digest('SHA-256', copy)));
  }

  // A description of an object by content: references resolved, dictionary keys
  // sorted, /Length (which follows the bytes) left out. Anything that cannot be
  // described — too deep, a cycle — gets a description unique to it.
  const memo = new Map<string, string>();
  const describe = (obj: PDFObject | undefined, depth: number, path: Set<string>): string => {
    if (obj === undefined) return 'undefined';
    if (obj instanceof Ref) {
      const key = obj.toString();
      if (depth > MAX_DEPTH || path.has(key)) return `unique(${key})`;
      const known = memo.get(key);
      if (known) return known;
      const target = context.lookup(obj);
      path.add(key);
      const out = target instanceof PDFRawStream && digests.has(key)
        ? `stream(${digests.get(key)},${target.contents.byteLength},${describe(target.dict, depth + 1, path)})`
        : target instanceof PDFRawStream
          ? `unique(${key})`
          : describe(target, depth + 1, path);
      path.delete(key);
      if (!out.includes('unique(')) memo.set(key, out);
      return out;
    }
    if (obj instanceof PDFDict) {
      const entries = obj.entries()
        .filter(([name]) => name !== PDFName.of('Length'))
        .map(([name, value]) => `${name.toString()}=${describe(value, depth + 1, path)}`)
        .sort();
      return `<<${entries.join(' ')}>>`;
    }
    if (obj instanceof PDFArray) return `[${obj.asArray().map((v) => describe(v, depth + 1, path)).join(' ')}]`;
    if (obj instanceof PDFRawStream) return 'unique(direct stream)';
    return obj.toString();
  };

  // Group, oldest object first; the first of each group is the one kept.
  const groups = new Map<string, Array<{ ref: PDFRef; stream: PDFRawStream }>>();
  const sorted = [...candidates.values()].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber || a.ref.generationNumber - b.ref.generationNumber);
  for (const entry of sorted) {
    const description = describe(entry.ref, 0, new Set());
    if (description.includes('unique(')) continue;
    const group = groups.get(description);
    if (group) group.push(entry);
    else groups.set(description, [entry]);
  }

  const replace = new Map<string, PDFRef>();
  let imagesMerged = 0;
  let bytesMerged = 0;
  const copies = new Map<PDFRef, number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [kept, ...rest] = group;
    for (const dup of rest) {
      // The digest says they are equal; the bytes are compared anyway.
      if (!sameBytes(dup.stream.contents, kept.stream.contents)) continue;
      replace.set(dup.ref.toString(), kept.ref);
      bytesMerged += dup.stream.contents.byteLength;
      if (isImage(dup.stream)) {
        imagesMerged++;
        copies.set(kept.ref, (copies.get(kept.ref) ?? 0) + 1);
      }
    }
  }
  if (replace.size === 0) return none;

  // Point every reference to a duplicate at the copy that is kept, wherever it
  // is: page resources, form resources, other images' masks, annotations.
  const rewrite = (obj: PDFObject): void => {
    if (obj instanceof PDFDict) {
      for (const [name, value] of obj.entries()) {
        const to = value instanceof Ref ? replace.get(value.toString()) : undefined;
        if (to) obj.set(name, to);
        else rewrite(value);
      }
    } else if (obj instanceof PDFArray) {
      obj.asArray().forEach((value, i) => {
        const to = value instanceof Ref ? replace.get(value.toString()) : undefined;
        if (to) obj.set(i, to);
        else rewrite(value);
      });
    } else if (obj instanceof PDFRawStream || obj instanceof lib.PDFStream) {
      rewrite(obj.dict);
    }
  };
  for (const [, obj] of context.enumerateIndirectObjects()) rewrite(obj);
  for (const key of replace.keys()) {
    const ref = candidates.get(key)!.ref;
    context.delete(ref);
  }
  return { imagesMerged, bytesMerged, copies };
}
