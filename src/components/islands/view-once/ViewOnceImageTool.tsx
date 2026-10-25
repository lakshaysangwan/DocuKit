import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import ImageStage from '@/components/islands/workspace/ImageStage';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { loadImage, type LoadedImage } from '@/components/islands/workspace/load-image';
import { useMediaQuery } from '@/hooks/use-media-query';
import { validateFileSize, VIEW_ONCE_MAX_SIZE } from '@/lib/file-utils';
import { formatName, sniffImageMime } from '@/lib/compress-image';
import {
  DEFAULT_TTL,
  UUID,
  VIEW_ONCE_API,
  VIEW_ONCE_TTLS,
  VIEW_ONCE_TYPES,
  sealImage,
  shareLink,
  ttlLabel,
} from '@/lib/view-once';
import { formatBytes, cn } from '@/lib/utils';

/**
 * View-Once Image, in the shared workspace.
 *
 * The image is shown large; the controls choose when the link expires and say
 * exactly what is sent. "Create view-once link" encrypts the image in this
 * browser under a new random key, uploads only the ciphertext, and builds the
 * link with the key after the `#` (src/lib/view-once.ts). The action slot then
 * holds "Copy link", and the result pane shows the link and what it does.
 */

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];
const INPUTS = 'JPEG, PNG, WebP, GIF, AVIF, BMP';
const MAX = formatBytes(VIEW_ONCE_MAX_SIZE, 0);

interface Loaded {
  file: File;
  info: LoadedImage | null;
  mime: string | null;
  sniffed: boolean;
  failed: boolean;
}

interface Result {
  link: string;
  expiresAt: number;
  ttl: number;
  uploaded: number;
}

const px = (w: number, h: number) => `${w} × ${h} px`;

const choice = (on: boolean) =>
  cn(
    'h-9 rounded-lg border px-3 text-sm font-medium transition-colors',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)]',
  );

