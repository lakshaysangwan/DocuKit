/**
 * Linked copies of a stamp: the same signature on several pages, in the same
 * place on each.
 *
 * Stamps that share a `group` are copies of one another, at most one per page.
 * A change to any of them is a change to all: each copy keeps the box
 * `copyRectToPage` gives it from the one that was changed, so on pages of a
 * different size it keeps the same size and the same distance from the left
 * and bottom edges. Pure, so the tool's undo history can take each change as
 * one step.
 */
import type { RectNorm } from '../pdf/page-geometry';
import { copyRectToPage, type PageSize } from './placement';

export interface GroupedStamp {
  id: string;
  pageIndex: number;
  rect: RectNorm;
  group: string;
  pristine: boolean;
}

/** The displayed size of a page, or undefined when it is not known yet. */
export type PageSizeOf = (pageIndex: number) => PageSize | undefined;

/** The box a copy on `to` gets from a box on `from`. Unknown sizes keep the box as it is. */
function rectFor(rect: RectNorm, from: number, to: number, sizeOf: PageSizeOf): RectNorm {
  if (from === to) return rect;
  const a = sizeOf(from);
  const b = sizeOf(to);
  return a && b ? copyRectToPage(rect, a, b) : rect;
}

/** The pages a group is on, ascending. */
export function groupPages(stamps: readonly GroupedStamp[], group: string): number[] {
  return stamps
    .filter((s) => s.group === group)
    .map((s) => s.pageIndex)
    .sort((a, b) => a - b);
}

/** How many stamps share `stamp`'s group, itself included. */
export function groupSize(stamps: readonly GroupedStamp[], stamp: GroupedStamp): number {
  return stamps.reduce((n, s) => n + (s.group === stamp.group ? 1 : 0), 0);
}

/**
 * Give one stamp a new box, and every linked copy the matching box on its own
 * page. Returns the same array when the stamp does not exist.
 */
export function moveLinked<T extends GroupedStamp>(
  stamps: readonly T[],
  id: string,
  rect: RectNorm,
  pristine: boolean,
  sizeOf: PageSizeOf,
): T[] {
  const source = stamps.find((s) => s.id === id);
  if (!source) return stamps as T[];
  return stamps.map((s) => {
    if (s.id === id) return { ...s, rect, pristine };
    if (s.group !== source.group) return s;
    return { ...s, rect: rectFor(rect, source.pageIndex, s.pageIndex, sizeOf), pristine: false };
  });
}

/**
 * Put `sourceId`'s group on exactly `pages`: copies are added where it is
 * missing (made from the source), removed from pages not listed, and every
 * copy that stays is put back in the source's place. The source itself is
 * removed if its page is not listed. An empty list changes nothing.
 */
export function setGroupPages<T extends GroupedStamp>(
  stamps: readonly T[],
  sourceId: string,
  pages: readonly number[],
  sizeOf: PageSizeOf,
  newId: () => string,
): T[] {
  const source = stamps.find((s) => s.id === sourceId);
  if (!source || pages.length === 0) return stamps as T[];
  const wanted = new Set(pages);
  const kept = new Set<number>();
  const out: T[] = [];
  for (const s of stamps) {
    if (s.group !== source.group) {
      out.push(s);
      continue;
    }
    if (!wanted.has(s.pageIndex) || kept.has(s.pageIndex)) continue;
    kept.add(s.pageIndex);
    out.push(
      s.id === source.id
        ? { ...s, pristine: false }
        : { ...s, rect: rectFor(source.rect, source.pageIndex, s.pageIndex, sizeOf), pristine: false },
    );
  }
  for (const p of [...wanted].sort((a, b) => a - b)) {
    if (kept.has(p)) continue;
    out.push({
      ...source,
      id: newId(),
      pageIndex: p,
      rect: rectFor(source.rect, source.pageIndex, p, sizeOf),
      pristine: false,
    });
  }
  return out;
}

/** Make one copy independent: it gets a group of its own. */
export function unlinkStamp<T extends GroupedStamp>(stamps: readonly T[], id: string, group: string): T[] {
  return stamps.map((s) => (s.id === id ? { ...s, group } : s));
}

/** Remove a stamp, or (`everywhere`) it and every linked copy. */
export function removeStamp<T extends GroupedStamp>(stamps: readonly T[], id: string, everywhere: boolean): T[] {
  const source = stamps.find((s) => s.id === id);
  if (!source) return stamps as T[];
  return stamps.filter((s) => (everywhere ? s.group !== source.group : s.id !== id));
}
