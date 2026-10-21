import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { RotateCcw } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageGrid, { type PageGridSize, type PageGridView } from '@/components/islands/workspace/PageGrid';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePageThumb } from '@/hooks/use-page-thumb';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { openPdf, PdfPasswordError, type PdfDocHandle } from '@/lib/pdf/doc-handle';
import { downloadBlob } from '@/lib/download';
import {
  fileLetter,
  isPlainOrder,
  movePage,
  pagesOfFile,
  parseMergeRange,
  rangeTextFor,
  regroupByFiles,
  removeFile as dropFilePages,
  removePage as dropPage,
  replaceFilePages,
  resetOrder,
  toSegments,
  type MergePage,
} from '@/lib/merge-pages';
import { cn, formatBytes, generateId } from '@/lib/utils';
import type { MergeOptions } from '@/types/worker-messages';
import MergeFileRow, { FileBadge } from './MergeFileRow';

const ACCEPT = ['application/pdf'];
const MAX_FILES = 50;
const OUTPUT_NAME = 'merged.pdf';
/** The shape shown for a page whose size is not known yet. */
const A4_ASPECT = 210 / 297;
/** Thumbnail long edge in device pixels, per grid size; the enlarged view gets more. */
const THUMB_PX: Record<PageGridSize, number> = { s: 320, m: 480, l: 800 };
const LARGE_PX = 1600;
/** How long after the last keystroke a typed password is tried. */
const PASSWORD_TRY_MS = 500;

interface MergeFile {
  id: string;
  file: File;
  /** The file's badge letter, kept for as long as it is in the list. */
  letter: string;
  colour: number;
  status: 'opening' | 'ready' | 'locked' | 'error';
  pageCount: number | null;
  doc: PdfDocHandle | null;
  /** Width ÷ height of each page, once read. */
  aspects: number[] | null;
  password: string;
  /** The password that opened it, sent to the worker with the file. */
  unlockedWith: string | null;
  passwordState: 'idle' | 'checking' | 'wrong';
  rangeText: string;
  rangeError: string | null;
}

interface Result {
  file: File;
  files: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-xs text-[var(--color-text-secondary)]';

/** One page, as a thumbnail from its file's open document. */
function PageThumb({
  doc,
  pageIndex,
  longEdge,
  aspect,
  alt,
}: {
  doc: PdfDocHandle | null;
  pageIndex: number;
  longEdge: number;
  aspect: number;
  alt: string;
}) {
  const src = usePageThumb(doc, pageIndex, longEdge);
  return src ? (
    <img
      src={src}
      alt={alt}
      draggable={false}
      data-testid="merge-page-image"
      className="block w-full select-none bg-white ring-1 ring-black/15"
      style={{ aspectRatio: String(aspect) }}
    />
  ) : (
    <div
      className="flex w-full items-center justify-center bg-white text-xs text-[#52525b] ring-1 ring-black/15"
      style={{ aspectRatio: String(aspect) }}
    >
      Loading…
    </div>
  );
}

/** A card for a file whose pages cannot be shown yet. */
function Placeholder({ status, name }: { status: MergeFile['status']; name: string }) {
  const text =
    status === 'locked'
      ? `${name} is password-protected. Enter its password to see its pages.`
      : status === 'error'
        ? `${name} could not be read as a PDF.`
        : 'Reading…';
  return (
    <div
      data-testid={status === 'locked' ? 'page-locked' : status === 'error' ? 'page-unreadable' : 'page-reading'}
      className={cn(
        'flex w-full items-center justify-center bg-white p-2 text-center text-xs ring-1 ring-black/15',
        status === 'error' ? 'font-medium text-[#b91c1c]' : 'text-[#52525b]',
      )}
      style={{ aspectRatio: String(A4_ASPECT) }}
    >
      {text}
    </div>
  );
}

/** After the merge: the downloaded file itself, read back and shown page by page. */
function ResultPages({ file, size, onSizeChange }: { file: File; size: PageGridSize; onSizeChange: (s: PageGridSize) => void }) {
  const { doc, pageCount, status } = usePdfDocument(file);
  const items = useMemo(() => Array.from({ length: pageCount }, (_, i) => ({ id: `out-${i}`, index: i })), [pageCount]);
  const [aspects, setAspects] = useState<{ doc: PdfDocHandle; values: number[] } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    void Promise.all(
      Array.from({ length: doc.pageCount }, (_, i) =>
        doc.geometry(i).then(
          (g) => g.widthPt / g.heightPt,
          () => A4_ASPECT,
        ),
      ),
    ).then((values) => {
      if (live) setAspects({ doc, values });
    });
    return () => {
      live = false;
    };
  }, [doc]);
  const aspectOf = (i: number) => (aspects && aspects.doc === doc ? (aspects.values[i] ?? A4_ASPECT) : A4_ASPECT);
  if (status !== 'ready') {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
        {status === 'error' ? 'The merged PDF could not be shown.' : 'Reading the merged PDF…'}
      </div>
    );
  }
  return (
    <PageGrid
      items={items}
      getName={() => file.name}
      getAspect={(item) => aspectOf(item.index)}
      renderPage={(item, index, view) => (
        <PageThumb
          doc={doc}
          pageIndex={item.index}
          longEdge={view === 'large' ? LARGE_PX : THUMB_PX[size]}
          aspect={aspectOf(item.index)}
          alt={view === 'large' ? `Page ${index + 1} of the merged PDF` : ''}
        />
      )}
      size={size}
      onSizeChange={onSizeChange}
      caption={`The merged PDF as downloaded · ${plural(pageCount, 'page')}`}
      cardTestId="result-page"
      label="Pages of the merged PDF"
    />
  );
}

