/**
 * Bookmark- and link-preserving merge, via MuPDF.
 *
 * pdf-lib's `copyPages` copies page content but has no outline API at all, so a
 * merge through it silently drops every bookmark. MuPDF instead *grafts* pages:
 * `graftPage` pulls a page across with its dependent objects and rewrites the
 * references.
 *
 * Two things graft does NOT bring with it, both verified rather than assumed:
 * outlines, and **link annotations** — a grafted page arrives with no /Annots at
 * all. So links are re-created on the output page, and the outline is rebuilt
 * from scratch. Both have to be rewritten anyway, because each source document's
 * bookmarks and links point at its own page numbers and those all shift in the
 * merged file.
 *
 * The outline tree is written as explicit PDF objects rather than through
 * `OutlineIterator`, whose insert-position semantics are easy to get subtly
 * wrong when building a nested tree in one pass. The structure here is the one
 * the spec describes: a /Outlines root, and items chained by /Prev and /Next
 * with /First and /Last on each parent.
 *
 * This path is opt-in (merge's `preserveBookmarks`) because it pulls in MuPDF's
 * ~10 MB WASM, which is a steep price for the many merges that have no outline.
 */
import type * as MuPDF from 'mupdf';

export interface MergeInput {
  bytes: Uint8Array;
  /** 0-based source page indices to include, or null for every page. */
  pages: number[] | null;
  /** Used only in error messages. */
  name: string;
}

/**
 * mupdf declares `OutlineItem` but doesn't export it, so mirror the shape
 * `loadOutline()` returns.
 */
interface SourceOutlineItem {
  title?: string;
  uri?: string;
  page?: number;
  down?: SourceOutlineItem[];
}

/** One bookmark, already remapped onto merged-document page numbers. */
interface OutlineEntry {
  title: string;
  /** 0-based page index in the merged document. */
  page: number;
  children: OutlineEntry[];
}

/**
 * PDF text strings are PDFDocEncoding unless they open with a UTF-16BE byte
 * order mark. Titles are arbitrary user text, so anything outside ASCII goes out
 * as UTF-16BE to survive the round trip.
 */
function putTitle(doc: MuPDF.PDFDocument, obj: MuPDF.PDFObject, title: string): void {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(title)) {
    obj.put('Title', doc.newString(title));
    return;
  }
  const bytes: number[] = [0xfe, 0xff];
  for (const ch of title) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      // Surrogate pair, written high then low.
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      bytes.push(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
    } else {
      bytes.push(cp >> 8, cp & 0xff);
    }
  }
  obj.put('Title', doc.newByteString(bytes));
}

/**
 * Rebase one document's outline onto merged page numbers.
 *
 * Bookmarks whose target page was left out of the merge (a page selection can
 * exclude it) are dropped, but their children are promoted rather than lost —
 * losing a whole subtree because one intermediate heading was excluded would be
 * worse than a slightly flattened tree.
 */
function remapOutline(
  items: SourceOutlineItem[],
  src: MuPDF.PDFDocument,
  pageMap: Map<number, number>
): OutlineEntry[] {
  const out: OutlineEntry[] = [];

  for (const item of items) {
    const children = item.down ? remapOutline(item.down, src, pageMap) : [];

    let srcPage = item.page;
    if (srcPage === undefined && item.uri) {
      try { srcPage = src.resolveLink(item.uri); } catch { srcPage = undefined; }
    }

    const mapped = srcPage === undefined ? undefined : pageMap.get(srcPage);
    if (mapped === undefined) {
      out.push(...children);
      continue;
    }

    out.push({ title: item.title ?? 'Untitled', page: mapped, children });
  }

  return out;
}

/** Write one level of the outline tree; returns the objects to link from parent. */
function writeLevel(
  doc: MuPDF.PDFDocument,
  entries: OutlineEntry[],
  parent: MuPDF.PDFObject
): { first: MuPDF.PDFObject; last: MuPDF.PDFObject } {
  const objs = entries.map(() => doc.addObject(doc.newDictionary()));

  entries.forEach((entry, i) => {
    const obj = objs[i];
    putTitle(doc, obj, entry.title);
    obj.put('Parent', parent);
    if (i > 0) obj.put('Prev', objs[i - 1]);
    if (i < objs.length - 1) obj.put('Next', objs[i + 1]);

    // [page /Fit] — jump to the page, fitting it to the window.
    const dest = doc.newArray();
    dest.push(doc.findPage(entry.page));
    dest.push(doc.newName('Fit'));
    obj.put('Dest', dest);

    if (entry.children.length > 0) {
      const sub = writeLevel(doc, entry.children, obj);
      obj.put('First', sub.first);
      obj.put('Last', sub.last);
      // Negative /Count means the subtree starts collapsed.
      obj.put('Count', -entry.children.length);
    }
  });

  return { first: objs[0], last: objs[objs.length - 1] };
}

