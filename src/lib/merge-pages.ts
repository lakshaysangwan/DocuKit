/**
 * Merge PDF's page list: every page of the merged PDF, in output order.
 *
 * The list is the single source of truth. The per-file range fields, the page
 * grid, the action's page count and what is sent to the worker are all read
 * from it, and every change — typing a range, removing or dragging a page,
 * reordering files — is one of the pure operations below.
 *
 * `pageIndex` is zero-based. `null` stands for "all pages of this file": a
 * locked file whose page count is unknown until its password is entered. It is
 * replaced by the real pages once the file opens.
 */
import { formatPageRange } from './pdf-page-range';

export interface MergePage {
  /** Stable for the life of the entry: the grid's sortable id. */
  id: string;
  fileId: string;
  pageIndex: number | null;
}

/** One run of consecutive output pages from one file, as the worker takes it. */
export interface MergeSegment {
  /** Index into the files (and buffers) sent to the worker. */
  file: number;
  /** Zero-based source pages in output order; null = every page of the file. */
  pages: number[] | null;
}

export type IdMaker = () => string;

/** The pages a file contributes when added: all of them, or one placeholder while it is locked. */
export function pagesOfFile(fileId: string, pageCount: number | null, makeId: IdMaker): MergePage[] {
  if (pageCount === null) return [{ id: makeId(), fileId, pageIndex: null }];
  return Array.from({ length: pageCount }, (_, pageIndex) => ({ id: makeId(), fileId, pageIndex }));
}

export function pagesFrom(fileId: string, indices: number[], makeId: IdMaker): MergePage[] {
  return indices.map((pageIndex) => ({ id: makeId(), fileId, pageIndex }));
}

/**
 * Put `pages` in place of every page of `fileId`, at the position of that
 * file's first page. A file with no pages in the list gets them at the end.
 */
export function replaceFilePages(list: MergePage[], fileId: string, pages: MergePage[]): MergePage[] {
  const at = list.findIndex((p) => p.fileId === fileId);
  const rest = list.filter((p) => p.fileId !== fileId);
  if (at === -1) return [...rest, ...pages];
  // Everything before the file's first page belongs to other files and keeps its place.
  return [...rest.slice(0, at), ...pages, ...rest.slice(at)];
}

export function removePage(list: MergePage[], id: string): MergePage[] {
  return list.filter((p) => p.id !== id);
}

export function removeFile(list: MergePage[], fileId: string): MergePage[] {
  return list.filter((p) => p.fileId !== fileId);
}

/** Move the page `fromId` to where `toId` is (dnd-kit's arrayMove semantics). */
export function movePage(list: MergePage[], fromId: string, toId: string): MergePage[] {
  const from = list.findIndex((p) => p.id === fromId);
  const to = list.findIndex((p) => p.id === toId);
  if (from === -1 || to === -1 || from === to) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Group the pages by file in `fileOrder`, keeping each file's own page order.
 * What reordering the files does, and what "Reset order" does with the files'
 * own pages sorted first.
 */
export function regroupByFiles(list: MergePage[], fileOrder: string[]): MergePage[] {
  return fileOrder.flatMap((fileId) => list.filter((p) => p.fileId === fileId));
}

/** Files in order, each with its chosen pages in page order: the order a plain merge would give. */
export function resetOrder(list: MergePage[], fileOrder: string[]): MergePage[] {
  return fileOrder.flatMap((fileId) =>
    list
      .filter((p) => p.fileId === fileId)
      .sort((a, b) => (a.pageIndex ?? -1) - (b.pageIndex ?? -1)),
  );
}

/** The zero-based pages of one file that are in the list, in page order. */
export function chosenPages(list: MergePage[], fileId: string): number[] {
  return list
    .filter((p) => p.fileId === fileId && p.pageIndex !== null)
    .map((p) => p.pageIndex as number)
    .sort((a, b) => a - b);
}

/** What a file's range field says once the grid has changed its pages: "1-2, 5". */
export function rangeTextFor(list: MergePage[], fileId: string): string {
  return formatPageRange(chosenPages(list, fileId));
}

const RANGE_WORD = /^(all|odd|even|first|last)$/;
const RANGE_SPAN = /^(\d+|first)\s*-\s*(\d+|last)$/;

export type ParsedRange = { ok: true; pages: number[] } | { ok: false; error: string };

/**
 * Read a range field strictly: "1-3, 5", "2-last", "odd". Empty means every
 * page. Anything it cannot read — a stray letter, "0", a page past the end, a
 * backwards span, nothing left — is an error, so a half-typed range never
 * quietly changes the grid. Pages come back zero-based, ascending, once each.
 */
export function parseMergeRange(text: string, pageCount: number): ParsedRange {
  const all = Array.from({ length: pageCount }, (_, i) => i);
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, pages: all };
  const help =
    pageCount === 1
      ? 'This file has 1 page.'
      : pageCount === 2
        ? 'This file has 2 pages: use 1, 2 or 1-2.'
        : `Use pages 1 to ${pageCount}, like 1-2, ${pageCount}.`;

  const pages = new Set<number>();
  for (const raw of trimmed.split(',')) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    const num = (s: string) => (s === 'first' ? 1 : s === 'last' ? pageCount : Number(s));
    if (RANGE_WORD.test(part)) {
      for (const i of all) {
        if (part === 'all' || (part === 'odd' && i % 2 === 0) || (part === 'even' && i % 2 === 1)) pages.add(i);
      }
      if (part === 'first' && pageCount > 0) pages.add(0);
      if (part === 'last' && pageCount > 0) pages.add(pageCount - 1);
      continue;
    }
    const span = RANGE_SPAN.exec(part);
    if (span) {
      const start = num(span[1]);
      const end = num(span[2]);
      if (start < 1 || end > pageCount || start > end) return { ok: false, error: `"${raw.trim()}" is not a page range in this file. ${help}` };
      for (let p = start; p <= end; p++) pages.add(p - 1);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > pageCount) return { ok: false, error: `There is no page ${n} in this file. ${help}` };
      pages.add(n - 1);
      continue;
    }
    return { ok: false, error: `"${raw.trim()}" is not a page range. ${help}` };
  }
  if (pages.size === 0) return { ok: false, error: `No pages chosen. ${help}` };
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}

/**
 * Whether the list is just "every file, whole, in file order" — the plain merge
 * the worker does without being told any pages.
 */
export function isPlainOrder(list: MergePage[], fileOrder: string[], pageCounts: Map<string, number | null>): boolean {
  let i = 0;
  for (const fileId of fileOrder) {
    const count = pageCounts.get(fileId);
    if (count === undefined) return false;
    if (count === null) {
      if (list[i]?.fileId !== fileId || list[i]?.pageIndex !== null) return false;
      i++;
      continue;
    }
    for (let p = 0; p < count; p++, i++) {
      if (list[i]?.fileId !== fileId || list[i]?.pageIndex !== p) return false;
    }
  }
  return i === list.length;
}

/** The list as the worker takes it: runs of consecutive output pages from one file. */
export function toSegments(list: MergePage[], fileOrder: string[]): MergeSegment[] {
  const index = new Map(fileOrder.map((id, i) => [id, i]));
  const out: MergeSegment[] = [];
  for (const page of list) {
    const file = index.get(page.fileId);
    if (file === undefined) continue;
    if (page.pageIndex === null) {
      out.push({ file, pages: null });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.file === file && last.pages !== null) last.pages.push(page.pageIndex);
    else out.push({ file, pages: [page.pageIndex] });
  }
  return out;
}

/** A, B, … Z, AA, AB, … — the badge for the file at `index`. */
export function fileLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
