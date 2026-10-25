import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import { cn } from '@/lib/utils';
import type { RgbaImage } from '@/lib/sign/signature-extract';
import {
  InkExtractor,
  readSignaturePhoto,
  signatureFromInk,
  signatureFromPhoto,
  type SigAsset,
  type SignaturePhoto,
} from './signature-image';

/** What the Upload tab takes: the common photo formats, and iPhone HEIC through the shared decoder. */
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

export interface SignatureUploadHandle {
  /** The signature as it will be stamped: the cleaned PNG, or the picture as it is. */
  getAsset: () => SigAsset | null;
}

export interface UploadStatus {
  /** Why "Use this signature" cannot be pressed yet; null when it can. */
  reason: string | null;
  /** A picture is chosen and shown for checking. */
  reviewing: boolean;
}

interface SignatureUploadProps {
  onStatus: (status: UploadStatus) => void;
}

const segment = (on: boolean) =>
  cn(
    'flex-1 rounded-md py-1 text-sm font-medium transition-colors',
    on
      ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-sm'
      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
  );

/** A checkerboard behind the preview, so what is transparent shows as transparent. */
const CHECKERBOARD = {
  backgroundColor: '#ffffff',
  backgroundImage: 'repeating-conic-gradient(#e4e4e7 0% 25%, #ffffff 0% 50%)',
  backgroundSize: '16px 16px',
};

/**
 * Upload a photo or scan of a signature. By default the paper is taken out and
 * the picture cropped to the ink (in a worker, in this browser), shown on a
 * checkerboard; "Original" uses the picture as it is.
 */