function writeOutline(doc: MuPDF.PDFDocument, entries: OutlineEntry[]): void {
  if (entries.length === 0) return;

  const outlines = doc.addObject(doc.newDictionary());
  outlines.put('Type', doc.newName('Outlines'));

  const { first, last } = writeLevel(doc, entries, outlines);
  outlines.put('First', first);
  outlines.put('Last', last);
  outlines.put('Count', entries.length);

  doc.getTrailer().get('Root').put('Outlines', outlines);
}

export async function mergeWithOutlines(
  inputs: MergeInput[],
  insertBlankPages: boolean,
  sendProgress: (pct: number, label?: string) => void
): Promise<Uint8Array> {
  const mupdf = (await import('mupdf')) as typeof MuPDF;

  sendProgress(10, 'Loading documents…');
  const out = new mupdf.PDFDocument();

  const entries: OutlineEntry[] = [];
  let outPageCount = 0;
  let lastBounds: [number, number, number, number] = [0, 0, 612, 792];

  for (let di = 0; di < inputs.length; di++) {
    const input = inputs[di];
    const opened = mupdf.Document.openDocument(input.bytes, 'application/pdf');
    const src = opened.asPDF();
    if (!src) throw new Error(`"${input.name}" is not a PDF document.`);

    const count = src.countPages();
    const indices = input.pages && input.pages.length > 0
      ? input.pages.filter((i) => i >= 0 && i < count)
      : Array.from({ length: count }, (_, i) => i);

    const pageMap = new Map<number, number>();
    for (const idx of indices) {
      out.graftPage(-1, src, idx);
      pageMap.set(idx, outPageCount++);
      const bounds = src.loadPage(idx).getBounds();
      lastBounds = [bounds[0], bounds[1], bounds[2], bounds[3]];
    }

    // Re-create the links graft left behind. External links carry over as-is;
    // internal ones are re-pointed at the target page's merged position, and
    // dropped when that page was excluded by a page selection.
    for (const [srcIdx, outIdx] of pageMap) {
      const links = src.loadPage(srcIdx).getLinks();
      if (links.length === 0) continue;
      const outPage = out.loadPage(outIdx);

      for (const link of links) {
        const uri = link.getURI();
        if (!uri) continue;

        if (link.isExternal()) {
          outPage.createLink(link.getBounds(), uri);
          continue;
        }

        let targetSrcPage: number | undefined;
        try { targetSrcPage = src.resolveLink(uri); } catch { targetSrcPage = undefined; }
        const targetOutPage = targetSrcPage === undefined ? undefined : pageMap.get(targetSrcPage);
        if (targetOutPage === undefined) continue;

        outPage.createLink(
          link.getBounds(),
          out.formatLinkURI({
            type: 'Fit',
            chapter: 0,
            page: targetOutPage,
            x: 0, y: 0, width: 0, height: 0, zoom: 0,
          })
        );
      }
    }

    const outline = src.loadOutline();
    if (outline) entries.push(...remapOutline(outline, src, pageMap));

    if (insertBlankPages && di < inputs.length - 1) {
      const blank = out.addPage(lastBounds, 0, out.newDictionary(), '');
      out.insertPage(-1, blank);
      outPageCount++;
    }

    sendProgress(10 + Math.round(((di + 1) / inputs.length) * 70), `Merged ${outPageCount} pages…`);
  }

  sendProgress(85, 'Writing bookmarks…');
  writeOutline(out, entries);

  sendProgress(95, 'Saving…');
  const saved = out.saveToBuffer('compress').asUint8Array();
  // Copy off the WASM heap so the bytes stay valid once MuPDF is torn down.
  const copy = new Uint8Array(saved.length);
  copy.set(saved);
  return copy;
}