function expiryText(at: number) {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ViewOnceImageTool() {
  const [item, setItem] = useState<Loaded | null>(null);
  const [ttl, setTtl] = useState<number>(DEFAULT_TTL);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState<'encrypting' | 'uploading'>('encrypting');
  const [copyFailed, setCopyFailed] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
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
      const tooBig = validateFileSize(file, VIEW_ONCE_MAX_SIZE);
      if (tooBig) {
        toast.error(tooBig);
        return;
      }
      invalidate();
      forget();
      setCopyFailed(false);
      setItem({ file, info: null, mime: null, sniffed: false, failed: false });
      const same = (prev: Loaded | null) => prev?.file === file;
      file
        .slice(0, 64)
        .arrayBuffer()
        .then(
          (head) => {
            const sniffed = sniffImageMime(new Uint8Array(head));
            const mime = sniffed && VIEW_ONCE_TYPES[sniffed] ? sniffed : null;
            setItem((prev) => (same(prev) ? { ...prev!, mime, sniffed: true } : prev));
          },
          () => setItem((prev) => (same(prev) ? { ...prev!, sniffed: true } : prev)),
        );
      loadImage(file).then(
        (info) =>
          setItem((prev) => {
            if (!same(prev)) {
              URL.revokeObjectURL(info.url);
              return prev;
            }
            shown.current = info.url;
            return { ...prev!, info };
          }),
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

  /* ── The run ──────────────────────────────────────────────────────────── */

  const loading = !!item && (!item.sniffed || (!item.info && !item.failed));
  const unusable = !!item && !loading && (item.failed || !item.mime);
  const running = run.phase === 'running';
  const done = run.phase === 'done' && !!run.result;
  const result = run.result;

  const create = useCallback(() => {
    if (!item || loading || unusable || !item.mime) return;
    const { file, mime } = item;
    const seconds = ttl;
    setCopyFailed(false);
    void run.start(async () => {
      setStep('encrypting');
      setProgress(10);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sealed = await sealImage(new Uint8Array(await file.arrayBuffer()), mime);
      setStep('uploading');
      setProgress(50);
      let res: Response;
      try {
        res = await fetch(VIEW_ONCE_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-TTL': String(seconds) },
          body: sealed.cipher as BufferSource,
        });
      } catch {
        throw new Error('Could not reach docukit.uk to store the encrypted image. Check the connection and try again.');
      }
      if (!res.ok) {
        throw new Error(
          res.status === 413
            ? 'The server refused the image as too large.'
            : `The server did not store the encrypted image (error ${res.status}). Try again later.`,
        );
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown; expiresIn?: unknown } | null;
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!UUID.test(id)) throw new Error('The server gave an answer this page does not understand. Try again later.');
      const expiresIn = typeof body?.expiresIn === 'number' ? body.expiresIn : seconds;
      setProgress(100);
      return {
        link: shareLink(window.location.origin, id, sealed.fragment),
        expiresAt: Date.now() + expiresIn * 1000,
        ttl: expiresIn,
        uploaded: sealed.cipher.length,
      };
    });
  }, [item, loading, unusable, ttl, run]);

  const copy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.link);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
      linkRef.current?.focus();
      linkRef.current?.select();
      throw new Error('copy refused');
    }
  }, [result]);

  /* ── Stage ────────────────────────────────────────────────────────────── */

  const typeName = item?.mime ? formatName(item.mime) : null;
  let stageStatus = '';
  if (item) {
    if (loading) stageStatus = 'Reading the image…';
    else if (unusable)
      stageStatus = item.mime
        ? `${item.file.name} could not be shown, so it cannot be shared as an image.`
        : `${item.file.name} is not an image View-Once can share (${INPUTS}).`;
    else if (done) stageStatus = 'A link to this image is ready. It opens once.';
    else
      stageStatus = `Your image (${typeName}${item.info ? `, ${px(item.info.width, item.info.height)}` : ''}, ${formatBytes(
        item.file.size,
      )}). This is what the recipient will see, once.`;
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
  const size = item ? formatBytes(item.file.size) : '';

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={running}>
      <section className="flex flex-col gap-2" aria-labelledby="vo-ttl-heading">
        <h3 id="vo-ttl-heading" className={heading}>
          Link expires after
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="vo-ttl-heading">
          {VIEW_ONCE_TTLS.map((t) => (
            <button
              key={t.seconds}
              type="button"
              aria-pressed={ttl === t.seconds}
              data-testid={`ttl-${t.seconds}`}
              onClick={() => {
                invalidate();
                setTtl(t.seconds);
              }}
              className={choice(ttl === t.seconds)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className={note}>If nobody opens the link by then, the encrypted image is deleted from the server.</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="vo-sent-heading">
        <h3 id="vo-sent-heading" className={heading}>
          What leaves your browser
        </h3>
        <ul data-testid="upload-explainer" className="flex list-disc flex-col gap-1.5 pl-4 text-xs leading-5 text-[var(--color-text-secondary)]">
          <li>Your image is encrypted here, with a new random key (AES-256-GCM), before anything is sent.</li>
          <li>
            Sent to docukit.uk: the encrypted image (about {size}) and the expiry you chose. As with any website, the
            server also sees your connection&apos;s IP address.
          </li>
          <li>
            Not sent: the key, the image itself, its file name. The key is put in the link after the #, a part browsers
            never send to a server.
          </li>
          <li>The first time the link is opened, the encrypted image is handed over and deleted from the server.</li>
        </ul>
      </section>
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const resultPanel =
    done && result ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="result-panel">
        <section aria-labelledby="vo-link-heading" className="flex flex-col gap-2">
          <h3 id="vo-link-heading" className={heading}>
            <label htmlFor="view-once-link">Your view-once link</label>
          </h3>
          <input
            ref={linkRef}
            id="view-once-link"
            readOnly
            value={result.link}
            data-testid="share-link"
            onFocus={(e) => e.target.select()}
            className="h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 font-mono text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
          />
          {copyFailed && (
            <p data-testid="copy-failed" role="alert" className="text-xs font-medium text-[var(--color-error)]">
              This browser did not allow copying. The link is selected above: copy it with Ctrl+C (⌘C on a Mac), or
              press and hold it on a phone.
            </p>
          )}
          <ul data-testid="link-facts" className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-[var(--color-text-secondary)]">
            <li data-testid="fact-once">
              Opens once. The first time it is opened, the server hands over the encrypted image and deletes it; after
              that the link only says the image is gone.
            </li>
            <li data-testid="fact-expiry">
              If nobody opens it, it is deleted after {ttlLabel(result.ttl)} ({expiryText(result.expiresAt)}).
            </li>
            <li>
              The key is the part after the #: anyone who has the whole link can open the image, so send it only to the
              person it is for. They can still save or screenshot the image.
            </li>
            <li>This is the only time the link is shown. Copy it before you leave this page.</li>
            <li data-testid="fact-uploaded">
              Uploaded: {formatBytes(result.uploaded)} of encrypted data and the expiry. Not uploaded: the key, the image
              or its name.
            </li>
          </ul>
        </section>
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (loading) prompt = 'Reading your image…';
  else if (unusable) {
    prompt = `${item!.file.name} cannot be shared: choose a ${INPUTS} image up to ${MAX}.`;
    promptTone = 'error';
  } else if (running) prompt = step === 'uploading' ? 'Uploading the encrypted image…' : 'Encrypting your image…';
  else if (run.phase === 'error') {
    prompt = 'The link could not be made. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = 'Copy the link and send it to one person. It opens once.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) prompt = 'Open Options to choose when the link expires, then press Create view-once link.';
  else prompt = `Choose when the link expires ${beside}, then press Create view-once link.`;

  const disabledReason = loading
    ? 'Reading the image…'
    : unusable
      ? `${item!.file.name} is not an image this tool can share`
      : null;

  return (
    <ToolWorkspace
      toolId="view-once-image"
      active={!!item}
      empty={
        <DropZone accept={ACCEPTED} multiple={false} onFiles={openFile} hint={`${INPUTS} · up to ${MAX} · encrypted before upload`} />
      }
      title="Share this image once"
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
          label="Create view-once link"
          runningLabel={step === 'uploading' ? 'Uploading…' : 'Encrypting…'}
          onRun={create}
          disabledReason={disabledReason}
          hint={`Encrypts the image here, uploads only the encrypted bytes, and gives you a link that opens once within ${ttlLabel(ttl)}.`}
          progress={progress}
          progressLabel={step === 'uploading' ? 'Uploading the encrypted image' : 'Encrypting'}
          // No Cancel: once the upload has started the image is stored, and a
          // cancelled run would leave it there with no link to it.
          download={
            result
              ? {
                  label: 'Copy link',
                  onDownload: copy,
                  ariaLabel: 'Copy the view-once link',
                  busyLabel: 'Copying…',
                  doneLabel: 'Link copied',
                  icon: <Link2 className="size-4" aria-hidden="true" />,
                }
              : undefined
          }
          summary={result ? `Link ready · opens once · expires in ${ttlLabel(result.ttl)}` : undefined}
          onEditAgain={invalidate}
          editAgainLabel="Make another link"
          error={run.error}
        />
      }
    />
  );
}
