import { useCallback, useEffect, useRef, useState } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import ImageStage from '@/components/islands/workspace/ImageStage';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { loadImage, type LoadedImage } from '@/components/islands/workspace/load-image';
import { useMediaQuery } from '@/hooks/use-media-query';
import { downloadBlob } from '@/lib/download';
import { formatName, sniffImageMime } from '@/lib/compress-image';
import {
  LOCK_ITERATIONS,
  LOCK_SHOWN_EVERYWHERE,
  LOCK_TYPES,
  buildLockedHtml,
  lockImage,
  lockedFileName,
  passwordStrength,
} from '@/lib/lock-image';
import { formatBytes, cn } from '@/lib/utils';

/**
 * Lock Image, in the shared workspace.
 *
 * The image is shown large; the controls take a password (twice). "Lock image"
 * encrypts the file's own bytes in this browser (AES-256-GCM, key from the
 * password by PBKDF2-SHA-256) and wraps them in one HTML file that asks for the
 * password and shows the image again (src/lib/lock-image.ts). Nothing is
 * uploaded. The download replaces the action; the result pane says what the
 * file is and how it is opened.
 */

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/heic', 'image/heif'];
const INPUTS = 'JPEG, PNG, WebP, GIF, AVIF, BMP, HEIC';
const ROUNDS = LOCK_ITERATIONS.toLocaleString('en-US');

const STRENGTH_COLOUR = ['#DC2626', '#EA580C', '#CA8A04', '#16A34A', '#15803D'];

interface Loaded {
  file: File;
  info: LoadedImage | null;
  /** The real format, from the first bytes; null until read, or if it is not one Lock Image takes. */
  mime: string | null;
  sniffed: boolean;
  failed: boolean;
}

interface Result {
  name: string;
  blob: Blob;
  mime: string;
  imageBytes: number;
}

const px = (w: number, h: number) => `${w} × ${h} px`;

