import { useEffect, useMemo, useState, type ReactNode } from 'react';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import { createZipAndDownload } from '@/lib/download';
import {
  DIRECT_DOWNLOAD_LIMIT,
  canSaveToFolder,
  canShareFiles,
  saveToFolder,
  shareFiles,
  startDownload,
  startDownloads,
  type OutputFile,
} from '@/lib/multi-download';
import { formatBytes } from '@/lib/utils';

export interface MultiFile extends OutputFile {
  /** Short human label for the card, e.g. "Page 3". Falls back to the file name. */
  label?: string;
  /** Pixel size, shown on the card when both are given. */
  width?: number;
  height?: number;
}

interface MultiFileDownloadProps {
  /**
   * The output files, in the order they should be listed. Names must be unique —
   * they are the ZIP entry names and the file names written to a folder. Pass a
   * stable array: a new array identity is treated as a new result.
   */
  files: MultiFile[];
  /** File name of the ZIP, e.g. "report-images.zip". */
  zipName: string;
  /** What one file is called in labels. Defaults to file/files. */
  noun?: { one: string; other: string };
  /** Show each file as an image thumbnail (only for image outputs). */
  preview?: boolean;
  /** Accessible name of the result list, e.g. "Converted images". */
  listLabel?: string;
  /** Most files offered as separate downloads before the ZIP becomes primary. */
  directLimit?: number;
  /** Where the folder picker opens, e.g. "pictures" or "downloads". */
  folderStartIn?: string;
  /**
   * The tool's own action button. It is rendered first in the primary row so it
   * keeps its place (and its DOM node) whether or not there is a result yet.
   */
  children?: ReactNode;
}

type Busy = null | 'primary' | 'zip' | 'folder' | 'share';
interface StatusMessage { for: MultiFile[]; text: string }

const secondaryButton =
  'inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium ' +
  'text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

/**
 * One object URL per output blob, for thumbnails. The <img> reads the output
 * itself, so no second copy of the pixels is kept in JS; the URLs are revoked
 * as soon as the result changes, is cleared, or the component unmounts.
 */