export default function MergePdfTool() {
  const [files, setFiles] = useState<MergeFile[]>([]);
  const [pages, setPages] = useState<MergePage[]>([]);
  const [insertBlankPages, setInsertBlankPages] = useState(false);
  const [preserveBookmarks, setPreserveBookmarks] = useState(false);
  const [gridSize, setGridSize] = useState<PageGridSize>('m');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useToolRun<Result>();
  const { invalidate, start } = run;

  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const coarse = useMediaQuery('(pointer: coarse)');

  // Files still in the list, their open documents and pending password tries:
  // read from the asynchronous openers, which outlive the render that started them.
  const alive = useRef(new Set<string>());
  const handles = useRef(new Map<string, PdfDocHandle>());
  const attempts = useRef(new Map<string, number>());
  const passwordTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lettersUsed = useRef(0);

  useEffect(() => {
    const live = alive.current;
    const open = handles.current;
    const timers = passwordTimers.current;
    return () => {
      live.clear();
      for (const doc of open.values()) void doc.destroy();
      open.clear();
      for (const t of timers.values()) clearTimeout(t);
      if (addedTimer.current) clearTimeout(addedTimer.current);
    };
  }, []);

  const patchFile = useCallback((id: string, patch: Partial<MergeFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  /** Open (or try to unlock) a file. Its pages replace its placeholder in the grid. */
  const openFile = useCallback(
    (id: string, file: File, password?: string) => {
      const attempt = (attempts.current.get(id) ?? 0) + 1;
      attempts.current.set(id, attempt);
      openPdf(file, password ? { password } : {}).then(
        (doc) => {
          if (!alive.current.has(id) || attempts.current.get(id) !== attempt) {
            void doc.destroy();
            return;
          }
          handles.current.set(id, doc);
          patchFile(id, {
            status: 'ready',
            doc,
            pageCount: doc.pageCount,
            unlockedWith: password ?? null,
            passwordState: 'idle',
          });
          // Every page, where its placeholder was. Not a change of the visitor's,
          // so a finished result stays valid: "all pages" was what was merged.
          setPages((prev) => replaceFilePages(prev, id, pagesOfFile(id, doc.pageCount, generateId)));
          void Promise.all(
            Array.from({ length: doc.pageCount }, (_, i) =>
              doc.geometry(i).then(
                (g) => g.widthPt / g.heightPt,
                () => A4_ASPECT,
              ),
            ),
          ).then((aspects) => {
            if (alive.current.has(id)) patchFile(id, { aspects });
          });
        },
        (err: unknown) => {
          if (!alive.current.has(id) || attempts.current.get(id) !== attempt) return;
          if (err instanceof PdfPasswordError) {
            patchFile(id, { status: 'locked', passwordState: password ? 'wrong' : 'idle' });
          } else {
            patchFile(id, { status: 'error' });
          }
        },
      );
    },
    [patchFile],
  );

  const addFiles = useCallback(
    (incoming: File[]) => {
      const room = MAX_FILES - alive.current.size;
      const accepted = incoming.slice(0, Math.max(0, room));
      if (accepted.length === 0) return;
      if (alive.current.size === 0) {
        lettersUsed.current = 0;
        // Start at the largest size at which a page fits the pane comfortably.
        setGridSize(window.matchMedia('(min-width: 1536px)').matches ? 'm' : 's');
      }
      const batch: MergeFile[] = accepted.map((file) => {
        const n = lettersUsed.current++;
        return {
          id: generateId(),
          file,
          letter: fileLetter(n),
          colour: n,
          status: 'opening',
          pageCount: null,
          doc: null,
          aspects: null,
          password: '',
          unlockedWith: null,
          passwordState: 'idle',
          rangeText: '',
          rangeError: null,
        };
      });
      for (const f of batch) alive.current.add(f.id);
      invalidate();
      setFiles((prev) => [...prev, ...batch]);
      setPages((prev) => [...prev, ...batch.flatMap((f) => pagesOfFile(f.id, null, generateId))]);

      setJustAdded(true);
      if (addedTimer.current) clearTimeout(addedTimer.current);
      addedTimer.current = setTimeout(() => setJustAdded(false), 1500);

      for (const f of batch) openFile(f.id, f.file);
    },
    [invalidate, openFile],
  );

  const forget = useCallback((id: string) => {
    alive.current.delete(id);
    const doc = handles.current.get(id);
    if (doc) void doc.destroy();
    handles.current.delete(id);
    const timer = passwordTimers.current.get(id);
    if (timer) clearTimeout(timer);
    passwordTimers.current.delete(id);
  }, []);

  const removeFile = useCallback(
    (id: string) => {
      invalidate();
      forget(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      setPages((prev) => dropFilePages(prev, id));
    },
    [invalidate, forget],
  );

  const removeAll = useCallback(() => {
    invalidate();
    for (const id of [...alive.current]) forget(id);
    setFiles([]);
    setPages([]);
    setOptionsOpen(false);
  }, [invalidate, forget]);

  /** × on a page: leave it out, and say so in its file's range. The last page takes the file with it. */
  const removePage = useCallback(
    (pageId: string) => {
      const page = pages.find((p) => p.id === pageId);
      if (!page) return;
      const next = dropPage(pages, pageId);
      if (!next.some((p) => p.fileId === page.fileId)) {
        removeFile(page.fileId);
        return;
      }
      invalidate();
      setPages(next);
      patchFile(page.fileId, { rangeText: rangeTextFor(next, page.fileId), rangeError: null });
    },
    [pages, invalidate, removeFile, patchFile],
  );

  const reorderPages = useCallback(
    (fromId: string, toId: string) => {
      invalidate();
      setPages((prev) => movePage(prev, fromId, toId));
    },
    [invalidate],
  );

  const reorderFiles = useCallback(
    (fromId: string, toId: string) => {
      const from = files.findIndex((f) => f.id === fromId);
      const to = files.findIndex((f) => f.id === toId);
      if (from === -1 || to === -1 || from === to) return;
      invalidate();
      const next = arrayMove(files, from, to);
      setFiles(next);
      setPages((prev) => regroupByFiles(prev, next.map((f) => f.id)));
    },
    [files, invalidate],
  );

  const fileOrder = useMemo(() => files.map((f) => f.id), [files]);
  const resetPageOrder = useCallback(() => {
    invalidate();
    setPages((prev) => resetOrder(prev, fileOrder));
  }, [fileOrder, invalidate]);

  /** A typed range: replace the file's pages in the grid, or say why it cannot. */
  const changeRange = useCallback(
    (id: string, text: string) => {
      const f = files.find((x) => x.id === id);
      if (!f || f.status !== 'ready' || f.pageCount === null) return;
      const parsed = parseMergeRange(text, f.pageCount);
      if (!parsed.ok) {
        patchFile(id, { rangeText: text, rangeError: parsed.error });
        return;
      }
      invalidate();
      patchFile(id, { rangeText: text, rangeError: null });
      setPages((prev) => {
        // Pages already in the grid keep their ids, so their cards stay put.
        const existing = new Map(prev.filter((p) => p.fileId === id).map((p) => [p.pageIndex, p.id]));
        const chosen = parsed.pages.map((pageIndex) => ({ id: existing.get(pageIndex) ?? generateId(), fileId: id, pageIndex }));
        return replaceFilePages(prev, id, chosen);
      });
    },
    [files, invalidate, patchFile],
  );

  const unlock = useCallback(
    (id: string) => {
      const timer = passwordTimers.current.get(id);
      if (timer) clearTimeout(timer);
      passwordTimers.current.delete(id);
      const f = files.find((x) => x.id === id);
      if (!f || f.status !== 'locked' || !f.password.trim()) return;
      patchFile(id, { passwordState: 'checking' });
      openFile(id, f.file, f.password.trim());
    },
    [files, openFile, patchFile],
  );

  const changePassword = useCallback(
    (id: string, password: string) => {
      invalidate();
      patchFile(id, { password, passwordState: 'idle' });
      const timer = passwordTimers.current.get(id);
      if (timer) clearTimeout(timer);
      const f = files.find((x) => x.id === id);
      if (!f || !password.trim()) return;
      // Try it once typing pauses, so the pages appear without another click.
      passwordTimers.current.set(
        id,
        setTimeout(() => {
          passwordTimers.current.delete(id);
          patchFile(id, { passwordState: 'checking' });
          openFile(id, f.file, password.trim());
        }, PASSWORD_TRY_MS),
      );
    },
    [files, invalidate, openFile, patchFile],
  );

  /* ── The merge ────────────────────────────────────────────────────────── */

  const merge = useCallback(() => {
    if (files.length < 2 || pages.length === 0) return;
    const counts = new Map(files.map((f) => [f.id, f.status === 'ready' ? f.pageCount : null]));
    // Whole files in order go as a plain merge; anything else says exactly which
    // page goes where.
    const segments = isPlainOrder(pages, fileOrder, counts) ? undefined : toSegments(pages, fileOrder);
    const sent = files;
    const options: MergeOptions = {
      ...(segments ? { segments } : {}),
      insertBlankPages,
      preserveBookmarks,
      passwords: sent.map((f) => f.unlockedWith ?? (f.password.trim() || null)),
      fileNames: sent.map((f) => f.file.name),
    };
    void start(async (work) => {
      const buffers = await Promise.all(sent.map((f) => f.file.arrayBuffer()));
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work('pdf', { op: 'merge', buffers, options, progressPort: port2 }, [...buffers, port2]);
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message);
        if (response.status !== 'success') throw new Error('The PDFs could not be merged.');
        return { file: new File([response.result], OUTPUT_NAME, { type: 'application/pdf' }), files: sent.length };
      } finally {
        port1.close();
      }
    });
  }, [files, pages, fileOrder, insertBlankPages, preserveBookmarks, start]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result.file, run.result.file.name);
  }, [run.result]);

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const opening = files.filter((f) => f.status === 'opening');
  const unreadable = files.filter((f) => f.status === 'error');
  const lockedEmpty = files.filter((f) => f.status === 'locked' && !f.password.trim());
  const badRange = files.find((f) => f.rangeError);
  const unknownPages = pages.some((p) => p.pageIndex === null);
  const fileChanges = pages.reduce((n, p, i) => (i > 0 && pages[i - 1].fileId !== p.fileId ? n + 1 : n), 0);
  const blanks = insertBlankPages ? fileChanges : 0;
  const outputPages = pages.length + blanks;
  const busy = run.phase === 'running';
  const done = run.phase === 'done';
  const plainNow = isPlainOrder(
    pages,
    fileOrder,
    new Map(files.map((f) => [f.id, f.status === 'ready' ? f.pageCount : null])),
  );
  const sortedNow = useMemo(() => {
    const reset = resetOrder(pages, fileOrder);
    return reset.every((p, i) => p.id === pages[i]?.id);
  }, [pages, fileOrder]);

  const closed = phone && !optionsOpen;
  const beside = closed ? 'in Options' : wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (busy) {
    prompt = 'Merging your PDFs…';
  } else if (done) {
    prompt = 'Your merged PDF is ready. These are its pages. Download it, or make changes.';
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The PDFs could not be merged. The reason is shown above the Merge button; fix it and try again.';
    promptTone = 'error';
  } else if (opening.length > 0) {
    prompt = `Reading your ${files.length === 1 ? 'PDF' : 'PDFs'}…`;
  } else if (unreadable.length > 0) {
    prompt = `${unreadable[0].file.name} could not be read as a PDF. Remove it to continue.`;
    promptTone = 'error';
  } else if (badRange) {
    prompt = `The page range for ${badRange.file.name} cannot be read. Fix it ${beside}; the pages shown have not changed.`;
    promptTone = 'error';
  } else if (lockedEmpty.length > 0) {
    prompt = `${lockedEmpty[0].file.name} is password-protected. Enter its password ${beside} to see its pages.`;
  } else if (files.length === 1) {
    prompt = 'Add another PDF to merge it with this one.';
  } else if (pages.length < 2) {
    prompt = 'This is the only page of your merged PDF. Press Merge to create it.';
  } else {
    const drag = coarse ? 'Drag pages by their handle to change their order' : 'Drag pages to change their order';
    prompt = `These ${outputPages} pages are your merged PDF, in order. ${drag}, then press Merge.`;
  }

  const disabledReason =
    files.length < 2
      ? 'Add at least 2 PDFs to merge'
      : opening.length > 0
        ? `Reading your PDFs…`
        : unreadable.length > 0
          ? `Remove ${unreadable[0].file.name}: it could not be read as a PDF`
          : badRange
            ? `Fix the page range for ${badRange.file.name}`
            : lockedEmpty.length > 0
              ? `Enter the password for ${lockedEmpty[0].file.name}`
              : null;

  const summary = run.result
    ? `${run.result.file.name} · ${formatBytes(run.result.file.size)}${unknownPages ? '' : ` · ${plural(outputPages, 'page')}`}`
    : undefined;

  /* ── Document pane ────────────────────────────────────────────────────── */

  const labelOf = (page: MergePage) => {
    const f = byId.get(page.fileId);
    if (!f) return 'page';
    return page.pageIndex === null ? `${f.letter} · all pages (${f.file.name})` : `${f.letter} · page ${page.pageIndex + 1} (${f.file.name})`;
  };

  const renderPage = (page: MergePage, index: number, view: PageGridView) => {
    const f = byId.get(page.fileId);
    if (!f) return null;
    if (page.pageIndex === null || f.status !== 'ready') return <Placeholder status={f.status} name={f.file.name} />;
    return (
      <PageThumb
        doc={f.doc}
        pageIndex={page.pageIndex}
        longEdge={view === 'large' ? LARGE_PX : THUMB_PX[gridSize]}
        aspect={f.aspects?.[page.pageIndex] ?? A4_ASPECT}
        alt={view === 'large' ? `Page ${index + 1} of the merged PDF: ${labelOf(page)}` : ''}
      />
    );
  };

  const caption =
    pages.length === 0
      ? ''
      : `${plainNow ? 'Files in order' : 'Your order'} · ${unknownPages ? 'pages of locked files appear once unlocked' : plural(pages.length, 'page')}${
          blanks > 0 ? ` + ${plural(blanks, 'blank page')}` : ''
        }`;

  const stage =
    done && run.result ? (
      <ResultPages file={run.result.file} size={gridSize} onSizeChange={setGridSize} />
    ) : (
      <PageGrid
        items={pages}
        getName={(page) => byId.get(page.fileId)?.file.name ?? ''}
        getItemLabel={(page) => labelOf(page)}
        getAspect={(page) => {
          const f = byId.get(page.fileId);
          return page.pageIndex === null ? A4_ASPECT : (f?.aspects?.[page.pageIndex] ?? A4_ASPECT);
        }}
        renderPage={renderPage}
        getDetail={(page) => {
          const f = byId.get(page.fileId);
          if (!f) return '';
          return page.pageIndex === null ? `${f.letter} · all pages` : `${f.letter} · page ${page.pageIndex + 1}`;
        }}
        renderBadge={(page) => {
          const f = byId.get(page.fileId);
          return f ? <FileBadge letter={f.letter} colour={f.colour} className="h-5 min-w-5 px-1 text-[11px]" /> : null;
        }}
        removeVerb="Leave out"
        cardTestId="merge-page"
        size={gridSize}
        onSizeChange={setGridSize}
        caption={caption}
        toolbarExtra={
          <button
            type="button"
            onClick={resetPageOrder}
            disabled={busy || sortedNow}
            data-testid="reset-order"
            title="Files in their order, each file's pages in page order"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            <span className="max-sm:sr-only">Reset order</span>
          </button>
        }
        onReorder={reorderPages}
        onRemove={removePage}
        disabled={busy}
        label="Pages in the merged PDF, in order"
      />
    );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onFileDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) reorderFiles(String(active.id), String(over.id));
  };
  const fileName = (id: string | number) => {
    const f = byId.get(String(id));
    return f ? `${f.letter}: ${f.file.name}` : 'file';
  };
  const filePosition = (id: string | number) => fileOrder.indexOf(String(id)) + 1;
  type Ids = { active: { id: string | number }; over: { id: string | number } | null };
  const announcements = {
    onDragStart: ({ active }: Pick<Ids, 'active'>) =>
      `Picked up ${fileName(active.id)}. File ${filePosition(active.id)} of ${files.length}.`,
    onDragOver: ({ active, over }: Ids) =>
      over ? `${fileName(active.id)} moved to file ${filePosition(over.id)} of ${files.length}.` : undefined,
    onDragEnd: ({ active, over }: Ids) =>
      over
        ? `${fileName(active.id)} dropped at file ${filePosition(over.id)} of ${files.length}. Its pages now follow that order.`
        : `${fileName(active.id)} dropped.`,
    onDragCancel: ({ active }: Pick<Ids, 'active'>) => `Reordering cancelled. ${fileName(active.id)} returned to its place.`,
  };

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4">
      <section className="flex flex-col gap-2" aria-labelledby="merge-files">
        <h3 id="merge-files" className={heading}>
          Files
        </h3>
        <p className={note}>
          The letter on each page says which file it comes from. Drag a file by its handle to move all its pages; type
          pages to choose which go in.
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onFileDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                'To move this file, press Space or Enter to pick it up, use the arrow keys to move it, and press Space or Enter again to drop it. Press Escape to cancel.',
            },
          }}
        >
          <SortableContext items={fileOrder} strategy={verticalListSortingStrategy}>
            <ul role="list" aria-label="Files to merge, in order" className="flex flex-col gap-2" data-testid="merge-files">
              {files.map((f) => (
                <MergeFileRow
                  key={f.id}
                  id={f.id}
                  name={f.file.name}
                  size={f.file.size}
                  letter={f.letter}
                  colour={f.colour}
                  status={f.status}
                  pageCount={f.pageCount}
                  chosen={pages.filter((p) => p.fileId === f.id).length}
                  rangeText={f.rangeText}
                  rangeError={f.rangeError}
                  onRangeChange={(text) => changeRange(f.id, text)}
                  password={f.password}
                  passwordState={f.passwordState}
                  onPasswordChange={(pw) => changePassword(f.id, pw)}
                  onUnlock={() => unlock(f.id)}
                  onRemove={() => removeFile(f.id)}
                  sortable={files.length > 1}
                  disabled={busy}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <DropZone
          accept={ACCEPT}
          multiple
          maxFiles={MAX_FILES}
          onFiles={addFiles}
          hint="PDF files only · Up to 50 files"
          compact
          compactLabel="Add PDFs"
          showAccepted={justAdded}
        />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="merge-options-title" data-testid="merge-options">
        <h3 id="merge-options-title" className={heading}>
          Options
        </h3>
        <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={insertBlankPages}
            onChange={(e) => {
              invalidate();
              setInsertBlankPages(e.target.checked);
            }}
            disabled={busy}
            data-testid="insert-blank-pages"
            className="mt-0.5"
          />
          <span>
            Insert a blank page between documents
            <span className="block text-xs text-[var(--color-text-muted)]">
              Wherever the pages switch from one file to another. Useful when the result will be printed double-sided.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={preserveBookmarks}
            onChange={(e) => {
              invalidate();
              setPreserveBookmarks(e.target.checked);
            }}
            disabled={busy}
            data-testid="preserve-bookmarks"
            className="mt-0.5"
          />
          <span>
            Preserve bookmarks &amp; internal links
            <span className="block text-xs text-[var(--color-text-muted)]">
              Keeps each document&rsquo;s outline and in-document links, pointing at the pages&rsquo; new places.
              Loads a larger engine, so the merge takes longer.
            </span>
          </span>
        </label>
      </section>
    </div>
  );

  const result =
    done && run.result ? (
      <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
        <h3 className={heading}>Merge complete</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {formatBytes(run.result.file.size)} · merged from {run.result.files} files. The pages shown are read back from
          the merged file itself.
        </p>
        <NextStep href="/compress-pdf/" label="Compress PDF">
          Large merged file? Shrink it with
        </NextStep>
        <p className={note}>Something not right? Make changes takes you back to the pages and files.</p>
      </div>
    ) : undefined;

  return (
    <ToolWorkspace
      toolId="merge-pdf"
      active={files.length > 0}
      empty={
        <DropZone
          accept={ACCEPT}
          multiple
          maxFiles={MAX_FILES}
          onFiles={addFiles}
          hint="PDF files only · Up to 50 files · Every page shown, in order"
        />
      }
      title="Merge PDFs"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        <WorkspaceFileBar
          files={files.map((f) => f.file)}
          noun="PDF"
          onAdd={addFiles}
          onRemove={removeAll}
          accept={ACCEPT}
          extra={unknownPages ? undefined : plural(pages.length, 'page')}
          disabled={busy}
        />
      }
      stage={stage}
      controls={controls}
      result={result}
      action={
        <ActionBar
          phase={run.phase}
          label={
            unknownPages
              ? 'Merge into 1 PDF'
              : phone
                ? `Merge (${plural(outputPages, 'page')})`
                : `Merge into 1 PDF (${plural(outputPages, 'page')})`
          }
          runningLabel="Merging…"
          onRun={merge}
          disabledReason={disabledReason}
          hint="The pages go into one PDF in the order shown."
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download PDF: ${OUTPUT_NAME}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
