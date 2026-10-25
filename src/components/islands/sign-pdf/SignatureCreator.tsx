import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import SignatureUpload, { type SignatureUploadHandle, type UploadStatus } from './SignatureUpload';
import {
  SIGNATURE_FONTS,
  signatureFromCanvas,
  signatureFromText,
  type SigAsset,
} from './signature-image';

export type SignatureMode = 'draw' | 'type' | 'upload';

const MODES: { id: SignatureMode; label: string }[] = [
  { id: 'draw', label: 'Draw' },
  { id: 'type', label: 'Type' },
  { id: 'upload', label: 'Upload' },
];

interface SignatureCreatorProps {
  /** The visitor chose this signature. */
  onUse: (asset: SigAsset) => void;
  /** Draw, Type or Upload. Kept by the tool, so reopening returns to the same tab. */
  mode: SignatureMode;
  onModeChange: (mode: SignatureMode) => void;
  typedText: string;
  onTypedTextChange: (text: string) => void;
  fontIndex: number;
  onFontChange: (index: number) => void;
  /** Shown when a signature already exists and this is a change, not a first go. */
  onCancel?: () => void;
  /** Whether an uploaded picture is being checked before it is used (for the prompt). */
  onReviewChange?: (reviewing: boolean) => void;
}

const secondary =
  'rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Make a signature: draw it, type it, or upload a picture of it.
 *
 * "Use this signature" is disabled until there is something to use, and says
 * why. It is deliberately not a filled button: the workspace has exactly one of
 * those, the action in the action bar.
 */
export default function SignatureCreator({
  onUse,
  mode,
  onModeChange,
  typedText,
  onTypedTextChange,
  fontIndex,
  onFontChange,
  onCancel,
  onReviewChange,
}: SignatureCreatorProps) {
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const padRef = useRef<SignaturePadHandle>(null);
  const uploadRef = useRef<SignatureUploadHandle>(null);
  const [upload, setUpload] = useState<UploadStatus>({ reason: 'Choose a picture of your signature first', reviewing: false });
  const hintId = useId();
  const tabsId = useId();

  // Load the handwriting fonts up front so the previews and the canvas use them at once.
  useEffect(() => {
    if (!document.fonts) return;
    for (const font of SIGNATURE_FONTS) document.fonts.load(`60px "${font.web}"`).catch(() => {});
  }, []);

  const reason =
    mode === 'draw'
      ? drawn
        ? null
        : 'Draw your signature first'
      : mode === 'upload'
        ? upload.reason
        : typedText.trim()
          ? null
          : 'Type your name first';

  const reviewing = mode === 'upload' && upload.reviewing;
  useEffect(() => {
    onReviewChange?.(reviewing);
  }, [reviewing, onReviewChange]);

  const use = async () => {
    setProblem(null);
    setBusy(true);
    try {
      let asset: SigAsset | null = null;
      if (mode === 'draw') {
        const canvas = padRef.current?.getCanvas();
        asset = canvas ? signatureFromCanvas(canvas) : null;
      } else if (mode === 'type') {
        asset = await signatureFromText(typedText.trim(), fontIndex);
      } else {
        asset = uploadRef.current?.getAsset() ?? null;
      }
      if (asset) onUse(asset);
      else setProblem('That signature came out blank. Try again.');
    } catch {
      setProblem('That signature could not be used. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="signature-creator">
      <div
        role="tablist"
        aria-label="How to make your signature"
        className="flex gap-1 rounded-lg bg-[var(--color-background)] p-1"
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            id={`${tabsId}-${m.id}`}
            aria-selected={mode === m.id}
            aria-controls={`${tabsId}-panel`}
            data-testid={`signature-mode-${m.id}`}
            onClick={() => {
              // The pad is unmounted with its tab, and the drawing with it.
              if (m.id !== mode) setDrawn(false);
              onModeChange(m.id);
              setProblem(null);
            }}
            className={cn(
              'flex-1 rounded-md py-1.5 text-sm font-medium transition-colors',
              mode === m.id
                ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-sm'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${mode}`}
        className="flex flex-col gap-3"
      >
        {mode === 'draw' && (
          <>
            {/* Paper-white in both themes: the ink is black, as it will be on the page. */}
            <div className="rounded-lg border-2 border-dashed border-[var(--color-border)] bg-white">
              <SignaturePad
                ref={padRef}
                width={560}
                height={180}
                onChange={(empty) => setDrawn(!empty)}
                className="block h-24 w-full rounded-lg md:h-40"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => padRef.current?.undo()} disabled={!drawn} className={secondary}>
                Undo stroke
              </button>
              <button type="button" onClick={() => padRef.current?.clear()} disabled={!drawn} className={secondary}>
                Clear
              </button>
            </div>
          </>
        )}

        {mode === 'type' && (
          <>
            <input
              type="text"
              value={typedText}
              onChange={(e) => onTypedTextChange(e.target.value)}
              placeholder="Type your name"
              aria-label="Signature text"
              autoComplete="name"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-base text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
            />
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Handwriting style">
              {SIGNATURE_FONTS.map((font, i) => (
                <button
                  key={font.name}
                  type="button"
                  role="radio"
                  aria-checked={fontIndex === i}
                  aria-label={`${font.name} style`}
                  data-testid={`signature-font-${i}`}
                  onClick={() => onFontChange(i)}
                  className={cn(
                    'overflow-hidden rounded-lg border bg-white px-2 py-2 text-neutral-900 transition-colors',
                    fontIndex === i
                      ? 'border-2 border-[var(--color-primary)]'
                      : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50',
                  )}
                >
                  <span className="block truncate" style={{ fontFamily: font.stack, fontSize: '20px', lineHeight: 1.3 }}>
                    {typedText || 'Your Name'}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {mode === 'upload' && <SignatureUpload ref={uploadRef} onStatus={setUpload} />}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={use}
            disabled={!!reason || busy}
            aria-describedby={reason ? hintId : undefined}
            data-testid="use-signature"
            className="h-10 flex-1 rounded-lg border-2 border-[var(--color-primary)] bg-[var(--color-primary)]/10 px-4 text-sm font-semibold text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)]/15 disabled:cursor-not-allowed disabled:border-[var(--color-border)] disabled:bg-transparent disabled:text-[var(--color-text-muted)]"
          >
            Use this signature
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className={cn(secondary, 'h-10')}>
              Cancel
            </button>
          )}
        </div>
        {/* Always one line tall, so the button never moves when the reason goes. */}
        <p id={hintId} data-testid="use-signature-hint" className="min-h-4 text-xs text-[var(--color-text-secondary)]">
          {reason ?? ''}
        </p>
      </div>

      {problem && (
        <p role="alert" data-testid="signature-problem" className="text-xs font-medium text-[var(--color-error)]">
          {problem}
        </p>
      )}
    </div>
  );
}
