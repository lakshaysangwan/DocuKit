/**
 * Delivering several output files without forcing a ZIP.
 *
 * A tool that produces N files has four ways to hand them over, none of which
 * works everywhere, so the shared MultiFileDownload component offers whichever
 * of them the browser supports and keeps the ZIP one click away:
 *
 *   1. N separate downloads from one click  (every browser, with limits below)
 *   2. one ZIP                               (every browser)
 *   3. write into a folder the visitor picks (File System Access — Chromium desktop)
 *   4. the system share sheet                (Web Share with files — phones, some desktops)
 *
 * Limits of (1), measured with Playwright against the production build
 * (sequential `a[download]` clicks on blob: URLs from one click handler):
 *
 *   gap between clicks   Chromium          Firefox   WebKit
 *   0 ms                 10 of 12, 10 of 40  40 of 40  1 of 3, 1 of 10, 1 of 40
 *   30 ms                18 of 40            —         40 of 40
 *   150 ms               40 of 40            40 of 40  40 of 40
 *   300 ms               40 of 40            —         40 of 40
 *
 * So a gap is not optional: with none, WebKit keeps only the first file and
 * Chromium stops at ten. What automation cannot show is the permission layer on
 * top — Chrome asks once per site before the second automatic download ("this
 * site wants to download multiple files"), and Safari asks whether to allow
 * downloads from the site at all. Both are the visitor's call, and a page gets
 * no signal either way: `a[download]` reports nothing back. The UI therefore
 * says how many downloads it *started*, never how many arrived.
 */

/**
 * Most files handed over as separate downloads; above this the ZIP is the
 * primary action. Ten is the largest burst Chromium let through even with no
 * gap at all, so this many still arrive if a throttled background tab stretches
 * or collapses the timers — and it keeps the whole run (10 × 300 ms) inside the
 * few seconds a click's user activation lasts.
 */
export const DIRECT_DOWNLOAD_LIMIT = 10;

/** Twice the smallest gap that delivered 40 of 40 on all three engines. */
export const DOWNLOAD_GAP_MS = 300;

export interface OutputFile {
  name: string;
  blob: Blob;
}

/** `report.PDF` -> `report`. Only a trailing .pdf is removed. */
export function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '');
}

/**
 * Name for the image of one PDF page: `<base>-page-<n>.<ext>`.
 *
 * `pageNumber` is the 1-based page in the *source* document, not the position
 * in the selection — exporting pages 1, 3 and 5 gives -page-1, -page-3, -page-5.
 * The number is zero-padded to the width of the document's page count so the
 * files sort in page order in a folder listing (page-02 before page-10).
 */
export function pageFileName(base: string, pageNumber: number, pageCount: number, ext: string): string {
  const width = String(Math.max(pageCount, pageNumber, 1)).length;
  return `${base}-page-${String(pageNumber).padStart(width, '0')}.${ext}`;
}

/** Start one browser download for a blob. */
export function startDownload(file: OutputFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a delay so the download has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start one download per file, `gapMs` apart. Resolves with how many were
 * *started* — whether the browser kept them all is not observable from a page.
 */
export async function startDownloads(
  files: OutputFile[],
  onProgress?: (started: number) => void,
  gapMs = DOWNLOAD_GAP_MS,
): Promise<number> {
  let started = 0;
  for (const file of files) {
    if (started > 0) await wait(gapMs);
    startDownload(file);
    started++;
    onProgress?.(started);
  }
  return started;
}

// ── Save to a folder (File System Access API) ─────────────────────────────

interface WritableLike { write(data: Blob): Promise<void>; close(): Promise<void> }
interface FileHandleLike { createWritable(): Promise<WritableLike> }
interface DirectoryHandleLike {
  name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandleLike>;
}
type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: string }) => Promise<DirectoryHandleLike>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return typeof picker === 'function' ? (picker as DirectoryPicker).bind(window) : null;
}

export function canSaveToFolder(): boolean {
  return directoryPicker() !== null;
}

export type FolderSaveResult =
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'saved'; folderName: string; saved: number; failed: string[] };

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

/**
 * Ask for a folder and write every file into it. A file whose write fails is
 * reported by name rather than aborting the rest, so the result is an exact
 * count — unlike plain downloads, this path does know what landed.
 */
export async function saveToFolder(
  files: OutputFile[],
  onProgress?: (done: number, folderName: string) => void,
  startIn?: string,
): Promise<FolderSaveResult> {
  const pick = directoryPicker();
  if (!pick) return { status: 'unavailable' };

  let dir: DirectoryHandleLike;
  try {
    dir = await pick({ mode: 'readwrite', id: 'docukit-output', ...(startIn ? { startIn } : {}) });
  } catch (err) {
    // AbortError is the visitor closing the picker; anything else (a blocked
    // folder, a denied permission) means this route is not available right now.
    return isAbort(err) ? { status: 'cancelled' } : { status: 'unavailable' };
  }

  let saved = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      const handle = await dir.getFileHandle(file.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file.blob);
      await writable.close();
      saved++;
    } catch {
      failed.push(file.name);
    }
    onProgress?.(saved + failed.length, dir.name);
  }
  return { status: 'saved', folderName: dir.name, saved, failed };
}

// ── Share sheet (Web Share API with files) ────────────────────────────────

function toShareFiles(files: OutputFile[]): File[] {
  return files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
}

/** True only when the browser says it can share exactly these files. */
export function canShareFiles(files: OutputFile[]): boolean {
  if (typeof navigator === 'undefined' || files.length === 0) return false;
  if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
  try {
    return navigator.canShare({ files: toShareFiles(files) });
  } catch {
    return false;
  }
}

export type ShareResult = 'shared' | 'cancelled' | 'failed';

/**
 * Open the system share sheet with the files. "shared" means the sheet was
 * completed — what the chosen app then did with the files is not reported.
 */
export async function shareFiles(files: OutputFile[]): Promise<ShareResult> {
  try {
    await navigator.share({ files: toShareFiles(files) });
    return 'shared';
  } catch (err) {
    return isAbort(err) ? 'cancelled' : 'failed';
  }
}
