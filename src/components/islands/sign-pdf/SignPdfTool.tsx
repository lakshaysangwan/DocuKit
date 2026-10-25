import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, CopyPlus, Minus, Plus, Redo2, Trash2, Undo2, Unlink } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer, { type PageFrame } from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { OverlayBox, OverlayLayer, type OverlayChangePhase } from '@/components/islands/workspace/OverlayLayer';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useHistory } from '@/hooks/use-history';
import { useMediaQuery } from '@/hooks/use-media-query';
import { viewRectToPdfDraw, type PageGeometry, type RectNorm } from '@/lib/pdf/page-geometry';
import { centreRectAt, moveRect, scaleRect } from '@/lib/workspace/overlay-math';
import {
  applyMm,
  defaultStampRect,
  rectToMm,
  reshapeRect,
  type RectMm,
  type StampKind,
} from '@/lib/sign/placement';
import { DATE_BOX_HEIGHT_EM, HELVETICA_ASCENT, dateBoxAspect, dateStampText, dateTextDraw, helveticaWidthEm } from '@/lib/sign/date-text';
import {
  groupPages,
  moveLinked,
  removeStamp as removeFromStamps,
  setGroupPages,
  unlinkStamp,
} from '@/lib/sign/stamp-groups';
import { formatPageRange, parsePageRange } from '@/lib/pdf-page-range';
import { downloadBlob } from '@/lib/download';
import { notifyPdfLoadError } from '@/lib/notify';
import { cn, formatBytes, generateId } from '@/lib/utils';
import type { VisualAnnotation } from '@/types/worker-messages';
import SignatureCreator, { type SignatureMode } from './SignatureCreator';
import {
  deriveInitials,
  forgetSignature,
  loadSavedSignature,
  saveSignature,
  signatureFromText,
  type SigAsset,
} from './signature-image';

/**
 * Sign PDF, in the shared workspace.
 *
 * The visitor drops the PDF first. The page is shown large with the signature
 * maker beside it; "Use this signature" puts the signature on the page at once,
 * selected, to be dragged, resized from its corners, copied to every page or
 * removed. The box on screen is the box in the file: a stamp is stored as a
 * fraction of the displayed page and goes through `viewRectToPdfDraw` when the
 * file is written, so it lands in the same place on rotated and cropped pages.
 */

interface Stamp {
  id: string;
  kind: StampKind;
  pageIndex: number;
  /** Where it is, as fractions of the displayed page. */
  rect: RectNorm;
  /**
   * Copies on other pages share a group: they are linked, so moving or
   * resizing one moves and resizes them all (see `stamp-groups.ts`).
   */
  group: string;
  /** Not moved yet: a click on the page moves it there. */
  pristine: boolean;
  /** Date stamps carry their text; signatures and initials show an asset. */
  text?: string;
}

/**
 * Everything undo and redo cover. Stamps do not hold an image: they show the
 * current signature (or initials) asset, so redrawing it updates every stamp.
 */
interface SignState {
  stamps: Stamp[];
  signature: SigAsset | null;
  initials: SigAsset | null;
}

const EMPTY: SignState = { stamps: [], signature: null, initials: null };

const KIND_LABEL: Record<StampKind, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date',
};

/** "Put this signature on…" */
const THIS_KIND: Record<StampKind, string> = {
  signature: 'this signature',
  initials: 'these initials',
  date: 'this date',
};

type Scope = 'this' | 'all' | 'choose';

const ACCEPT = ['application/pdf'];
/** "Smaller" / "Larger" change the size by this much per press. */
const SIZE_STEP = 1.1;
/** A duplicate is offset by this fraction of the page so it does not hide the original. */
const DUPLICATE_OFFSET = 0.03;
const MAX_INITIALS = 4;

const outlineButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

const toolbarButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

const barButton =
  'inline-flex h-11 min-w-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 text-[10px] font-medium leading-none text-[var(--color-text-primary)] hover:bg-[var(--color-background)] sm:h-9 sm:flex-row sm:gap-1.5 sm:border sm:border-[var(--color-border)] sm:px-2.5 sm:text-xs';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A date stamp, drawn so its width is Helvetica's whatever font the browser has. */
function DateStamp({ text }: { text: string }) {
  const width = helveticaWidthEm(text) * 1000;
  return (
    <svg
      viewBox={`0 0 ${width} ${DATE_BOX_HEIGHT_EM * 1000}`}
      preserveAspectRatio="none"
      className="pointer-events-none block size-full"
      aria-hidden="true"
    >
      <text
        x="0"
        y={HELVETICA_ASCENT}
        fontSize="1000"
        fontFamily="Helvetica, Arial, sans-serif"
        textLength={width}
        lengthAdjust="spacingAndGlyphs"
        fill="#000000"
      >
        {text}
      </text>
    </svg>
  );
}

interface NumberFieldProps {
  label: string;
  testId: string;
  value: number | null;
  onCommit: (value: number) => void;
}

/** A millimetre field. Shows what is typed while typing, the real value otherwise. */
function NumberField({ label, testId, value, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = draft ?? (value === null ? '' : String(Math.round(value * 10) / 10));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-[var(--color-text-secondary)]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="1"
        min="0"
        value={shown}
        disabled={value === null}
        data-testid={testId}
        onFocus={() => setDraft(shown)}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = Number.parseFloat(e.target.value);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm tabular-nums text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50"
      />
    </div>
  );
}

interface PageRangeFieldProps {
  /** Zero-based pages the stamp is on now. */
  pages: number[];
  total: number;
  onApply: (pages: number[]) => void;
}

