/**
 * The page list behind Rearrange / Rotate PDF Pages, and every change a visitor
 * can make to it. Pure functions: the tool keeps the list in `useHistory`, so
 * each of these is one undoable step, and the job sent to the worker is derived
 * from the same list the grid draws (`toReorderOptions`) — what is shown is
 * what is written.
 */

export type QuarterTurn = 0 | 90 | 180 | 270;

/** `source` for a page that is not in the original file. */
export const BLANK = -1;

export interface OrganizePage {
  /** Stable for the life of the card: duplicates and blanks get their own. */
  id: string;
  /** 0-based page of the original file, or `BLANK`. */
  source: number;
  /** Clockwise turn the visitor added, on top of the page's own `/Rotate`. */
  turn: QuarterTurn;
}

export type TurnDirection = 'left' | 'right';

/** Any multiple of 90 (negative too) as 0 | 90 | 180 | 270. */
export function normaliseTurn(degrees: number): QuarterTurn {
  return ((((Math.round(degrees / 90) * 90) % 360) + 360) % 360) as QuarterTurn;
}

/** Every page of a file of `count` pages, in order, unturned. */
export function initialPages(count: number, newId: () => string): OrganizePage[] {
  return Array.from({ length: count }, (_, i) => ({ id: newId(), source: i, turn: 0 as QuarterTurn }));
}

/** Move the page `fromId` to where `toId` is (dnd-kit's arrayMove semantics). */
export function movePage(pages: OrganizePage[], fromId: string, toId: string): OrganizePage[] {
  const from = pages.findIndex((p) => p.id === fromId);
  const to = pages.findIndex((p) => p.id === toId);
  if (from === -1 || to === -1 || from === to) return pages;
  const next = pages.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Turn the pages in `ids` a quarter turn left (anticlockwise) or right (clockwise). */
export function rotatePages(pages: OrganizePage[], ids: ReadonlySet<string>, direction: TurnDirection): OrganizePage[] {
  if (ids.size === 0) return pages;
  const delta = direction === 'right' ? 90 : -90;
  return pages.map((p) => (ids.has(p.id) ? { ...p, turn: normaliseTurn(p.turn + delta) } : p));
}

/** Take the pages in `ids` out. */
export function removePages(pages: OrganizePage[], ids: ReadonlySet<string>): OrganizePage[] {
  if (ids.size === 0) return pages;
  return pages.filter((p) => !ids.has(p.id));
}

/** Put a copy of `id` (same page, same turn, its own id) right after it. */
export function duplicatePage(pages: OrganizePage[], id: string, newId: string): OrganizePage[] {
  const i = pages.findIndex((p) => p.id === id);
  if (i === -1) return pages;
  return [...pages.slice(0, i + 1), { ...pages[i], id: newId }, ...pages.slice(i + 1)];
}

/** Insert a blank page so that it becomes page `position` (0-based), clamped to the list. */
export function insertBlank(pages: OrganizePage[], position: number, newId: string): OrganizePage[] {
  const at = Math.max(0, Math.min(pages.length, position));
  return [...pages.slice(0, at), { id: newId, source: BLANK, turn: 0 }, ...pages.slice(at)];
}

/**
 * Where "Add blank page" puts the new page: right after the last selected page
 * in the current order, or at the end when nothing is selected.
 */
export function blankInsertPosition(pages: OrganizePage[], selected: ReadonlySet<string>): number {
  let last = -1;
  pages.forEach((p, i) => {
    if (selected.has(p.id)) last = i;
  });
  return last === -1 ? pages.length : last + 1;
}

/**
 * Shift-click: every page from the anchor to `id`, inclusive, added to the
 * selection. Without a usable anchor it just adds `id`.
 */
export function selectRange(
  pages: OrganizePage[],
  selected: ReadonlySet<string>,
  anchorId: string | null,
  id: string,
): Set<string> {
  const next = new Set(selected);
  const a = anchorId === null ? -1 : pages.findIndex((p) => p.id === anchorId);
  const b = pages.findIndex((p) => p.id === id);
  if (b === -1) return next;
  if (a === -1) {
    next.add(id);
    return next;
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) next.add(pages[i].id);
  return next;
}

/** Add or take out one page. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selection with any page that no longer exists dropped. */
export function pruneSelection(pages: OrganizePage[], selected: ReadonlySet<string>): Set<string> {
  const ids = new Set(pages.map((p) => p.id));
  return new Set([...selected].filter((id) => ids.has(id)));
}

/** True when the list is the original file as it was: every page once, in order, unturned. */
export function isUnchanged(pages: OrganizePage[], count: number): boolean {
  return pages.length === count && pages.every((p, i) => p.source === i && p.turn === 0);
}

/** The worker's job: positional source indices (`BLANK` for a blank) and turns. */
export function toReorderOptions(pages: OrganizePage[]): { order: number[]; rotations: QuarterTurn[] } {
  return { order: pages.map((p) => p.source), rotations: pages.map((p) => p.turn) };
}

/**
 * Which original page a blank page at `index` copies its size from: the
 * nearest real page before it in the new order, or the original's first page
 * when there is none. The writer (`organize-write.ts`) uses the same rule.
 */
export function blankSizeSource(pages: OrganizePage[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (pages[i].source !== BLANK) return pages[i].source;
  return 0;
}

/**
 * Width ÷ height of a page as it will appear: `baseAspect` is the page as the
 * original file shows it (its own `/Rotate` applied); a quarter turn swaps it.
 */
export function turnedAspect(baseAspect: number, turn: QuarterTurn): number {
  return turn === 90 || turn === 270 ? 1 / baseAspect : baseAspect;
}