export default function LockImageTool() {
  const [item, setItem] = useState<Loaded | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const run = useToolRun<Result>();
  const { invalidate } = run;

  /* ── File ─────────────────────────────────────────────────────────────── */

  const shown = useRef<string | null>(null);
  const forget = () => {
    if (shown.current) URL.revokeObjectURL(shown.current);
    shown.current = null;
  };
  useEffect(() => forget, []);

  const openFile = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;
      invalidate();
      forget();
      setItem({ file, info: null, mime: null, sniffed: false, failed: false });
      const same = (prev: Loaded | null) => prev?.file === file;
      file
        .slice(0, 64)
        .arrayBuffer()
        .then(
          (head) => {
            const sniffed = sniffImageMime(new Uint8Array(head));
            const mime = sniffed && LOCK_TYPES[sniffed] ? sniffed : null;
            setItem((prev) => (same(prev) ? { ...prev!, mime, sniffed: true } : prev));
          },
          () => setItem((prev) => (same(prev) ? { ...prev!, sniffed: true } : prev)),
        );
      loadImage(file).then(
        (info) => {
          setItem((prev) => {
            if (!same(prev)) {
              URL.revokeObjectURL(info.url);
              return prev;
            }
            shown.current = info.url;
            return { ...prev!, info };
          });
        },
        () => setItem((prev) => (same(prev) ? { ...prev!, failed: true } : prev)),
      );
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    forget();
    setItem(null);
  }, [invalidate]);

  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      invalidate();
      set(value);
    };

  /* ── The run ──────────────────────────────────────────────────────────── */

  const loading = !!item && (!item.sniffed || (!item.info && !item.failed));
  const unusable = !!item && !loading && (item.failed || !item.mime);
  const mismatch = !!password && !!confirm && password !== confirm;
  const running = run.phase === 'running';
  const done = run.phase === 'done' && !!run.result;
  const result = run.result;

  const lock = useCallback(() => {
    if (!item || loading || unusable || !password || password !== confirm || !item.mime) return;
    const { file, mime } = item;
    const pw = password;
    void run.start(async () => {
      setProgress(10);
      // Let "Locking…" paint before the key derivation takes the CPU.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const bytes = new Uint8Array(await file.arrayBuffer());
      setProgress(30);
      const locked = await lockImage(bytes, mime, pw);
      setProgress(90);
      const html = buildLockedHtml(locked);
      setProgress(100);
      return { name: lockedFileName(file.name), blob: new Blob([html], { type: 'text/html' }), mime, imageBytes: file.size };
    });
  }, [item, loading, unusable, password, confirm, run]);

  /* ── Stage ────────────────────────────────────────────────────────────── */

  const typeName = item?.mime ? formatName(item.mime) : null;
  let stageStatus = '';
  if (item) {
    if (loading) stageStatus = 'Reading the image…';
    else if (unusable)
      stageStatus = item.mime
        ? `${item.file.name} could not be shown, so it cannot be checked as an image.`
        : `${item.file.name} is not an image Lock Image can lock (${INPUTS}).`;
    else if (done && result)
      stageStatus = `Locked into ${result.name}. Unlocking it gives back this image, byte for byte.`;
    else
      stageStatus = `Your image (${typeName}${item.info ? `, ${px(item.info.width, item.info.height)}` : ''}, ${formatBytes(
        item.file.size,
      )}). It is locked exactly as it is: the same file comes out when it is unlocked.`;
  }

  const stage = item ? (
    <ImageStage
      src={item.info?.url ?? null}
      alt={`Your image: ${item.file.name}`}
      naturalWidth={item.info?.width ?? 0}
      naturalHeight={item.info?.height ?? 0}
      beforeLabel={typeName ? `Your image (${typeName})` : 'Your image'}
      placeholder={item.failed ? 'This file could not be shown as an image' : 'Reading the image…'}
      footer={
        <p data-testid="stage-status" aria-live="polite" className="line-clamp-2 text-xs text-[var(--color-text-secondary)]">
          {stageStatus}
        </p>
      }
    />
  ) : null;

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
  const note = 'text-xs leading-5 text-[var(--color-text-secondary)]';
  const field =
    'h-11 w-full rounded-lg border bg-[var(--color-background)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]';
  const strength = passwordStrength(password);
  const stem = item ? lockedFileName(item.file.name) : 'image-locked.html';
  const opensEverywhere = !item?.mime || LOCK_SHOWN_EVERYWHERE.includes(item.mime);

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={running}>
      <section className="flex flex-col gap-3" aria-labelledby="li-password-heading">
        <h3 id="li-password-heading" className={heading}>
          Choose a password
        </h3>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lock-password" className="text-sm font-medium text-[var(--color-text-primary)]">
            Password
          </label>
          <input
            id="lock-password"
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => change(setPassword)(e.target.value)}
            autoComplete="new-password"
            data-testid="password"
            className={cn(field, 'border-[var(--color-border)]')}
          />
          {password && (
            <div className="flex items-center gap-2" data-testid="password-strength" data-score={strength.score}>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]" aria-hidden="true">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${((strength.score + 1) / 5) * 100}%`, backgroundColor: STRENGTH_COLOUR[strength.score] }}
                />
              </div>
              <span className="shrink-0 text-xs font-medium text-[var(--color-text-secondary)]">{strength.label}</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lock-confirm-password" className="text-sm font-medium text-[var(--color-text-primary)]">
            Confirm password
          </label>
          <input
            id="lock-confirm-password"
            type={show ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => change(setConfirm)(e.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'lock-mismatch' : undefined}
            data-testid="confirm-password"
            className={cn(field, mismatch ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]')}
          />
          {mismatch && (
            <p id="lock-mismatch" data-testid="password-mismatch" className="text-xs font-medium text-[var(--color-error)]">
              The two passwords do not match.
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
          <input
            type="checkbox"
            checked={show}
            onChange={(e) => setShow(e.target.checked)}
            data-testid="show-password"
            className="size-4 accent-[var(--color-primary)]"
          />
          Show passwords
        </label>
        <p className={note}>
          A forgotten password cannot be recovered. Anyone who has the file can try passwords on it for as long as they
          like, so a long password of several words is safest. The strength bar only counts length and kinds of
          character; it cannot tell whether a password is a common one.
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="li-what-heading">
        <h3 id="li-what-heading" className={heading}>
          What you get
        </h3>
        <ul data-testid="lock-explainer" className="flex list-disc flex-col gap-1.5 pl-4 text-xs leading-5 text-[var(--color-text-secondary)]">
          <li>
            One HTML file, <span className="font-medium text-[var(--color-text-primary)]">{stem}</span>, with your image
            inside it encrypted with AES-256-GCM. The key is made from the password with PBKDF2-SHA-256 ({ROUNDS} rounds).
          </li>
          <li>
            To see the image, open the file in a web browser (Chrome, Edge, Firefox or Safari) and type the password. It
            works offline and contacts nothing, docukit.uk included.
          </li>
          <li>
            The image is locked as it is: same bytes, same size. Anything inside it, such as camera details or location,
            is locked with it and is there again once it is unlocked.
          </li>
          {!opensEverywhere && (
            <li data-testid="heic-note">
              Most browsers other than Safari cannot show HEIC. The unlocked page then offers the image to save instead.
            </li>
          )}
          <li>Nothing is uploaded: the image is encrypted in this browser.</li>
        </ul>
      </section>
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const resultPanel =
    done && result ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="result-panel">
        <section aria-labelledby="li-result-heading" className="flex flex-col gap-1.5">
          <h3 id="li-result-heading" className={heading} data-testid="facts-heading">
            {result.name}
          </h3>
          <ul data-testid="lock-facts" className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-[var(--color-text-secondary)]">
            <li>
              Holds your {formatName(result.mime)} image ({formatBytes(result.imageBytes)}), encrypted. The file is{' '}
              {formatBytes(result.blob.size)}: the encrypted image is stored as text, which makes it about a third larger.
            </li>
            <li>
              To open it: open the file in a web browser, type the password and press Unlock image. Save image then gives
              back the original file.
            </li>
            <li>Send the password some other way than the file, not in the same email or chat.</li>
            <li>A preview inside a mail or chat app may not run it: save the file first, then open it.</li>
          </ul>
        </section>
        <NextStep href="/view-once-image/" label="View-Once Image">
          Want a link that opens only once instead?
        </NextStep>
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (loading) prompt = 'Reading your image…';
  else if (unusable) {
    prompt = `${item!.file.name} cannot be locked: choose a ${INPUTS} image.`;
    promptTone = 'error';
  } else if (running) prompt = 'Locking your image…';
  else if (run.phase === 'error') {
    prompt = 'The image could not be locked. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = 'Download the locked file, then send it, and tell the recipient the password another way.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) prompt = 'Open Options to choose a password, then press Lock image.';
  else if (!password || !confirm) prompt = `Type a password twice ${beside}, then press Lock image.`;
  else if (mismatch) {
    prompt = 'The passwords do not match: type the same password in both fields.';
    promptTone = 'error';
  } else prompt = 'Press Lock image to make the locked file.';

  const disabledReason = loading
    ? 'Reading the image…'
    : unusable
      ? `${item!.file.name} is not an image this tool can lock`
      : !password
        ? 'Type a password to lock the image with'
        : !confirm
          ? 'Type the password again to confirm it'
          : mismatch
            ? 'The two passwords do not match'
            : null;

  return (
    <ToolWorkspace
      toolId="lock-image"
      active={!!item}
      empty={<DropZone accept={ACCEPTED} multiple={false} onFiles={openFile} hint={`${INPUTS} · encrypted in your browser`} />}
      title="Lock this image"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        item ? (
          <WorkspaceFileBar
            file={item.file}
            extra={item.info ? `${typeName ? `${typeName} · ` : ''}${px(item.info.width, item.info.height)}` : undefined}
            onRemove={removeFile}
            onReplace={openFile}
            accept={ACCEPTED}
            disabled={running}
          />
        ) : null
      }
      stage={stage}
      controls={controls}
      result={resultPanel}
      action={
        <ActionBar
          phase={run.phase}
          label="Lock image"
          runningLabel="Locking…"
          onRun={lock}
          disabledReason={disabledReason}
          hint={`Makes ${stem}: your image encrypted, opened with the password.`}
          progress={progress}
          progressLabel="Locking"
          onCancel={run.cancel}
          download={
            result
              ? {
                  label: 'Download',
                  onDownload: () => downloadBlob(result.blob, result.name),
                  ariaLabel: `Download ${result.name}`,
                }
              : undefined
          }
          summary={result ? `${result.name} · ${formatBytes(result.blob.size)}` : undefined}
          onEditAgain={invalidate}
          error={run.error}
        />
      }
    />
  );
}