const SignatureUpload = forwardRef<SignatureUploadHandle, SignatureUploadProps>(({ onStatus }, ref) => {
  const [photo, setPhoto] = useState<SignaturePhoto | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [cleaned, setCleaned] = useState(true);
  const [sensitivity, setSensitivity] = useState(50);
  const [black, setBlack] = useState(false);
  const [ink, setInk] = useState<RgbaImage | null>(null);
  /** The settings the shown ink was made with, e.g. "50" or "70-black". */
  const [inkFor, setInkFor] = useState('');
  const [working, setWorking] = useState(false);
  const extractor = useRef<InkExtractor | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sliderHint = useId();
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => () => extractor.current?.dispose(), []);

  const choose = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setProblem(null);
    setReading(true);
    setPhoto(null);
    setInk(null);
    try {
      const next = await readSignaturePhoto(file);
      extractor.current ??= new InkExtractor();
      await extractor.current.prepare(next.pixels);
      setSensitivity(50);
      setBlack(false);
      // A picture that is already cut out has no paper to remove.
      setCleaned(!next.transparent);
      // Cleaning starts as this renders; never show "no ink" before it has run.
      setWorking(!next.transparent);
      setPhoto(next);
    } catch {
      setProblem('That picture could not be read. Try a JPEG, PNG, WebP or HEIC.');
    } finally {
      setReading(false);
    }
  };

  // A new picture starts a new generation: answers for the old one are dropped.
  // (Declared first, so it runs before the cleaning effect below.)
  const generation = useRef(0);
  const queued = useRef<{ sensitivity: number; black: boolean } | null>(null);
  useEffect(() => {
    generation.current++;
    queued.current = null;
  }, [photo]);

  // Clean the picture again whenever a setting moves. One request at a time:
  // while one runs, only the latest settings wait, so a dragged slider never
  // builds up a queue.
  const running = useRef(-1);
  useEffect(() => {
    if (!photo || !cleaned || !extractor.current) return;
    const gen = generation.current;
    queued.current = { sensitivity, black };
    setWorking(true);
    if (running.current === gen) return;
    running.current = gen;
    void (async () => {
      while (queued.current && gen === generation.current) {
        const options = queued.current;
        queued.current = null;
        let result: RgbaImage | null;
        try {
          result = (await extractor.current?.extract(options)) ?? null;
        } catch {
          result = null;
        }
        if (gen === generation.current && !queued.current) {
          setInk(result);
          setInkFor(`${options.sensitivity}${options.black ? '-black' : ''}`);
          setWorking(false);
        }
      }
      if (running.current === gen) running.current = -1;
    })();
  }, [photo, cleaned, sensitivity, black]);

  // Draw what will be used: the cleaned ink, or the picture itself. In the
  // same commit as data-ink-for, so the two never disagree.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !photo) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (cleaned) {
      if (!ink) {
        canvas.width = canvas.height = 1;
        return;
      }
      canvas.width = ink.width;
      canvas.height = ink.height;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(ink.data), ink.width, ink.height), 0, 0);
    } else {
      canvas.width = photo.canvas.width;
      canvas.height = photo.canvas.height;
      ctx.drawImage(photo.canvas, 0, 0);
    }
  }, [photo, cleaned, ink]);

  const noInk = !!photo && cleaned && !working && !ink;
  const reason = reading
    ? 'Reading the picture…'
    : !photo
      ? 'Choose a picture of your signature first'
      : cleaned && working
        ? 'Taking out the paper…'
        : noInk
          ? 'No signature found: move Sensitivity to the right, or choose Original'
          : null;

  useEffect(() => {
    onStatusRef.current({ reason, reviewing: !!photo });
  }, [reason, photo]);

  useImperativeHandle(
    ref,
    () => ({
      getAsset: () => {
        if (!photo) return null;
        if (!cleaned) return signatureFromPhoto(photo);
        return ink ? signatureFromInk(ink) : null;
      },
    }),
    [photo, cleaned, ink],
  );

  if (!photo) {
    return (
      <div data-testid="signature-upload" className="flex flex-col gap-2">
        <DropZone
          accept={UPLOAD_TYPES}
          multiple={false}
          onFiles={choose}
          prompt={reading ? 'Reading the picture…' : 'Drop a photo or scan of your signature'}
          hint="JPEG, PNG, WebP or HEIC. The paper is taken out in your browser."
          className="min-h-28"
        />
        {problem && (
          <p role="alert" data-testid="signature-upload-problem" className="text-xs font-medium text-[var(--color-error)]">
            {problem}
          </p>
        )}
      </div>
    );
  }

  return (
    <div data-testid="signature-upload" className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label="Which picture to use"
        className="flex gap-1 rounded-lg bg-[var(--color-background)] p-1"
      >
        <button
          type="button"
          role="radio"
          aria-checked={!cleaned}
          data-testid="signature-view-original"
          onClick={() => setCleaned(false)}
          className={segment(!cleaned)}
        >
          Original
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={cleaned}
          data-testid="signature-view-cleaned"
          onClick={() => setCleaned(true)}
          className={segment(cleaned)}
        >
          Cleaned
        </button>
      </div>

      <div
        className="relative flex h-28 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] p-2 md:h-36"
        style={CHECKERBOARD}
        data-testid="signature-upload-preview"
        data-view={cleaned ? 'cleaned' : 'original'}
        data-state={cleaned && working ? 'working' : noInk ? 'empty' : 'ready'}
        data-ink-for={cleaned ? inkFor : undefined}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={cleaned ? 'Your signature with the paper taken out' : 'Your picture as it is'}
          data-testid="signature-upload-canvas"
          className={cn('max-h-full max-w-full', noInk && 'hidden')}
        />
        {noInk && <p className="text-xs text-neutral-700">No ink found at this sensitivity.</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-3 text-sm text-[var(--color-text-primary)]">
          <span className="w-20 shrink-0">Sensitivity</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sensitivity}
            disabled={!cleaned}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            aria-describedby={sliderHint}
            data-testid="signature-sensitivity"
            className="h-6 min-w-0 flex-1 accent-[var(--color-primary)] disabled:opacity-50"
          />
        </label>
        <p id={sliderHint} className="text-xs text-[var(--color-text-secondary)]">
          {cleaned
            ? 'Shadows, lines or print behind the signature can leave marks: move left to drop them, right to keep faint ink.'
            : 'Choose Cleaned to take out the paper.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className={cn('flex items-center gap-2 text-sm text-[var(--color-text-primary)]', !cleaned && 'opacity-50')}>
          <input
            type="checkbox"
            checked={black}
            disabled={!cleaned}
            onChange={(e) => setBlack(e.target.checked)}
            data-testid="signature-ink-black"
            className="size-4 accent-[var(--color-primary)]"
          />
          Make ink black
        </label>
        <button
          type="button"
          onClick={() => {
            setPhoto(null);
            setInk(null);
          }}
          data-testid="signature-upload-replace"
          className="rounded px-1 text-xs text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text-primary)]"
        >
          Choose another picture
        </button>
      </div>
    </div>
  );
});

SignatureUpload.displayName = 'SignatureUpload';

export default SignatureUpload;