function useObjectUrls(files: MultiFile[], enabled: boolean): string[] {
  const [entry, setEntry] = useState<{ for: MultiFile[]; urls: string[] } | null>(null);
  useEffect(() => {
    if (!enabled || files.length === 0) return;
    const urls = files.map((f) => URL.createObjectURL(f.blob));
    setEntry({ for: files, urls });
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [files, enabled]);
  return entry && entry.for === files ? entry.urls : [];
}

/**
 * Hands over a tool's output files: one image downloads as itself, a few
 * download as separate files from one click, and many fall back to a ZIP —
 * with a ZIP, a folder save and the share sheet offered as secondary routes
 * wherever the browser supports them, and a per-file Download on every card.
 *
 * Layout contract: the primary row comes first and nothing is ever inserted
 * above it. The status line below it has its height reserved, so messages
 * appearing after a click move neither the buttons nor the cards.
 */
export default function MultiFileDownload({
  files,
  zipName,
  noun = { one: 'file', other: 'files' },
  preview = false,
  listLabel = 'Output files',
  directLimit = DIRECT_DOWNLOAD_LIMIT,
  folderStartIn,
  children,
}: MultiFileDownloadProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const urls = useObjectUrls(files, preview);

  const n = files.length;
  const count = (k: number) => `${k} ${k === 1 ? noun.one : noun.other}`;
  const mode: 'single' | 'direct' | 'zip' = n === 1 ? 'single' : n <= directLimit ? 'direct' : 'zip';

  // Both are browser capabilities, read only once a result exists — which is
  // always after hydration, so the server-rendered markup never depends on them.
  const folderOk = useMemo(() => n > 1 && canSaveToFolder(), [n]);
  const shareOk = useMemo(() => canShareFiles(files), [files]);

  const say = (text: string) => setMessage({ for: files, text });
  const status = message && message.for === files ? message.text : '';

  const downloadZip = async () => {
    await createZipAndDownload(files.map((f) => ({ name: f.name, buffer: f.blob })), zipName);
    say(`ZIP download started: ${zipName} (${count(n)}).`);
  };

  const run = async (kind: Exclude<Busy, null>, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await task();
    } catch {
      say(`That did not work. ${n > 1 ? 'Try Download as ZIP, or the' : 'Try the'} Download button on the ${noun.one} below.`);
    } finally {
      setBusy(null);
    }
  };

  const handlePrimary = () => run('primary', async () => {
    if (mode === 'single') {
      startDownload(files[0]);
      say(`Download started: ${files[0].name}.`);
    } else if (mode === 'direct') {
      const started = await startDownloads(files, (k) => say(`Starting download ${k} of ${n}…`));
      // A page cannot see whether a download was kept, so this reports what
      // was started and says plainly what to do if the browser dropped some.
      say(`Started ${started} downloads. If fewer than ${started} arrived, your browser blocked the rest — use Download as ZIP.`);
    } else {
      await downloadZip();
    }
  });

  const handleFolder = () => run('folder', async () => {
    const result = await saveToFolder(files, (done, folder) => say(`Saving ${done} of ${n} to ${folder}…`), folderStartIn);
    if (result.status === 'cancelled') {
      say('No folder was chosen, so nothing was saved.');
    } else if (result.status === 'unavailable') {
      say('The browser would not open a folder here. Use Download as ZIP instead.');
    } else if (result.failed.length === 0) {
      say(`${count(result.saved)} saved to ${result.folderName}.`);
    } else {
      say(`${result.saved} of ${count(n)} saved to ${result.folderName}. ${result.failed.length} could not be written — use Download as ZIP for the rest.`);
    }
  });

  const handleShare = () => run('share', async () => {
    const result = await shareFiles(files);
    if (result === 'shared') say(`${count(n)} handed to the share sheet.`);
    else if (result === 'cancelled') say('Sharing was cancelled, so nothing was sent.');
    else say(`Your browser would not share ${n === 1 ? `this ${noun.one}` : `these ${noun.other}`}. Use the download buttons instead.`);
  });

  const handleOne = (file: MultiFile) => {
    startDownload(file);
    say(`Download started: ${file.name}.`);
  };

  const primaryLabel =
    mode === 'single' ? `Download ${noun.one}`
      : mode === 'direct' ? `Download all (${count(n)})`
        : `Download ZIP (${count(n)})`;

  return (
    <div className="flex flex-col gap-3" data-testid="multi-download" data-mode={n > 0 ? mode : 'empty'}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {children}
        {n > 0 && (
          <DownloadButton
            onClick={handlePrimary}
            label={primaryLabel}
            ariaLabel={mode === 'single' ? `Download ${noun.one} ${files[0].name}` : mode === 'zip' ? `${primaryLabel}: ${zipName}` : undefined}
            busyLabel={mode === 'direct' ? 'Starting downloads…' : 'Preparing…'}
            doneLabel={mode === 'direct' ? 'Downloads started' : 'Download started'}
            disabled={busy !== null && busy !== 'primary'}
          />
        )}
      </div>

      {n > 0 && (
        <>
          {(mode === 'direct' || folderOk || shareOk) && (
            <div className="flex flex-wrap gap-2 sm:justify-end" data-testid="download-options">
              {mode === 'direct' && (
                <button type="button" onClick={() => run('zip', downloadZip)} disabled={busy !== null}
                  data-testid="download-zip" aria-label={`Download as ZIP: ${zipName}`} className={secondaryButton}>
                  {busy === 'zip' ? 'Preparing ZIP…' : 'Download as ZIP'}
                </button>
              )}
              {folderOk && (
                <button type="button" onClick={handleFolder} disabled={busy !== null}
                  data-testid="save-to-folder" className={secondaryButton}>
                  Save to a folder…
                </button>
              )}
              {shareOk && (
                <button type="button" onClick={handleShare} disabled={busy !== null}
                  data-testid="share-files" className={secondaryButton}>
                  Share or save {n === 1 ? noun.one : noun.other}…
                </button>
              )}
            </div>
          )}

          {mode !== 'single' && (
            <p data-testid="download-helper" className="text-xs leading-5 text-[var(--color-text-secondary)] sm:text-right">
              {mode === 'direct'
                ? `Download all saves ${count(n)} as separate files. Your browser may ask once to allow several downloads from this site — if it blocks them, Download as ZIP gives you everything in one file.`
                : `${count(n)} is more than browsers reliably save one by one, so they come as one ZIP. Each ${noun.one} below also has its own Download button.`}
            </p>
          )}

          {/* Height reserved for the longest message at the narrowest width, so a
              message appearing never moves the buttons above or the cards below. */}
          <p role="status" aria-live="polite" data-testid="download-status"
            className="min-h-[3.75rem] text-xs leading-5 font-medium text-[var(--color-text-primary)] sm:min-h-10 sm:text-right">
            {status}
          </p>

          <section aria-label={listLabel} data-testid="result-gallery"
            className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-3 sm:p-4">
            <p className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">{count(n)} ready</p>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {files.map((file, i) => (
                <li key={file.name} data-testid="result-card"
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-2">
                  {preview && (
                    <div className="flex h-36 items-center justify-center overflow-hidden rounded bg-[var(--color-surface)]">
                      {urls[i] && (
                        <img src={urls[i]} alt={`Preview of ${file.name}`} loading="lazy" decoding="async"
                          data-testid="result-thumb" className="max-h-full max-w-full object-contain" />
                      )}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    {file.label && <p className="text-sm font-medium text-[var(--color-text-primary)]">{file.label}</p>}
                    <p data-testid="result-name" className="break-all text-xs text-[var(--color-text-secondary)]">{file.name}</p>
                    <p data-testid="result-meta" className="text-xs text-[var(--color-text-secondary)] tabular-nums">
                      {file.width && file.height ? `${file.width} × ${file.height} px · ` : ''}{formatBytes(file.blob.size)}
                    </p>
                  </div>
                  <button type="button" onClick={() => handleOne(file)} data-testid="result-download"
                    aria-label={`Download ${file.name}`} className={`${secondaryButton} w-full`}>
                    Download
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
