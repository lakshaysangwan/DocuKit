/**
 * What Split PDF will produce, worked out before it runs.
 *
 * The page field is the source of truth: the grid's labels, the list of output
 * files and the job sent to the worker are all derived from the same plan, so
 * what the visitor is shown is what they get.
 */
import { formatPageRange } from './pdf-page-range';

export type SplitMode = 'extract' | 'remove' | 'ranges' | 'every-n' | 'each';

export interface SplitOutput {
  /** The file name it downloads as. */
  name: string;
  /** 0-indexed source pages, in the order they appear in the file. */
  pages: number[];
}

export type PageCheck = { ok: true; pages: number[] } | { ok: false; error: string };

const WORD = /^(all|odd|even|first|last)$/;
const SPAN = /^(\d+|first)\s*-\s*(\d+|last)$/;

function help(total: number): string {
  if (total === 1) return 'This PDF has 1 page.';
  return `This PDF has ${total} pages: use 1 to ${total}, odd, even or last.`;
}

/**
 * Read ONE selection ("1-3, 8, odd, last") strictly: anything that is not a
 * page of this PDF is an error, never silently dropped. Pages come back sorted
 * and without repeats. An empty field is a valid, empty selection.
 */
export function checkPages(text: string, total: number): PageCheck {
  const pages = new Set<number>();
  for (const raw of text.split(',')) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    const check = checkPart(part, raw.trim(), total);
    if (!check.ok) return check;
    for (const p of check.pages) pages.add(p);
  }
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}

/**
 * Read the Split by Range field: each comma-separated part is one PDF
 * ("1-3, 4-6, 7-last" is three). A part may be a single page or a keyword.
 */
export function checkRanges(text: string, total: number): { ok: true; ranges: number[][] } | { ok: false; error: string } {
  const ranges: number[][] = [];
  for (const raw of text.split(',')) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    const check = checkPart(part, raw.trim(), total);
    if (!check.ok) return check;
    ranges.push(check.pages);
  }
  return { ok: true, ranges };
}

function checkPart(part: string, shown: string, total: number): PageCheck {
  const all = Array.from({ length: total }, (_, i) => i);
  if (WORD.test(part)) {
    if (part === 'all') return { ok: true, pages: all };
    if (part === 'odd') return { ok: true, pages: all.filter((i) => i % 2 === 0) };
    if (part === 'even') {
      const even = all.filter((i) => i % 2 === 1);
      if (even.length === 0) return { ok: false, error: `"${shown}" picks no pages. ${help(total)}` };
      return { ok: true, pages: even };
    }
    return { ok: true, pages: part === 'first' ? [0] : [total - 1] };
  }
  const span = SPAN.exec(part);
  if (span) {
    const start = span[1] === 'first' ? 1 : Number(span[1]);
    const end = span[2] === 'last' ? total : Number(span[2]);
    if (start > end) return { ok: false, error: `"${shown}" runs backwards: write the lower page first. ${help(total)}` };
    if (start < 1 || end > total) return { ok: false, error: `"${shown}" goes past the last page. ${help(total)}` };
    return { ok: true, pages: Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i) };
  }
  if (/^\d+$/.test(part)) {
    const n = Number(part);
    if (n < 1 || n > total) return { ok: false, error: `There is no page ${n}. ${help(total)}` };
    return { ok: true, pages: [n - 1] };
  }
  return { ok: false, error: `"${shown}" is not a page or a range. ${help(total)}` };
}

/** Read the Split Every N field: a whole number of pages, at least 1. */
export function checkEveryN(text: string): { ok: true; n: number } | { ok: false; error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1) return { ok: false, error: 'Pages per PDF must be a whole number, 1 or more.' };
  return { ok: true, n: Number(t) };
}

/** `report.PDF` → `report`. */
export function baseNameOf(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '') || 'document';
}

/**
 * The files a split produces. Extract and Remove give one file,
 * `<name>-split.pdf`; the other modes give `<name>-part1.pdf`, `-part2`…
 *
 * `pages` is the selection (Extract, Remove) and `ranges` the ranges (Split by
 * Range); each is used only by its own mode.
 */
export function planSplit(args: {
  mode: SplitMode;
  total: number;
  baseName: string;
  pages?: number[];
  ranges?: number[][];
  n?: number;
}): SplitOutput[] {
  const { mode, total, baseName } = args;
  const single = (pages: number[]) => (pages.length ? [{ name: `${baseName}-split.pdf`, pages }] : []);
  const parts = (groups: number[][]) => groups.map((pages, i) => ({ name: `${baseName}-part${i + 1}.pdf`, pages }));
  const all = Array.from({ length: total }, (_, i) => i);

  switch (mode) {
    case 'extract':
      return single(args.pages ?? []);
    case 'remove': {
      const removed = new Set(args.pages ?? []);
      if (removed.size === 0) return [];
      return single(all.filter((i) => !removed.has(i)));
    }
    case 'ranges':
      return parts(args.ranges ?? []);
    case 'every-n': {
      const n = args.n ?? 0;
      if (n < 1) return [];
      const groups: number[][] = [];
      for (let start = 0; start < total; start += n) groups.push(all.slice(start, start + n));
      return parts(groups);
    }
    case 'each':
      return parts(all.map((i) => [i]));
  }
}

/** "1–3, 5" with an en dash, for showing pages to people. */
export function describePages(pages: number[]): string {
  return formatPageRange(pages).replace(/-/g, '–');
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