/**
 * "1-3, 5, odd, last": applied on Enter or when the field is left, so the
 * pages do not change at every keystroke. Shows the pages the stamp is on
 * otherwise, so the checkboxes and the field always agree.
 */
function PageRangeField({ pages, total, onApply }: PageRangeFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  const shown = draft ?? formatPageRange(pages);
  const apply = () => {
    if (draft === null) return;
    const parsed = parsePageRange(draft, total);
    if (parsed.length === 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    onApply(parsed);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-[var(--color-text-secondary)]">
        Pages (for example 1-3, 5, odd, even, last)
      </label>
      <input
        id={id}
        type="text"
        value={shown}
        data-testid="scope-pages"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape' && draft !== null) {
            e.preventDefault();
            setDraft(null);
            setInvalid(false);
          }
        }}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
      />
      {invalid && (
        <p id={`${id}-error`} data-testid="scope-pages-error" className="text-xs font-medium text-[var(--color-error)]">
          No page of 1 to {total} matches that. Type page numbers, ranges like 2-4, odd, even or last.
        </p>
      )}
    </div>
  );
}

export default function SignPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const history = useHistory<SignState>(EMPTY);
  const state = history.value;

  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatorOpen, setCreatorOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [signatureMode, setSignatureMode] = useState<SignatureMode>('draw');
  // An uploaded picture is on show in the Upload tab, waiting to be checked.
  const [uploadReview, setUploadReview] = useState(false);
  const [typedText, setTypedText] = useState('');
  const [fontIndex, setFontIndex] = useState(0);
  const [initialsText, setInitialsText] = useState('');
  const [initialsMissing, setInitialsMissing] = useState(false);
  const [saved, setSaved] = useState<SigAsset | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [compare, setCompare] = useState<'after' | 'before'>('after');
  const [pageGeom, setPageGeom] = useState<{ doc: unknown; pageIndex: number; geom: PageGeometry } | null>(null);
  const initialsRef = useRef<HTMLInputElement>(null);
  // The group the "Put this signature on" choice is about when nothing is selected.
  const [focusGroup, setFocusGroup] = useState<string | null>(null);
  // "Choose pages" was picked for this group (it stays picked even on one page).
  const [choosingGroup, setChoosingGroup] = useState<string | null>(null);
  // Remove was pressed on a stamp that has linked copies: this page or all?
  const [removeAsk, setRemoveAsk] = useState<string | null>(null);
  const removeAskRef = useRef<HTMLButtonElement>(null);
  // Page sizes already read, so linked copies can follow a drag as it happens.
  const geomCache = useRef<{ doc: unknown; map: Map<number, PageGeometry> }>({ doc: null, map: new Map() });

  const run = useToolRun<File>();
  const output = usePdfDocument(run.result);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const coarse = useMediaQuery('(pointer: coarse)');

  const active = !!file;
  const editing = run.phase === 'ready' || run.phase === 'error';
  const stamps = state.stamps;
  const selected = stamps.find((s) => s.id === selectedId && s.pageIndex === pageIndex) ?? null;
  const geometry = pageGeom && pageGeom.doc === doc && pageGeom.pageIndex === pageIndex ? pageGeom.geom : null;

  // The signature saved earlier in this tab, offered back.
  useEffect(() => {
    let live = true;
    loadSavedSignature().then((asset) => {
      if (live) setSaved(asset);
    });
    return () => {
      live = false;
    };
  }, []);

  // A file that cannot be opened: say so and go back to the dropzone.
  useEffect(() => {
    if (status === 'error' || status === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  // The current page's size, for the millimetre fields.
  useEffect(() => {
    if (!doc || pageIndex >= doc.pageCount) return;
    let live = true;
    doc.geometry(pageIndex).then(
      (geom) => {
        if (geomCache.current.doc !== doc) geomCache.current = { doc, map: new Map() };
        geomCache.current.map.set(pageIndex, geom);
        if (live) setPageGeom({ doc, pageIndex, geom });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, pageIndex]);

  const { set: commit, preview, cancelPreview, undo, redo, reset, committed } = history;
  const { invalidate, start } = run;

  /** A page's size, read once and kept, so `sizeOf` can answer while dragging. */
  const geomFor = useCallback(
    async (i: number): Promise<PageGeometry> => {
      if (!doc) throw new Error('No document');
      const geom = await doc.geometry(i);
      if (geomCache.current.doc !== doc) geomCache.current = { doc, map: new Map() };
      geomCache.current.map.set(i, geom);
      return geom;
    },
    [doc],
  );
  const sizeOf = useCallback(
    (i: number) => (geomCache.current.doc === doc ? geomCache.current.map.get(i) : undefined),
    [doc],
  );

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      // A new document starts clean, but keeps the signature already made.
      reset({ stamps: [], signature: state.signature, initials: state.initials });
      invalidate();
      setFile(next);
      setPageIndex(0);
      setSelectedId(null);
      setCreatorOpen(!state.signature);
      setOptionsOpen(true);
      setCompare('after');
    },
    [reset, invalidate, state.signature, state.initials],
  );

  const removeFile = useCallback(() => {
    reset({ stamps: [], signature: state.signature, initials: state.initials });
    invalidate();
    setFile(null);
    setSelectedId(null);
  }, [reset, invalidate, state.signature, state.initials]);

  const goToPage = useCallback((next: number) => {
    setPageIndex(next);
    setSelectedId(null);
    setRemoveAsk(null);
  }, []);

  /** Put a new stamp on the current page, selected. */
  const addStamp = useCallback(
    async (kind: StampKind, change: Partial<SignState> = {}, text?: string) => {
      if (!doc) return;
      const geom = await geomFor(pageIndex);
      const id = generateId();
      commit((s) => {
        const next = { ...s, ...change };
        const asset = kind === 'signature' ? next.signature : kind === 'initials' ? next.initials : null;
        const aspect = kind === 'date' ? dateBoxAspect(text ?? '') : (asset?.aspect ?? 1);
        const sameKind = s.stamps.filter((x) => x.pageIndex === pageIndex && x.kind === kind).length;
        const stamp: Stamp = {
          id,
          kind,
          pageIndex,
          rect: defaultStampRect(kind, aspect, geom, sameKind),
          group: id,
          pristine: true,
          text,
        };
        return { ...next, stamps: [...next.stamps, stamp] };
      });
      setSelectedId(id);
      setFocusGroup(id);
      setAnnouncement(`${KIND_LABEL[kind]} added to page ${pageIndex + 1}.`);
    },
    [doc, pageIndex, commit, geomFor],
  );

  /**
   * Stamps that show an asset take the new image's shape when the asset is
   * replaced — otherwise a redrawn signature would be stretched into the old box.
   */
  const reshape = useCallback(
    async (current: Stamp[], kind: StampKind, aspect: number): Promise<Stamp[]> => {
      if (!doc) return current;
      const out: Stamp[] = [];
      for (const stamp of current) {
        if (stamp.kind !== kind) {
          out.push(stamp);
          continue;
        }
        const geom = await geomFor(stamp.pageIndex);
        out.push({ ...stamp, rect: reshapeRect(stamp.rect, aspect, geom) });
      }
      return out;
    },
    [doc, geomFor],
  );

  const chooseSignature = useCallback(
    async (asset: SigAsset) => {
      saveSignature(asset);
      setSaved(asset);
      setCreatorOpen(false);
      // On a phone the panel closes so the stamp on the page is what is seen.
      setOptionsOpen(false);
      if (stamps.some((s) => s.kind === 'signature')) {
        const reshaped = await reshape(stamps, 'signature', asset.aspect);
        commit((s) => ({ ...s, signature: asset, stamps: reshaped }));
        setAnnouncement('Signature updated on every page it is on.');
      } else {
        await addStamp('signature', { signature: asset });
      }
    },
    [stamps, reshape, commit, addStamp],
  );

  const addInitials = useCallback(async () => {
    const text = (initialsText.trim() || deriveInitials(typedText)).slice(0, MAX_INITIALS);
    if (!text) {
      setInitialsMissing(true);
      initialsRef.current?.focus();
      return;
    }
    setInitialsMissing(false);
    const asset = await signatureFromText(text, fontIndex);
    if (!asset) return;
    // Initials already on the page show the same asset, so they change with it.
    const reshaped = await reshape(stamps, 'initials', asset.aspect);
    await addStamp('initials', { initials: asset, stamps: reshaped });
  }, [initialsText, typedText, fontIndex, stamps, reshape, addStamp]);

  /** A new box for one stamp; its linked copies on other pages take the same place on theirs. */
  const updateRect = useCallback(
    (id: string, rect: RectNorm, pristine: boolean) =>
      (s: SignState): SignState => ({
        ...s,
        stamps: moveLinked(s.stamps, id, rect, pristine, sizeOf),
      }),
    [sizeOf],
  );

  /** How many pages a stamp is on, counting its linked copies. */
  const linkedCount = useCallback(
    (stamp: Stamp) => stamps.reduce((n, s) => n + (s.group === stamp.group ? 1 : 0), 0),
    [stamps],
  );

  const positionNote = useCallback(
    (stamp: Stamp, rect: RectNorm, geom: PageGeometry) => {
      const mm = rectToMm(rect, geom);
      const copies = linkedCount(stamp);
      return (
        `${KIND_LABEL[stamp.kind]} at ${Math.round(mm.x)} millimetres from the left, ${Math.round(mm.y)} from the top, ${Math.round(mm.width)} wide.` +
        (copies > 1 ? ` The same on all ${copies} pages it is on.` : '')
      );
    },
    [linkedCount],
  );

  const onBoxChange = useCallback(
    (stamp: Stamp, rect: RectNorm, phase: OverlayChangePhase, source: 'pointer' | 'keyboard') => {
      if (phase === 'cancel') {
        cancelPreview();
      } else if (phase === 'preview') {
        preview(updateRect(stamp.id, rect, stamp.pristine));
      } else {
        commit(updateRect(stamp.id, rect, false), source === 'keyboard' ? { coalesce: `keys:${stamp.id}` } : undefined);
        if (source === 'keyboard' && geometry) {
          setAnnouncement(positionNote(stamp, rect, geometry));
        } else if (linkedCount(stamp) > 1) {
          setAnnouncement(`${KIND_LABEL[stamp.kind]} moved on all ${linkedCount(stamp)} pages it is on.`);
        }
      }
    },
    [cancelPreview, preview, commit, updateRect, geometry, positionNote, linkedCount],
  );

  /** Take a stamp off this page, or (`everywhere`) off every page its linked copies are on. */
  const removeStamps = useCallback(
    (id: string, everywhere: boolean) => {
      const stamp = stamps.find((x) => x.id === id);
      const copies = stamp ? linkedCount(stamp) : 1;
      commit((s) => ({ ...s, stamps: removeFromStamps(s.stamps, id, everywhere) }));
      setSelectedId(null);
      setRemoveAsk(null);
      setAnnouncement(
        everywhere && copies > 1
          ? `${KIND_LABEL[stamp!.kind]} removed from all ${copies} pages.`
          : copies > 1
            ? `${KIND_LABEL[stamp!.kind]} removed from page ${stamp!.pageIndex + 1}; it stays on the other ${plural(copies - 1, 'page')}.`
            : 'Stamp removed.',
      );
    },
    [stamps, linkedCount, commit],
  );

  /** Remove: straight away for a single stamp; a stamp with linked copies asks which. */
  const removeStamp = useCallback(
    (id: string) => {
      const stamp = stamps.find((x) => x.id === id);
      if (stamp && linkedCount(stamp) > 1) {
        setSelectedId(id);
        setRemoveAsk(id);
        return;
      }
      removeStamps(id, false);
    },
    [stamps, linkedCount, removeStamps],
  );

  // The question replaces the toolbar; the keyboard goes to its first answer.
  useEffect(() => {
    if (removeAsk) removeAskRef.current?.focus();
  }, [removeAsk]);

  const resizeSelected = useCallback(
    (factor: number) => {
      if (!selected) return;
      commit(updateRect(selected.id, scaleRect(selected.rect, factor), false), { coalesce: `size:${selected.id}` });
    },
    [selected, commit, updateRect],
  );

  const duplicateSelected = useCallback(() => {
    if (!selected) return;
    const id = generateId();
    const copy: Stamp = {
      ...selected,
      id,
      group: id,
      pristine: false,
      rect: moveRect(selected.rect, DUPLICATE_OFFSET, DUPLICATE_OFFSET),
    };
    commit((s) => ({ ...s, stamps: [...s.stamps, copy] }));
    setSelectedId(id);
    setFocusGroup(id);
    setAnnouncement(`${KIND_LABEL[selected.kind]} duplicated.`);
  }, [selected, commit]);

  /**
   * Put a stamp, linked, on exactly these pages — in the same place on each.
   * One undo step, whatever the number of pages.
   */
  const putOnPages = useCallback(
    async (stamp: Stamp, pages: number[]) => {
      if (!doc || pages.length === 0) return;
      // Every page involved has to be measured before the copies are placed.
      await Promise.all([stamp.pageIndex, ...pages].map((i) => geomFor(i)));
      commit((s) => {
        const next = setGroupPages(s.stamps, stamp.id, pages, sizeOf, generateId);
        // The same pages again (a second "All pages") is not a new step.
        return JSON.stringify(next) === JSON.stringify(s.stamps) ? s : { ...s, stamps: next };
      });
      setFocusGroup(stamp.group);
      if (!pages.includes(stamp.pageIndex) && selectedId === stamp.id) setSelectedId(null);
      const kind = KIND_LABEL[stamp.kind];
      setAnnouncement(
        pages.length === doc.pageCount
          ? `${kind} on all ${doc.pageCount} pages, in the same place on each.`
          : pages.length === 1
            ? `${kind} on page ${pages[0] + 1} only.`
            : `${kind} on pages ${formatPageRange(pages)}, in the same place on each.`,
      );
    },
    [doc, geomFor, commit, sizeOf, selectedId],
  );

  const copyToAllPages = useCallback(() => {
    if (!selected || !doc) return;
    setChoosingGroup(null);
    void putOnPages(
      selected,
      Array.from({ length: doc.pageCount }, (_, i) => i),
    );
  }, [selected, doc, putOnPages]);

  /** Make one linked copy independent of the others. */
  const unlink = useCallback(
    (stamp: Stamp) => {
      const group = generateId();
      commit((s) => ({ ...s, stamps: unlinkStamp(s.stamps, stamp.id, group) }));
      setFocusGroup(group);
      setChoosingGroup(null);
      setAnnouncement(
        `The ${KIND_LABEL[stamp.kind].toLowerCase()} on page ${stamp.pageIndex + 1} is now separate: moving it no longer moves the others.`,
      );
    },
    [commit],
  );

  const editMm = useCallback(
    (edit: Partial<RectMm>) => {
      if (!selected || !geometry) return;
      const rect = applyMm(selected.rect, geometry, edit);
      commit(updateRect(selected.id, rect, false), { coalesce: `field:${selected.id}` });
      setAnnouncement(positionNote(selected, rect, geometry));
    },
    [selected, geometry, commit, updateRect, positionNote],
  );

  /** A click on the page: a stamp that has not been moved yet goes there; otherwise deselect. */
  const onPageClick = useCallback(
    (point: { x: number; y: number }) => {
      if (selected?.pristine) {
        commit(updateRect(selected.id, centreRectAt(selected.rect, point.x, point.y), true));
        return;
      }
      setSelectedId(null);
    },
    [selected, commit, updateRect],
  );

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y — except while typing, where they
  // belong to the text field.
  useEffect(() => {
    if (!active || !editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editing, undo, redo]);

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-signed.pdf`;

  const apply = useCallback(() => {
    if (!doc || !file) return;
    const { stamps: toDraw, signature, initials } = committed;
    setSelectedId(null);
    setCompare('after');
    void start(async (work) => {
      const annotations: VisualAnnotation[] = [];
      for (const stamp of toDraw) {
        const geom = await doc.geometry(stamp.pageIndex);
        // The one mapping from "where it is on the page you see" to the file.
        const draw = viewRectToPdfDraw(geom, stamp.rect, 0);
        if (stamp.kind === 'date') {
          const text = dateTextDraw(draw);
          annotations.push({
            type: 'date',
            pageIndex: stamp.pageIndex,
            x: text.x,
            y: text.y,
            width: draw.width,
            height: draw.height,
            rotation: text.rotateDeg,
            opacity: 1,
            text: stamp.text ?? '',
            fontSize: text.size,
          });
          continue;
        }
        const asset = stamp.kind === 'signature' ? signature : initials;
        if (!asset) continue;
        annotations.push({
          type: stamp.kind,
          pageIndex: stamp.pageIndex,
          x: draw.x,
          y: draw.y,
          width: draw.width,
          height: draw.height,
          rotation: draw.rotateDeg,
          opacity: 1,
          imageDataUrl: asset.dataUrl,
        });
      }

      // Fresh bytes for the worker; the File itself is all the tool keeps.
      const buffer = await file.arrayBuffer();
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work(
          'pdf',
          { op: 'sign-visual', buffer, options: { annotations }, progressPort: port2 },
          [buffer, port2],
        );
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message);
        if (response.status !== 'success') throw new Error('The PDF could not be signed.');
        return new File([response.result], outputName, { type: 'application/pdf' });
      } finally {
        port1.close();
      }
    });
  }, [doc, file, committed, start, outputName]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result, run.result.name);
  }, [run.result]);

  const stampCount = stamps.length;
  const pagesStamped = useMemo(() => new Set(stamps.map((s) => s.pageIndex)).size, [stamps]);
  const perPage = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of stamps) counts.set(s.pageIndex, (counts.get(s.pageIndex) ?? 0) + 1);
    return counts;
  }, [stamps]);

  // The stamp "Put this signature on" is about: the selected one, else the one
  // last added or chosen, else the newest on this page.
  const onThisPage = stamps.filter((s) => s.pageIndex === pageIndex);
  const target =
    selected ??
    onThisPage.find((s) => s.group === focusGroup) ??
    stamps.find((s) => s.group === focusGroup) ??
    onThisPage[onThisPage.length - 1] ??
    null;
  const targetPages = target ? groupPages(stamps, target.group) : [];
  const scope: Scope | null = !target
    ? null
    : choosingGroup === target.group
      ? 'choose'
      : targetPages.length === 1
        ? 'this'
        : targetPages.length === pageCount
          ? 'all'
          : 'choose';
  const selectedCopies = selected ? targetPages.length : 0;

  const chooseScope = (next: Scope) => {
    if (!target) return;
    if (next === 'choose') {
      setChoosingGroup(target.group);
      if (targetPages.length > 0) setAnnouncement('Tick the pages it should be on, or type them.');
      return;
    }
    setChoosingGroup(null);
    void putOnPages(target, next === 'all' ? Array.from({ length: pageCount }, (_, i) => i) : [target.pageIndex]);
  };

  const togglePage = (i: number, on: boolean) => {
    if (!target) return;
    const next = on ? [...targetPages, i] : targetPages.filter((p) => p !== i);
    if (next.length === 0) return;
    // A page ticked is copied from the stamp the choice is about; one unticked
    // that held that stamp passes the choice to a copy that stays.
    const source = target.pageIndex === i && !on ? stamps.find((s) => s.group === target.group && s.pageIndex !== i) : target;
    if (source) void putOnPages(source, next.sort((a, b) => a - b));
  };

  /* ── What the visitor is told ─────────────────────────────────────────── */

  // Where the controls are depends on the layout; on a phone they may be closed.
  const closed = phone && !optionsOpen;
  const beside = wide ? 'on the right' : 'below';
  const press = coarse ? 'tap' : 'click';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (run.phase === 'running') {
    prompt = 'Signing your PDF…';
  } else if (run.phase === 'done') {
    prompt = 'Your signed PDF is ready. Download it, or make changes.';
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The PDF could not be signed. Try again.';
    promptTone = 'error';
  } else if (status !== 'ready') {
    prompt = 'Opening your PDF…';
  } else if ((creatorOpen || !state.signature) && signatureMode === 'upload' && uploadReview) {
    prompt = closed
      ? 'Open Options to check your signature.'
      : `Check your signature ${beside}: the paper is taken out and it is cropped to the ink. Then press Use this signature.`;
  } else if (!state.signature || (creatorOpen && stampCount === 0)) {
    prompt = closed ? 'Open Options to create your signature.' : `Create your signature ${beside}.`;
  } else if (creatorOpen) {
    prompt = closed
      ? 'Open Options to make your new signature.'
      : `Make your new signature ${beside}, or cancel to keep the current one.`;
  } else if (stampCount === 0) {
    prompt = closed
      ? 'Open Options and press Signature to add it to this page.'
      : `Press Signature ${beside} to add your signature to this page.`;
  } else if (selected?.pristine) {
    prompt = `Drag your ${KIND_LABEL[selected.kind].toLowerCase()} into place, or ${press} the spot where it should go.`;
  } else if (selected && selectedCopies > 1) {
    prompt = `Drag to move it, pull a corner to resize it — ${selectedCopies === 2 ? 'the copy on the other page follows' : `the copies on the other ${selectedCopies - 1} pages follow`} — or press Sign PDF when it looks right.`;
  } else if (selected) {
    prompt = 'Drag to move it, pull a corner to resize it, or press Sign PDF when it looks right.';
  } else if (target && targetPages.length > 1) {
    prompt = `Your ${KIND_LABEL[target.kind].toLowerCase()} is on ${targetPages.length} of ${plural(pageCount, 'page')}. ${press === 'tap' ? 'Tap' : 'Click'} it to change it, or press Sign PDF when it looks right.`;
  } else {
    prompt = `${press === 'tap' ? 'Tap' : 'Click'} a stamp to change it, or press Sign PDF when it looks right.`;
  }

  const disabledReason =
    status !== 'ready' ? 'Opening your PDF…' : stampCount === 0 ? 'Add your signature to the page first' : null;
  const hint = `${plural(stampCount, 'stamp')} on ${plural(pagesStamped, 'page')} will be added to your PDF.`;
  const summary = run.result ? `${run.result.name} · ${formatBytes(run.result.size)} · ${plural(pageCount, 'page')}` : undefined;

  /* ── Document pane ────────────────────────────────────────────────────── */

  const showingOutput = run.phase === 'done' && compare === 'after';
  const viewerDoc = showingOutput ? output.doc : doc;

  const renderOverlay = (frame: PageFrame) => (
    <OverlayLayer onBackgroundClick={onPageClick} disabled={!editing}>
      {stamps
        .filter((s) => s.pageIndex === frame.pageIndex)
        .map((s) => {
          const asset = s.kind === 'signature' ? state.signature : s.kind === 'initials' ? state.initials : null;
          return (
            <OverlayBox
              key={s.id}
              kind={s.kind}
              rect={s.rect}
              label={`${KIND_LABEL[s.kind]}, page ${s.pageIndex + 1}`}
              selected={s.id === selectedId}
              disabled={!editing}
              onSelect={() => {
                setSelectedId(s.id);
                setFocusGroup(s.group);
              }}
              onDeselect={() => setSelectedId(null)}
              onRemove={() => removeStamp(s.id)}
              onChange={(rect, phase, source) => onBoxChange(s, rect, phase, source)}
              hint={s.pristine ? 'Drag to move · corners to resize' : undefined}
            >
              {s.kind === 'date' ? (
                <DateStamp text={s.text ?? ''} />
              ) : asset ? (
                <img
                  src={asset.dataUrl}
                  alt=""
                  draggable={false}
                  data-testid="stamp-image"
                  className="pointer-events-none block size-full select-none"
                />
              ) : null}
            </OverlayBox>
          );
        })}
    </OverlayLayer>
  );

  const undoRedo = (
    <>
      {stampCount > 0 && (
        <span data-testid="placed-count" className="mr-1 whitespace-nowrap text-xs font-medium text-[var(--color-text-secondary)]">
          {stampCount} stamp{stampCount !== 1 ? 's' : ''} placed
        </span>
      )}
      <button
        type="button"
        onClick={undo}
        disabled={!history.canUndo}
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        data-testid="undo"
        className={toolbarButton}
      >
        <Undo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Undo</span>
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!history.canRedo}
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        data-testid="redo"
        className={toolbarButton}
      >
        <Redo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Redo</span>
      </button>
    </>
  );

  const selectionBar = (
    <div className="flex h-14 items-center gap-1 px-2 sm:h-12 sm:gap-2 sm:px-3" data-testid="selection-bar">
      {selected && removeAsk === selected.id ? (
        <div
          role="group"
          aria-label={`Remove the ${KIND_LABEL[selected.kind].toLowerCase()}`}
          data-testid="remove-ask"
          className="flex flex-1 items-center gap-1.5 sm:gap-2"
        >
          <p className="mr-auto min-w-0 text-xs font-medium text-[var(--color-text-primary)]">
            Remove the {KIND_LABEL[selected.kind].toLowerCase()} from
          </p>
          <button ref={removeAskRef} type="button" onClick={() => removeStamps(selected.id, false)} data-testid="remove-this-page" className={toolbarButton}>
            This page
          </button>
          <button
            type="button"
            onClick={() => removeStamps(selected.id, true)}
            data-testid="remove-all-pages"
            className={cn(toolbarButton, 'text-[var(--color-error)]')}
          >
            All {selectedCopies} pages
          </button>
          <button type="button" onClick={() => setRemoveAsk(null)} data-testid="remove-cancel" className={toolbarButton}>
            Cancel
          </button>
        </div>
      ) : selected ? (
        <>
          <p className="mr-auto truncate text-xs font-medium text-[var(--color-text-primary)] max-sm:hidden">
            {KIND_LABEL[selected.kind]} selected{selectedCopies > 1 ? ` · on ${selectedCopies} pages` : ''}
          </p>
          <div role="toolbar" aria-label={`${KIND_LABEL[selected.kind]} actions`} className="flex flex-1 items-center justify-between gap-1 sm:flex-none sm:justify-end sm:gap-1.5">
            <button type="button" onClick={() => resizeSelected(1 / SIZE_STEP)} data-testid="stamp-smaller" className={barButton}>
              <Minus className="size-4" aria-hidden="true" />
              Smaller
            </button>
            <button type="button" onClick={() => resizeSelected(SIZE_STEP)} data-testid="stamp-larger" className={barButton}>
              <Plus className="size-4" aria-hidden="true" />
              Larger
            </button>
            <button type="button" onClick={duplicateSelected} data-testid="stamp-duplicate" className={barButton}>
              <Copy className="size-4" aria-hidden="true" />
              Duplicate
            </button>
            {pageCount > 1 && (
              <button type="button" onClick={copyToAllPages} data-testid="place-all-pages" className={barButton}>
                <CopyPlus className="size-4" aria-hidden="true" />
                Copy to all pages
              </button>
            )}
            <button
              type="button"
              onClick={() => removeStamp(selected.id)}
              data-testid="overlay-remove"
              className={cn(barButton, 'text-[var(--color-error)]')}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Remove
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-[var(--color-text-secondary)]" data-testid="selection-hint">
          {stampCount === 0
            ? 'Your signature will appear on the page, ready to move.'
            : `${press === 'tap' ? 'Tap' : 'Click'} a stamp to move, resize, copy or remove it.`}
        </p>
      )}
    </div>
  );

  const compareBar = (
    <div className="flex h-14 items-center gap-3 px-2 sm:h-12 sm:px-3" data-testid="compare-bar">
      <p data-testid="output-caption" className="min-w-0 truncate text-xs font-medium text-[var(--color-text-primary)] sm:text-sm">
        {compare === 'after' ? 'Signed — this is your file' : 'Before — your original'}
      </p>
      <div role="group" aria-label="Compare before and after" className="ml-auto flex shrink-0 rounded-lg border border-[var(--color-border)] p-0.5">
        {(['before', 'after'] as const).map((side) => (
          <button
            key={side}
            type="button"
            aria-pressed={compare === side}
            onClick={() => setCompare(side)}
            data-testid={`compare-${side}`}
            className={cn(
              'h-8 rounded-md px-3 text-xs font-medium',
              compare === side
                ? 'bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {side === 'before' ? 'Before' : 'After'}
          </button>
        ))}
      </div>
    </div>
  );

  const stage = (
    <PageViewer
      doc={viewerDoc}
      pageIndex={pageIndex}
      onPageChange={goToPage}
      overlay={run.phase === 'done' ? undefined : renderOverlay}
      toolbarEnd={run.phase === 'done' ? undefined : undoRedo}
      footer={run.phase === 'done' ? compareBar : selectionBar}
      pageLabel={showingOutput ? 'Signed page' : 'Page'}
    />
  );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={pageIndex}
      onSelect={goToPage}
      label={showingOutput ? 'Signed pages' : 'Pages'}
      renderBadge={
        run.phase === 'done'
          ? undefined
          : (i) => {
              const count = perPage.get(i);
              if (!count) return null;
              return (
                <span
                  data-testid={`rail-badge-${i + 1}`}
                  title={`${plural(count, 'stamp')} on this page`}
                  className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-success)] px-1 text-[10px] font-bold text-white"
                >
                  {count === 1 ? <Check className="size-3" aria-hidden="true" /> : count}
                </span>
              );
            }
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const mm = selected && geometry ? rectToMm(selected.rect, geometry) : null;
  const derivedInitials = deriveInitials(typedText);
  const dateText = dateStampText();
  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';

  const controls = (
    // Stacked tablet layout: the sections sit side by side, so the controls stay
    // short and the page above them stays large.
    <div
      className="flex flex-col gap-5 p-3 sm:p-4 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-start md:max-lg:gap-x-6"
      inert={!editing}
    >
      <section
        className={cn('flex flex-col gap-3', (creatorOpen || !state.signature) && 'md:max-lg:col-span-2')}
        aria-labelledby="sign-your-signature"
      >
        <h3 id="sign-your-signature" className={heading}>
          Your signature
        </h3>

        {creatorOpen || !state.signature ? (
          <>
            {saved && !state.signature && (
              <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] p-2">
                <span className="flex h-10 w-20 shrink-0 items-center justify-center rounded bg-white p-1">
                  <img src={saved.dataUrl} alt="" className="max-h-full max-w-full object-contain" />
                </span>
                <button
                  type="button"
                  onClick={() => void chooseSignature(saved)}
                  disabled={status !== 'ready'}
                  data-testid="use-saved-signature"
                  className={cn(outlineButton, 'flex-1')}
                >
                  Use saved signature
                </button>
                <button
                  type="button"
                  onClick={() => {
                    forgetSignature();
                    setSaved(null);
                  }}
                  data-testid="forget-saved-signature"
                  className="rounded px-1 text-xs text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text-primary)]"
                >
                  Forget
                </button>
              </div>
            )}
            <SignatureCreator
              onUse={(asset) => void chooseSignature(asset)}
              mode={signatureMode}
              onModeChange={setSignatureMode}
              typedText={typedText}
              onTypedTextChange={setTypedText}
              fontIndex={fontIndex}
              onFontChange={setFontIndex}
              onCancel={state.signature ? () => setCreatorOpen(false) : undefined}
              onReviewChange={setUploadReview}
            />
          </>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex h-14 min-w-0 flex-1 items-center justify-center rounded-lg border border-[var(--color-border)] bg-white p-1.5">
              <img
                src={state.signature.dataUrl}
                alt="Your signature"
                data-testid="signature-preview"
                className="max-h-full max-w-full object-contain"
              />
            </span>
            <button type="button" onClick={() => setCreatorOpen(true)} data-testid="change-signature" className={outlineButton}>
              Change
            </button>
          </div>
        )}
      </section>

      {state.signature && !creatorOpen && (
        <>
          {target && pageCount > 1 && (
            <section className="flex flex-col gap-2" data-testid="stamp-scope" data-scope={scope ?? undefined}>
              <fieldset className="flex flex-col gap-1.5">
                <legend className={cn(heading, 'mb-1.5')}>Put {THIS_KIND[target.kind]} on</legend>
                {(['this', 'all', 'choose'] as const).map((value) => (
                  <label key={value} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-[var(--color-text-primary)]">
                    <input
                      type="radio"
                      name="sign-scope"
                      value={value}
                      checked={scope === value}
                      onChange={() => chooseScope(value)}
                      data-testid={`scope-${value}`}
                      className="size-4 accent-[var(--color-primary)]"
                    />
                    {value === 'this'
                      ? target.pageIndex === pageIndex
                        ? 'This page only'
                        : `Page ${target.pageIndex + 1} only`
                      : value === 'all'
                        ? `All pages (${pageCount})`
                        : 'Choose pages'}
                  </label>
                ))}
              </fieldset>
              {scope === 'choose' && (
                <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-2">
                  <PageRangeField
                    pages={targetPages}
                    total={pageCount}
                    onApply={(pages) => {
                      const source = pages.includes(target.pageIndex)
                        ? target
                        : (stamps.find((s) => s.group === target.group && pages.includes(s.pageIndex)) ?? target);
                      void putOnPages(source, pages);
                    }}
                  />
                  <fieldset>
                    <legend className="mb-1 text-xs text-[var(--color-text-secondary)]">Or tick the pages</legend>
                    <div className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1 overflow-y-auto" data-testid="scope-page-list">
                      {Array.from({ length: pageCount }, (_, i) => {
                        const on = targetPages.includes(i);
                        return (
                          <label
                            key={i}
                            className={cn(
                              'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 text-xs tabular-nums',
                              on
                                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]'
                                : 'border-[var(--color-border)] text-[var(--color-text-primary)]',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={on && targetPages.length === 1}
                              onChange={(e) => togglePage(i, e.target.checked)}
                              aria-label={`Page ${i + 1}`}
                              data-testid={`scope-page-${i + 1}`}
                              className="size-3.5 accent-[var(--color-primary)]"
                            />
                            {i + 1}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </div>
              )}
              <p className="text-xs text-[var(--color-text-secondary)]" data-testid="stamp-pages-summary">
                {KIND_LABEL[target.kind]} on {targetPages.length} of {plural(pageCount, 'page')}
                {targetPages.length > 1 ? ', in the same place on each. Moving or resizing one moves them all.' : '.'}
              </p>
              {targetPages.length > 1 && (
                <button
                  type="button"
                  onClick={() => unlink(target)}
                  data-testid="stamp-unlink"
                  className={cn(outlineButton, 'self-start')}
                >
                  <Unlink className="size-4" aria-hidden="true" />
                  Unlink page {target.pageIndex + 1}
                </button>
              )}
            </section>
          )}

          <section className="flex flex-col gap-3" aria-labelledby="sign-add">
            <h3 id="sign-add" className={heading}>
              Add to this page
            </h3>
            <div className="grid grid-cols-3 gap-2" data-testid="stamp-type">
              <button type="button" onClick={() => void addStamp('signature')} data-testid="stamp-signature" className={outlineButton}>
                <Plus className="size-4" aria-hidden="true" />
                Signature
              </button>
              <button type="button" onClick={() => void addInitials()} data-testid="stamp-initials" className={outlineButton}>
                <Plus className="size-4" aria-hidden="true" />
                Initials
              </button>
              <button type="button" onClick={() => void addStamp('date', {}, dateText)} data-testid="stamp-date" className={outlineButton}>
                <Plus className="size-4" aria-hidden="true" />
                Date
              </button>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="sign-initials" className="text-xs text-[var(--color-text-secondary)]">
                Initials to use
              </label>
              <input
                id="sign-initials"
                ref={initialsRef}
                type="text"
                value={initialsText}
                onChange={(e) => {
                  setInitialsText(e.target.value);
                  setInitialsMissing(false);
                }}
                placeholder={derivedInitials || 'AB'}
                maxLength={MAX_INITIALS}
                aria-invalid={initialsMissing || undefined}
                aria-describedby="sign-initials-note"
                data-testid="initials-input"
                className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
              />
            </div>
            <p
              id="sign-initials-note"
              data-testid="add-note"
              className={cn('min-h-4 text-xs', initialsMissing ? 'font-medium text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]')}
            >
              {initialsMissing ? 'Type your initials first.' : `The date stamp reads ${dateText}.`}
            </p>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="sign-position">
            <h3 id="sign-position" className={heading}>
              Position of the selected stamp
            </h3>
            <div className="flex gap-2">
              <NumberField label="From left (mm)" testId="stamp-x" value={mm ? mm.x : null} onCommit={(x) => editMm({ x })} />
              <NumberField label="From top (mm)" testId="stamp-y" value={mm ? mm.y : null} onCommit={(y) => editMm({ y })} />
              <NumberField label="Width (mm)" testId="stamp-width" value={mm ? mm.width : null} onCommit={(width) => editMm({ width })} />
            </div>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {selected
                ? 'Type exact values, or use the arrow keys on the stamp.'
                : 'Select a stamp on the page to set its position exactly.'}
            </p>
          </section>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite" data-testid="stamp-announce">
        {announcement}
      </p>
    </div>
  );

  const result =
    run.phase === 'done' && run.result ? (
      <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
        <h3 className={heading}>Signed and ready</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {plural(stampCount, 'stamp')} added to {plural(pagesStamped, 'page')}. The page shown is the signed file
          itself — switch to Before to compare it with your original.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-secondary)]">File</dt>
          <dd className="truncate font-medium text-[var(--color-text-primary)]">{run.result.name}</dd>
          <dt className="text-[var(--color-text-secondary)]">Size</dt>
          <dd className="text-[var(--color-text-primary)]">{formatBytes(run.result.size)}</dd>
          <dt className="text-[var(--color-text-secondary)]">Pages</dt>
          <dd className="text-[var(--color-text-primary)]">{pageCount}</dd>
        </dl>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Something not right? Make changes takes you back to move, resize or remove a stamp.
        </p>
      </div>
    ) : undefined;

  return (
    <ToolWorkspace
      toolId="sign-pdf"
      active={active}
      empty={
        <DropZone
          accept={ACCEPT}
          multiple={false}
          onFiles={acceptFile}
          prompt="Drop the PDF you want to sign"
          hint="You will add your signature on the next screen"
        />
      }
      title="Sign this PDF"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        file ? (
          <WorkspaceFileBar
            file={file}
            extra={pageCount > 0 ? plural(pageCount, 'page') : undefined}
            onRemove={removeFile}
            onReplace={acceptFile}
            accept={ACCEPT}
            disabled={run.phase === 'running'}
          />
        ) : null
      }
      stage={stage}
      rail={rail}
      controls={controls}
      result={result}
      action={
        <ActionBar
          phase={run.phase}
          label="Sign PDF"
          runningLabel="Signing…"
          onRun={apply}
          disabledReason={disabledReason}
          hint={hint}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{ label: 'Download signed PDF', onDownload: download, ariaLabel: `Download signed PDF: ${outputName}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
