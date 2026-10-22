import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { MoveDown, Redo2, Undo2 } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer, { type PageFrame } from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { OverlayBox, OverlayLayer, type OverlayChangePhase } from '@/components/islands/workspace/OverlayLayer';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { LockedStage, PASSWORD_INPUT_CLASS, EyeToggle, SECONDARY_BUTTON_CLASS } from '@/components/islands/protect-pdf/security-ui';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useHistory } from '@/hooks/use-history';
import { useMediaQuery } from '@/hooks/use-media-query';
import { notifyPdfLoadError } from '@/lib/notify';
import { downloadBlob, triggerDownload } from '@/lib/download';
import { cn, formatBytes } from '@/lib/utils';
import { generateSelfSignedCert, loadP12, signPdfWithPkcs7, certificateName } from '@/lib/pdf-sign';
import { checkSignedPdf, type SignatureCheck } from '@/lib/pdf-sign-check';
import type { PageGeometry, RectNorm } from '@/lib/pdf/page-geometry';
import {
  BOX_BORDER,
  BOX_FILL,
  BOX_OPACITY,
  BOX_TEXT,
  MIN_BOX_WIDTH,
  applyBoxMm,
  boxToMm,
  defaultSignatureRect,
  moveBoxToPage,
  signatureBoxLines,
  signatureTextLayout,
  toWinAnsi,
  type BoxMm,
} from '@/lib/pdf/signature-box';

/**
 * Digital Signature PDF, in the shared workspace.
 *
 * The PDF is shown large with its pages in the rail. The certificate — made
 * here, or a .p12/.pfx file opened with its password — and the choice between a
 * visible signature box and an invisible signature are in the controls pane.
 * A visible box is drawn on the page where it will be written: it can be
 * dragged, resized from its corners, moved to any page, and set in
 * millimetres; the file gets it as the signature field's appearance at exactly
 * that place (`signature-box.ts` through `page-geometry.ts`, so rotated and
 * cropped pages are right too). After signing, the page shown is the signed
 * file itself, with Before/After, and the result pane lists what was checked
 * on that file: who signed, when, the byte range, the digest and the RSA
 * signature.
 */

type CertSource = 'generate' | 'upload';
type Appearance = 'visible' | 'invisible';

interface Placement {
  pageIndex: number;
  rect: RectNorm;
}

interface LoadedCert {
  file: File;
  password: string;
  cn: string;
  issuer: string;
  expiry: string;
}

interface Signed {
  file: File;
  check: SignatureCheck | null;
  /** The certificate made for this run, as a .p12, when one was generated. */
  p12: ArrayBuffer | null;
  /** The page the box was put on, or null for an invisible signature. */
  boxPage: number | null;
}

const ACCEPT = ['application/pdf'];
const ACTION = 'Add digital signature';
const BOX_FONT = 'Helvetica, Arial, sans-serif';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-sm text-[var(--color-text-secondary)]';
const small = 'text-xs text-[var(--color-text-muted)]';
const INPUT =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]';
const toolbarButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';
const barButton =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;

/** Widths at size 1 of the box's lines, measured with the browser's Helvetica (or Arial: the same metrics). */
let measureCanvas: HTMLCanvasElement | null = null;
function longestLineAt1(lines: string[]): number {
  if (typeof document === 'undefined') return 0;
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = `bold 100px ${BOX_FONT}`;
  return Math.max(...lines.map((l) => ctx.measureText(l).width)) / 100;
}

