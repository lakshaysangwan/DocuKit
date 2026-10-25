/**
 * "Find & mark all", run on MuPDF's text of the page — the same engine that
 * later removes the text, so what is found is what it can remove.
 *
 * MuPDF matches case-insensitively, treats any run of white space in the phrase
 * as any run in the text, and finds a match that crosses from one text item to
 * the next or onto the next line. For each match it gives one box per line,
 * spanning exactly the matched characters; `phraseMarkBox` pads it and pulls
 * it clear of every other character.
 *
 * Marks are returned in PDF user space (lower-left origin, y up), so the page
 * shows them through `page-geometry.ts` like any drawn mark, on a rotated page
 * or one with an offset CropBox too.
 */
import type * as MuPDF from 'mupdf';
import type { PdfRect } from '../pdf/page-geometry';
import { phraseMarkBox, quadToBox, type Box } from './phrase-marks';

export interface PhraseMatch {
  pageIndex: number;
  /** One rectangle per line the match runs over, in PDF user space. */
  rects: PdfRect[];
}

/** Most matches looked for on one page. */
export const MAX_MATCHES_PER_PAGE = 1000;

type Matrix = [number, number, number, number, number, number];

function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** A page-space box → the user-space rectangle it is (rotations are multiples of 90°, so it stays upright). */
function toUserSpace(m: Matrix, box: Box): PdfRect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function findPhrase(doc: MuPDF.PDFDocument, phrase: string): PhraseMatch[] {
  const needle = phrase.trim();
  if (!needle) return [];
  const found: PhraseMatch[] = [];
  for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex++) {
    const page = doc.loadPage(pageIndex) as MuPDF.PDFPage;
    const text = page.toStructuredText();
    try {
      const hits = text.search(needle, MAX_MATCHES_PER_PAGE);
      if (hits.length === 0) continue;
      const chars: Box[] = [];
      text.walk({
        onChar: (_c, _origin, _font, _size, quad) => {
          chars.push(quadToBox(quad));
        },
      });
      const toUser = invert(page.getTransform() as unknown as Matrix);
      for (const hit of hits) {
        found.push({ pageIndex, rects: hit.map((quad) => toUserSpace(toUser, phraseMarkBox(quadToBox(quad), chars))) });
      }
    } finally {
      text.destroy();
      page.destroy();
    }
  }
  return found;
}