/** The box as it will be written: same colours, same lines, same layout. */
function BoxPreview({ lines, widthPt, heightPt }: { lines: string[]; widthPt: number; heightPt: number }) {
  const longest = useMemo(() => longestLineAt1(lines), [lines]);
  if (!(widthPt > 0 && heightPt > 0)) return null;
  const layout = signatureTextLayout(widthPt, heightPt, longest, lines.length);
  return (
    <svg
      viewBox={`0 0 ${widthPt} ${heightPt}`}
      preserveAspectRatio="none"
      className="pointer-events-none block size-full"
      aria-hidden="true"
      data-testid="signature-box-preview"
    >
      <g opacity={BOX_OPACITY}>
        <rect x={0.5} y={0.5} width={Math.max(0, widthPt - 1)} height={Math.max(0, heightPt - 1)} fill={css(BOX_FILL)} stroke={css(BOX_BORDER)} strokeWidth={1} />
        {lines.map((line, i) => (
          <text
            key={i}
            x={layout.x}
            y={layout.baselines[i]}
            fontFamily={BOX_FONT}
            fontWeight={700}
            fontSize={layout.fontSize}
            fill={css(BOX_TEXT)}
          >
            {line}
          </text>
        ))}
      </g>
    </svg>
  );
}

interface MmFieldProps {
  label: string;
  testId: string;
  value: number | null;
  onCommit: (value: number) => void;
}

/** A millimetre field. Shows what is typed while typing, the real value otherwise. */
function MmField({ label, testId, value, onCommit }: MmFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = draft ?? (value === null ? '' : String(Math.round(value * 10) / 10));
  return (
    <div className="flex min-w-0 flex-col gap-1">
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

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export default function DigitalSignatureTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const [pageIndex, setPageIndex] = useState(0);

  // Certificate
  const [certSource, setCertSource] = useState<CertSource>('generate');
  const [certInfo, setCertInfo] = useState({ cn: '', org: '' });
  const [pfxFile, setPfxFile] = useState<File | null>(null);
  const [pfxPassword, setPfxPassword] = useState('');
  const [showPfxPassword, setShowPfxPassword] = useState(false);
  const [loaded, setLoaded] = useState<LoadedCert | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The box
  const [appearance, setAppearance] = useState<Appearance>('visible');
  const history = useHistory<Placement | null>(null);
  const placement = history.value;
  const [selected, setSelected] = useState(true);
  const [boxGeom, setBoxGeom] = useState<{ pageIndex: number; geom: PageGeometry } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const run = useToolRun<Signed>();
  const [step, setStep] = useState<{ progress: number; label: string }>({ progress: 0, label: '' });
  const signed = run.phase === 'done' ? run.result : null;
  const output = usePdfDocument(signed?.file ?? null);
  const [compare, setCompare] = useState<'after' | 'before'>('after');

  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const [optionsOpen, setOptionsOpen] = useState(false);

  const { invalidate } = run;
  const editing = run.phase !== 'running' && run.phase !== 'done';
  const visible = appearance === 'visible';

  useEffect(() => {
    if (status === 'error') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  // A new document starts with the box at the old fixed spot on page 1.
  const resetHistory = history.reset;
  useEffect(() => {
    if (!doc) return;
    let live = true;
    doc.geometry(0).then(
      (geom) => {
        if (!live) return;
        resetHistory({ pageIndex: 0, rect: defaultSignatureRect(geom) });
        setBoxGeom({ pageIndex: 0, geom });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, resetHistory]);

  // The geometry of the page the box is on, for the millimetre fields.
  const boxPage = placement?.pageIndex ?? null;
  useEffect(() => {
    if (!doc || boxPage === null) return;
    let live = true;
    doc.geometry(boxPage).then(
      (geom) => {
        if (live) setBoxGeom({ pageIndex: boxPage, geom });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, boxPage]);
  const geom = boxGeom && boxGeom.pageIndex === boxPage ? boxGeom.geom : null;

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      invalidate();
      setFile(next);
      setPageIndex(0);
      setSelected(true);
      setCompare('after');
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
  }, [invalidate]);

  /* ── The box ──────────────────────────────────────────────────────────── */

  const describe = useCallback(
    (rect: RectNorm, page: number, g: PageGeometry | null) => {
      if (!g) return `Signature box on page ${page + 1}.`;
      const mm = boxToMm(rect, g);
      return `Signature box on page ${page + 1}, ${Math.round(mm.x)} millimetres from the left, ${Math.round(mm.y)} from the top, ${Math.round(mm.width)} by ${Math.round(mm.height)}.`;
    },
    [],
  );

  const onBoxChange = useCallback(
    (rect: RectNorm, phase: OverlayChangePhase, source: 'pointer' | 'keyboard') => {
      if (!placement) return;
      if (phase === 'cancel') history.cancelPreview();
      else if (phase === 'preview') history.preview({ ...placement, rect });
      else {
        history.set({ ...placement, rect }, source === 'keyboard' ? { coalesce: 'keys' } : undefined);
        invalidate();
        if (source === 'keyboard') setAnnouncement(describe(rect, placement.pageIndex, geom));
      }
    },
    [placement, history, invalidate, describe, geom],
  );

  const editMm = useCallback(
    (edit: Partial<BoxMm>) => {
      if (!placement || !geom) return;
      history.set({ ...placement, rect: applyBoxMm(placement.rect, geom, edit) }, { coalesce: 'mm' });
      invalidate();
    },
    [placement, geom, history, invalidate],
  );

  const moveBoxHere = useCallback(async () => {
    if (!doc || !placement || !geom || placement.pageIndex === pageIndex) return;
    const to = await doc.geometry(pageIndex);
    const rect = moveBoxToPage(placement.rect, geom, to);
    history.set({ pageIndex, rect });
    setBoxGeom({ pageIndex, geom: to });
    setSelected(true);
    invalidate();
    setAnnouncement(`Signature box moved to page ${pageIndex + 1}.`);
  }, [doc, placement, geom, pageIndex, history, invalidate]);

  const resetBox = useCallback(async () => {
    if (!doc || !placement) return;
    const page = placement.pageIndex;
    const g = await doc.geometry(page);
    history.set({ pageIndex: page, rect: defaultSignatureRect(g) });
    invalidate();
    setAnnouncement(`Signature box back in the bottom-right corner of page ${page + 1}.`);
  }, [doc, placement, history, invalidate]);

  const undo = useCallback(() => {
    history.undo();
    invalidate();
  }, [history, invalidate]);
  const redo = useCallback(() => {
    history.redo();
    invalidate();
  }, [history, invalidate]);

  /* ── The certificate ──────────────────────────────────────────────────── */

  const chooseSource = (next: CertSource) => {
    setCertSource(next);
    invalidate();
  };

  const acceptPfx = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      setPfxFile(next);
      setLoaded(null);
      setLoadError(null);
      invalidate();
    },
    [invalidate],
  );

  const loadPfx = useCallback(async () => {
    if (!pfxFile || loading) return;
    setLoading(true);
    setLoadError(null);
    const password = pfxPassword;
    try {
      const { privateKey, certificate } = await loadP12(await pfxFile.arrayBuffer(), password);
      (privateKey as unknown as Record<string, null>).d = null;
      setLoaded({
        file: pfxFile,
        password,
        cn: certificateName(certificate),
        issuer: certificate.issuer.getField('CN')?.value ?? 'Unknown',
        expiry: certificate.validity.notAfter.toISOString().slice(0, 10),
      });
      invalidate();
    } catch (err) {
      setLoaded(null);
      setLoadError(err instanceof Error ? err.message : 'The certificate file could not be opened.');
    } finally {
      setLoading(false);
    }
  }, [pfxFile, pfxPassword, loading, invalidate]);

  const certLoaded = !!loaded && loaded.file === pfxFile && loaded.password === pfxPassword;

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-signed.pdf`;
  const signerPreview =
    certSource === 'generate' ? toWinAnsi(certInfo.cn.trim()) || 'Your name' : certLoaded ? toWinAnsi(loaded!.cn) : 'Name on your certificate';
  const today = new Date().toISOString().slice(0, 10);
  const boxLines = useMemo(() => signatureBoxLines(signerPreview, new Date(`${today}T12:00:00Z`)), [signerPreview, today]);

  let disabledReason: string | null = null;
  if (status === 'locked') disabledReason = 'This PDF has a password. Remove it with Unlock PDF first.';
  else if (status !== 'ready' || !doc) disabledReason = 'Opening your PDF…';
  else if (certSource === 'generate' && !certInfo.cn.trim()) disabledReason = 'Enter your name for the certificate.';
  else if (certSource === 'upload' && !pfxFile) disabledReason = 'Choose your .p12 or .pfx certificate file.';
  else if (certSource === 'upload' && !certLoaded) disabledReason = 'Enter the certificate password and press Load.';
  else if (visible && (!placement || !geom)) disabledReason = 'Placing the signature box…';

  const apply = useCallback(() => {
    if (!file || !doc || disabledReason) return;
    const source = certSource;
    const subject = { cn: certInfo.cn.trim(), org: certInfo.org.trim() || undefined };
    const cert = loaded;
    const box = visible ? placement : null;
    setCompare('after');
    void run.start(async () => {
      let privateKey;
      let certificate;
      let p12: ArrayBuffer | null = null;
      if (source === 'generate') {
        setStep({ progress: 20, label: 'Generating RSA-2048 key…' });
        const generated = await generateSelfSignedCert(subject);
        ({ privateKey, certificate } = generated);
        p12 = generated.p12Buffer;
      } else {
        setStep({ progress: 20, label: 'Opening your certificate…' });
        ({ privateKey, certificate } = await loadP12(await cert!.file.arrayBuffer(), cert!.password));
      }
      setStep({ progress: 60, label: 'Signing PDF with PKCS#7…' });
      const vis = box ? { pageIndex: box.pageIndex, geometry: await doc.geometry(box.pageIndex), rect: box.rect } : null;
      const bytes = await signPdfWithPkcs7(await file.arrayBuffer(), privateKey, certificate, { visible: vis });
      // Drop the private key as soon as it is no longer needed.
      (privateKey as unknown as Record<string, null>).d = null;
      setStep({ progress: 90, label: 'Checking the signature…' });
      let check: SignatureCheck | null = null;
      try {
        check = await checkSignedPdf(new Uint8Array(bytes));
      } catch {
        // Shown as "could not be read back" in the result pane.
      }
      if (box) setPageIndex(box.pageIndex);
      return {
        file: new File([bytes], outputName, { type: 'application/pdf' }),
        check,
        p12,
        boxPage: box ? box.pageIndex : null,
      };
    });
  }, [file, doc, disabledReason, certSource, certInfo, loaded, visible, placement, run, outputName]);

  const download = useCallback(() => {
    if (signed) downloadBlob(signed.file, signed.file.name);
  }, [signed]);

  const downloadP12 = useCallback(() => {
    if (!signed?.p12) return;
    const name = certInfo.cn.trim().replace(/\s+/g, '-').toLowerCase() || 'docukit';
    triggerDownload(signed.p12, `${name}-cert.p12`, 'application/x-pkcs12');
  }, [signed, certInfo.cn]);

  /* ── The stage ────────────────────────────────────────────────────────── */

  const done = run.phase === 'done' && !!signed;
  const showingOutput = done && compare === 'after';
  const viewerDoc = done ? (showingOutput ? output.doc : doc) : doc;
  const shownCount = viewerDoc?.pageCount ?? pageCount;
  const index = Math.min(pageIndex, Math.max(shownCount - 1, 0));
  const goToPage = useCallback(
    (next: number) => {
      if (next < 0 || next >= shownCount) return;
      setPageIndex(next);
    },
    [shownCount],
  );

  const boxHere = visible && !!placement && placement.pageIndex === index;

  const renderOverlay = (frame: PageFrame) =>
    !visible || !placement || placement.pageIndex !== frame.pageIndex ? null : (
      <OverlayLayer onBackgroundClick={() => setSelected(false)} disabled={!editing}>
        <OverlayBox
          kind="signature-box"
          rect={placement.rect}
          lockAspect={false}
          minWidth={MIN_BOX_WIDTH}
          label={`Signature box, page ${frame.pageIndex + 1}`}
          selected={selected}
          disabled={!editing}
          onSelect={() => setSelected(true)}
          onDeselect={() => setSelected(false)}
          onChange={onBoxChange}
          hint={selected ? 'Drag to move · corners to resize' : undefined}
        >
          <BoxPreview
            lines={boxLines}
            widthPt={placement.rect.width * frame.geometry.widthPt}
            heightPt={placement.rect.height * frame.geometry.heightPt}
          />
        </OverlayBox>
      </OverlayLayer>
    );

  const undoRedo = (
    <>
      <button type="button" onClick={undo} disabled={!history.canUndo || !editing} aria-label="Undo" title="Undo" data-testid="undo" className={toolbarButton}>
        <Undo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Undo</span>
      </button>
      <button type="button" onClick={redo} disabled={!history.canRedo || !editing} aria-label="Redo" title="Redo" data-testid="redo" className={toolbarButton}>
        <Redo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Redo</span>
      </button>
    </>
  );

  let barText: string;
  if (!visible) barText = 'Invisible signature: nothing is added to any page.';
  else if (!placement) barText = 'Placing the signature box…';
  else if (boxHere) barText = 'This box goes into the file here. Drag it, or pull a corner.';
  else barText = `The signature box is on page ${placement.pageIndex + 1}.`;

  const placeBar = (
    <div className="flex h-14 items-center gap-2 px-2 sm:h-12 sm:px-3" data-testid="placement-bar">
      <p className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]" data-testid="placement-hint">
        {barText}
      </p>
      {visible && placement && !boxHere && (
        <>
          <button type="button" onClick={() => goToPage(placement.pageIndex)} data-testid="go-to-box" className={cn(barButton, 'max-sm:hidden')}>
            Go to page {placement.pageIndex + 1}
          </button>
          <button type="button" onClick={() => void moveBoxHere()} disabled={!editing || !geom} data-testid="move-box-here" className={barButton}>
            <MoveDown className="size-4" aria-hidden="true" />
            Move the box here
          </button>
        </>
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

  const stage =
    status === 'locked' ? (
      <LockedStage title="This PDF has a password" testId="locked-stage">
        <p className={cn(note, 'max-w-sm')}>
          It cannot be shown or signed until the password is removed.{' '}
          <a href="/unlock-pdf/" className="font-medium text-[var(--color-primary)] underline">Open Unlock PDF</a>
        </p>
      </LockedStage>
    ) : (
      <PageViewer
        doc={viewerDoc}
        pageIndex={index}
        onPageChange={goToPage}
        overlay={done ? undefined : renderOverlay}
        toolbarEnd={done || !visible ? undefined : undoRedo}
        footer={done ? compareBar : placeBar}
        pageLabel={showingOutput ? 'Signed page' : 'Page'}
        padding={24}
      />
    );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={index}
      onSelect={goToPage}
      label={showingOutput ? 'Signed pages' : 'Pages'}
      renderBadge={(i) => {
        const page = done ? signed?.boxPage : visible ? placement?.pageIndex : null;
        if (page !== i) return null;
        return (
          <span
            data-testid={`rail-badge-${i + 1}`}
            title="The signature box is on this page"
            className="flex h-5 items-center justify-center rounded-full bg-[var(--color-primary)] px-1.5 text-[10px] font-bold text-white"
          >
            Box
          </span>
        );
      }}
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const mm = placement && geom ? boxToMm(placement.rect, geom) : null;

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      <section className="flex flex-col gap-3" aria-labelledby="ds-cert-heading">
        <h3 id="ds-cert-heading" className={heading}>Certificate</h3>
        <div className="flex gap-1 rounded-lg bg-[var(--color-background)] p-1">
          {([['generate', 'Generate New'], ['upload', 'Upload Existing']] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => chooseSource(val)}
              aria-pressed={certSource === val}
              data-testid={`cert-${val}`}
              className={cn(
                'flex-1 rounded-lg py-2 text-sm font-medium transition-colors',
                certSource === val
                  ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {certSource === 'generate' && (
          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="cert-cn" className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Common Name (Your Name) *
              </label>
              <input
                id="cert-cn"
                type="text"
                value={certInfo.cn}
                onChange={(e) => {
                  setCertInfo((p) => ({ ...p, cn: e.target.value }));
                  invalidate();
                }}
                placeholder="John Doe"
                autoComplete="name"
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="cert-org" className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Organization (optional)
              </label>
              <input
                id="cert-org"
                type="text"
                value={certInfo.org}
                onChange={(e) => {
                  setCertInfo((p) => ({ ...p, org: e.target.value }));
                  invalidate();
                }}
                placeholder="Acme Corp"
                className={INPUT}
              />
            </div>
            <p className={small}>
              A self-signed RSA-2048 certificate valid for 1 year is made in this page when you sign, and the PDF gets a
              PKCS#7 signature made with it. You can download the certificate as a .p12 file afterwards.
            </p>
          </div>
        )}

        {certSource === 'upload' && (
          <div className="flex flex-col gap-3">
            <div data-testid="pfx-upload">
              <DropZone accept={['.p12', '.pfx', 'application/x-pkcs12']} multiple={false} onFiles={acceptPfx} hint=".p12 or .pfx certificate file" compact={!!pfxFile} />
            </div>
            {pfxFile && <p className="truncate text-xs text-[var(--color-text-secondary)]" data-testid="pfx-name">{pfxFile.name}</p>}
            {pfxFile && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadPfx();
                }}
              >
                <div className="relative min-w-0 flex-1">
                  <input
                    type={showPfxPassword ? 'text' : 'password'}
                    value={pfxPassword}
                    onChange={(e) => {
                      setPfxPassword(e.target.value);
                      setLoadError(null);
                      invalidate();
                    }}
                    placeholder="Certificate password"
                    aria-label="Certificate password"
                    autoComplete="off"
                    data-testid="pfx-password"
                    aria-invalid={loadError ? true : undefined}
                    className={cn(PASSWORD_INPUT_CLASS, loadError && 'border-[var(--color-error)]')}
                  />
                  <EyeToggle show={showPfxPassword} onToggle={() => setShowPfxPassword((v) => !v)} />
                </div>
                <button type="submit" disabled={loading} data-testid="pfx-load" className={SECONDARY_BUTTON_CLASS}>
                  Load
                </button>
              </form>
            )}
            {loadError && (
              <p role="alert" data-testid="pfx-error" className="text-xs font-medium text-[var(--color-error)]">
                {loadError}
              </p>
            )}
            {certLoaded && (
              <div data-testid="pfx-details" className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-3 text-xs text-[var(--color-text-secondary)]">
                <p><span className="font-medium">CN:</span> {loaded!.cn}</p>
                <p><span className="font-medium">Issued by:</span> {loaded!.issuer}</p>
                <p><span className="font-medium">Expires:</span> {loaded!.expiry}</p>
              </div>
            )}
            <p className={small}>The file and its password are only used in this page. Nothing is sent anywhere.</p>
          </div>
        )}
      </section>

      <fieldset className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
        <legend className={cn(heading, 'mb-2 float-left w-full')}>On the page</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="radio"
            name="ds-appearance"
            checked={visible}
            onChange={() => {
              setAppearance('visible');
              invalidate();
            }}
            data-testid="appearance-visible"
            className="mt-0.5 accent-[var(--color-primary)]"
          />
          <span>
            <span className="font-medium text-[var(--color-text-primary)]">Visible signature box</span>
            <span className="block text-xs text-[var(--color-text-muted)]">
              A box on one page with the signer&apos;s name, the date and the algorithm, as shown on the page. It is text
              only, no image, and it is the signature field&apos;s appearance in the file.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="radio"
            name="ds-appearance"
            checked={!visible}
            onChange={() => {
              setAppearance('invisible');
              invalidate();
            }}
            data-testid="appearance-invisible"
            className="mt-0.5 accent-[var(--color-primary)]"
          />
          <span>
            <span className="font-medium text-[var(--color-text-primary)]">Invisible signature</span>
            <span className="block text-xs text-[var(--color-text-muted)]">
              Nothing is added to any page. The signature is in the file and is listed by PDF readers that show signatures.
            </span>
          </span>
        </label>

        {visible && (
          <div className="mt-2 flex flex-col gap-2" data-testid="box-fields">
            <p className="text-xs text-[var(--color-text-secondary)]" data-testid="box-page">
              {placement ? `On page ${placement.pageIndex + 1} of ${pageCount || '…'}.` : 'Placing the box…'}
              {placement && placement.pageIndex !== index && ' Go to another page and press Move the box here to change it.'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <MmField label="From left (mm)" testId="box-x" value={mm && editing ? mm.x : null} onCommit={(x) => editMm({ x })} />
              <MmField label="From top (mm)" testId="box-y" value={mm && editing ? mm.y : null} onCommit={(y) => editMm({ y })} />
              <MmField label="Width (mm)" testId="box-width" value={mm && editing ? mm.width : null} onCommit={(width) => editMm({ width })} />
              <MmField label="Height (mm)" testId="box-height" value={mm && editing ? mm.height : null} onCommit={(height) => editMm({ height })} />
            </div>
            <button type="button" onClick={() => void resetBox()} disabled={!placement || !editing} data-testid="box-reset" className="self-start text-xs font-medium text-[var(--color-primary)] underline underline-offset-2 disabled:opacity-50">
              Back to the bottom-right corner
            </button>
          </div>
        )}
      </fieldset>
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const check = signed?.check ?? null;
  const tick = (ok: boolean) => (
    <span aria-hidden="true" className={cn('font-bold', ok ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]')}>
      {ok ? '✓' : '✗'}
    </span>
  );

  const result = signed ? (
    <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="signature-result">
      <section className="flex flex-col gap-1.5" aria-labelledby="ds-result-heading">
        <h3 id="ds-result-heading" className={heading}>Signed with PKCS#7</h3>
        <p className={note} data-testid="result-appearance">
          {signed.boxPage === null ? 'Invisible signature: no box on any page.' : `Visible signature box on page ${signed.boxPage + 1}.`}
        </p>
      </section>

      {check ? (
        <section className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4" aria-labelledby="ds-check-heading" data-testid="signature-check">
          <h3 id="ds-check-heading" className={heading}>Checked in this page, on the file you will download</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-[var(--color-text-muted)]">Signed by</dt>
            <dd className="min-w-0 break-words text-[var(--color-text-primary)]" data-testid="check-signer">{check.signerName ?? 'Unknown'}</dd>
            <dt className="text-[var(--color-text-muted)]">Signing time</dt>
            <dd className="text-[var(--color-text-primary)]" data-testid="check-time">{check.signingTime ? formatUtc(check.signingTime) : 'Not recorded'}</dd>
            <dt className="text-[var(--color-text-muted)]">Issued by</dt>
            <dd className="min-w-0 break-words text-[var(--color-text-primary)]" data-testid="check-issuer">
              {check.selfSigned ? 'Self-signed' : (check.issuerName ?? 'Unknown')}
              {check.certificateExpires && <span className="text-[var(--color-text-muted)]"> · expires {check.certificateExpires.toISOString().slice(0, 10)}</span>}
            </dd>
          </dl>
          <ul className="flex flex-col gap-1.5 text-sm text-[var(--color-text-secondary)]">
            <li className="flex gap-2" data-testid="check-byte-range">
              {tick(check.coversWholeFile)}
              <span>
                {check.coversWholeFile
                  ? `The signature covers the whole file: all ${check.fileSize.toLocaleString('en-GB')} bytes except the ${check.unsignedBytes.toLocaleString('en-GB')}-byte space that holds the signature itself.`
                  : 'The signed byte range does not cover the whole file.'}
              </span>
            </li>
            <li className="flex gap-2" data-testid="check-digest">
              {tick(check.digestMatches)}
              <span>{check.digestMatches ? 'The SHA-256 digest in the signature matches those bytes.' : 'The SHA-256 digest in the signature does not match the file.'}</span>
            </li>
            <li className="flex gap-2" data-testid="check-rsa">
              {tick(check.signatureValid)}
              <span>{check.signatureValid ? 'The RSA signature verifies with the certificate inside it.' : 'The RSA signature does not verify with the certificate inside it.'}</span>
            </li>
          </ul>
          <p className={small}>
            Not checked: whether the certificate is trusted. PDF readers decide that themselves; a self-signed certificate
            is not trusted unless the person opening the file chooses to trust it.
          </p>
        </section>
      ) : (
        <p className={note} data-testid="signature-check-missing">The signature could not be read back from the file to check it.</p>
      )}

      {signed.p12 && (
        <section className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-4">
          <button type="button" onClick={downloadP12} data-testid="download-p12" className="self-start text-sm font-medium text-[var(--color-primary)] underline underline-offset-2">
            Download your .p12 certificate
          </button>
          <p className={small}>The certificate made for this signature, with its private key and an empty password. It is not kept anywhere else.</p>
        </section>
      )}
      <p className={note}>Press Make changes to change the certificate or the box.</p>
    </div>
  ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  const certReady =
    (certSource === 'generate' && !!certInfo.cn.trim()) || (certSource === 'upload' && certLoaded);
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (status === 'locked') {
    prompt = 'This PDF has a password. Remove it with Unlock PDF first.';
    promptTone = 'error';
  } else if (status !== 'ready') prompt = 'Opening your PDF…';
  else if (run.phase === 'running') prompt = 'Signing your PDF…';
  else if (run.phase === 'error') {
    prompt = 'The PDF could not be signed. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = phone && !optionsOpen ? 'Download your signed PDF. What was checked is in Options.' : `Download your signed PDF. What was checked is ${beside}.`;
    promptTone = 'success';
  } else if (!certReady) {
    prompt = phone && !optionsOpen ? `Open Options to set up your certificate, then press ${ACTION}.` : `Set up your certificate ${beside}, then press ${ACTION}.`;
  } else if (visible) prompt = `Put the signature box where it should go, then press ${ACTION}.`;
  else prompt = `Press ${ACTION}. Nothing will be added to the pages.`;

  const hint = visible
    ? `A PKCS#7 signature, with the box on page ${(placement?.pageIndex ?? 0) + 1}.`
    : 'A PKCS#7 signature, with no box on any page.';

  const summary = signed
    ? `${signed.file.name} · ${formatBytes(signed.file.size)}${pageCount ? ` · ${plural(pageCount, 'page')}` : ''}`
    : undefined;

  return (
    <>
      <ToolWorkspace
        toolId="digital-signature-pdf"
        active={!!file}
        empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="The PDF you want to sign" />}
        title="Sign this PDF digitally"
        prompt={prompt}
        promptTone={promptTone}
        optionsOpen={optionsOpen}
        onOptionsOpenChange={setOptionsOpen}
        fileBar={
          file ? (
            <WorkspaceFileBar
              file={file}
              extra={pageCount > 0 ? plural(pageCount, 'page') : status === 'locked' ? 'Locked' : undefined}
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
            label={ACTION}
            runningLabel="Signing…"
            onRun={apply}
            disabledReason={disabledReason}
            hint={hint}
            progress={step.progress}
            progressLabel={step.label}
            onCancel={run.cancel}
            download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download PDF: ${outputName}` }}
            summary={summary}
            onEditAgain={run.invalidate}
            error={run.error}
          />
        }
      />
      {file && (
        <p className="sr-only" role="status" aria-live="polite" data-testid="box-announce">
          {announcement}
        </p>
      )}
    </>
  );
}
