import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import MultiFileDownload, { useMultiFileDownload, type MultiFile } from '@/components/islands/shared/MultiFileDownload';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import ImageStage from '@/components/islands/workspace/ImageStage';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { CONVERT_PREVIEW, useImagePreview } from '@/components/islands/workspace/use-image-preview';
import { displayUrlFor, loadImage, type LoadedImage } from '@/components/islands/workspace/load-image';
import { useMediaQuery } from '@/hooks/use-media-query';
import { downloadBlob } from '@/lib/download';
import { canPreviewLive, formatName, hasQuality, sniffImageMime, uniqueNames } from '@/lib/compress-image';
import {
  CONVERT_FORMATS,
  CONVERT_LABEL,
  DEFAULT_QUALITY,
  buildConvertFacts,
  convertedFileName,
  type ConvertFacts,
  type ConvertFormat,
} from '@/lib/convert-image';
import type { ConvertImageOptions, ConvertImageStats } from '@/types/worker-messages';
import { formatBytes, generateId, cn } from '@/lib/utils';

/**
 * Convert Image, in the shared workspace.
 *
 * The image is shown large on a checkerboard (so transparency shows), at Fit,
 * 100% or 200%. For JPG and WebP at a normal size, choosing the format or
 * moving the quality slider converts the shown image (debounced, latest wins)
 * so Original vs Converted updates as you go; AVIF, PNG and large images wait
 * for "Preview". After the run the stage compares the original with the file
 * that downloads, and the facts beside it are read from that file.
 *
 * Several images: a strip above the stage chooses which is shown; every image
 * is converted to the same format, and the results are handed over with
 * `MultiFileDownload` (separate files, a folder, or one ZIP).
 */

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif'];
const INPUTS = 'JPEG, PNG, WebP, AVIF, HEIC, GIF, BMP';
const NO_FILES: MultiFile[] = [];

const FORMAT_NOTE: Record<ConvertFormat, string> = {
  jpeg: 'JPG cannot store transparency: transparent areas become white. Smallest for photos, and opens everywhere.',
  png: 'PNG is lossless: every pixel is kept, so there is no quality to choose. Keeps transparency. For photos it is usually much larger than JPG or WebP.',
  webp: 'WebP keeps transparency and is usually smaller than JPG or PNG. Most current apps open it; some older ones do not.',
  avif: 'AVIF keeps transparency and is often the smallest, but it is slow to encode and older apps may not open it.',
};

interface Item {
  id: string;
  file: File;
  info: LoadedImage | null;
  /** The real format, from the file's first bytes. */
  mime: string | null;
  failed: boolean;
}

interface Output {
  itemId: string;
  name: string;
  blob: Blob;
  url: string;
  stats: ConvertImageStats;
  originalBytes: number;
  facts: ConvertFacts;
}

interface RunResult {
  outputs: Output[];
  files: MultiFile[];
}

interface ConvertImageToolProps {
  /** Pre-selected output format — set by the format-specific task pages. */
  initialFormat?: ConvertFormat;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const px = (w: number, h: number) => `${w} × ${h} px`;

const choice = (on: boolean) =>
  cn(
    'h-9 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)]',
  );

function FactList({ facts, testId }: { facts: ConvertFacts; testId: string }) {
  return (
    <ul data-testid={testId} className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
      {facts.facts.map((f) => (
        <li
          key={f.key}
          data-testid={`fact-${f.key}`}
          className={cn(f.key === 'transparency' && 'font-medium text-[var(--color-text-primary)]')}
        >
          {f.text}
        </li>
      ))}
    </ul>
  );
}

export default function ConvertImageTool({ initialFormat = 'webp' }: ConvertImageToolProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState(0);
  const [format, setFormat] = useState<ConvertFormat>(initialFormat);
  const [quality, setQuality] = useState(DEFAULT_QUALITY);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [step, setStep] = useState({ index: 0, count: 1 });
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const run = useToolRun<RunResult>();
  const { invalidate } = run;

  const active = items.length > 0;
  const batch = items.length > 1;
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const item = items[index] ?? null;
  const label = CONVERT_LABEL[format];
  const lossy = hasQuality(format);

  const options = useMemo<ConvertImageOptions>(
    () => ({ format, quality: lossy ? quality : undefined }),
    [format, lossy, quality],
  );

  /* ── Files ────────────────────────────────────────────────────────────── */

  // Object URLs of the images on screen, revoked when an image leaves.
  const urls = useRef(new Map<string, string>());
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const read = useCallback((added: Item[]) => {
    for (const it of added) {
      it.file
        .slice(0, 64)
        .arrayBuffer()
        .then((head) => {
          const mime = sniffImageMime(new Uint8Array(head));
          setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, mime } : p)));
        })
        .catch(() => {});
      loadImage(it.file).then(
        (info) => {
          urls.current.set(it.id, info.url);
          setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, info } : p)));
        },
        () => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, failed: true } : p))),
      );
    }
  }, []);

  const drop = useCallback((gone: Item[]) => {
    for (const it of gone) {
      const url = urls.current.get(it.id);
      if (url) URL.revokeObjectURL(url);
      urls.current.delete(it.id);
    }
  }, []);

  const newItems = (files: File[]): Item[] =>
    files.map((file) => ({ id: generateId(), file, info: null, mime: null, failed: false }));

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      invalidate();
      const added = newItems(files);
      setItems((prev) => {
        if (prev.length === 0) setSelected(0);
        return [...prev, ...added];
      });
      read(added);
    },
    [invalidate, read],
  );

  const replaceFile = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      invalidate();
      const added = newItems(files);
      setItems((prev) => {
        drop(prev);
        return added;
      });
      setSelected(0);
      read(added);
    },
    [invalidate, read, drop],
  );

  const removeAll = useCallback(() => {
    invalidate();
    setItems((prev) => {
      drop(prev);
      return [];
    });
    setSelected(0);
  }, [invalidate, drop]);

  const removeOne = useCallback(
    (id: string) => {
      invalidate();
      setItems((prev) => {
        drop(prev.filter((p) => p.id === id));
        return prev.filter((p) => p.id !== id);
      });
    },
    [invalidate, drop],
  );

  /** Wrap a setter so any change makes the result stale. */
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      invalidate();
      set(value);
    };

  /* ── Preview ──────────────────────────────────────────────────────────── */

  const pixels = item?.info ? item.info.width * item.info.height : 0;
  const live = canPreviewLive(format, pixels);
  const running = run.phase === 'running';
  const done = run.phase === 'done' && !!run.result;
  const preview = useImagePreview({
    spec: CONVERT_PREVIEW,
    item: item?.info ? { id: item.id, file: item.file } : null,
    options,
    live,
    paused: running || done,
  });
  const previewFacts = preview.shown ? buildConvertFacts(item!.file.size, preview.shown.blob.size, preview.shown.stats) : null;

  /* ── The run ──────────────────────────────────────────────────────────── */

  const loading = items.some((it) => !it.info && !it.failed);
  const anyFailed = items.find((it) => it.failed);

  const convert = useCallback(() => {
    if (!active || loading || anyFailed) return;
    const used = options;
    const list = items;
    void run.start(async (work) => {
      // Let "Converting…" paint, even when every image's preview can be reused.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const outputs: Output[] = [];
      const cleanup = () => outputs.forEach((o) => URL.revokeObjectURL(o.url));
      for (const [i, it] of list.entries()) {
        setStep({ index: i, count: list.length });
        let blob: Blob;
        let stats: ConvertImageStats;
        // The preview of this image at these settings is the same pass: reuse its bytes.
        const cached = preview.lookup(it.id, used);
        if (cached) {
          blob = cached.blob;
          stats = cached.stats;
        } else {
          const buffer = await it.file.arrayBuffer();
          const response = await work(
            'image',
            { op: 'convert-image', buffer, mimeType: it.file.type, options: used, progressPort: undefined as never },
            [buffer],
          );
          if (!response) {
            cleanup();
            return null;
          }
          if (response.status === 'error') {
            cleanup();
            throw new Error(`${it.file.name} could not be converted: ${response.message}`);
          }
          if (response.status !== 'success' || !response.stats?.convert) {
            cleanup();
            throw new Error(`${it.file.name} could not be converted.`);
          }
          stats = response.stats.convert;
          blob = new Blob([response.result], { type: stats.mime });
        }
        outputs.push({
          itemId: it.id,
          name: convertedFileName(it.file.name, stats.mime),
          blob,
          url: await displayUrlFor(blob),
          stats,
          originalBytes: it.file.size,
          facts: buildConvertFacts(it.file.size, blob.size, stats),
        });
      }
      const names = uniqueNames(outputs.map((o) => o.name));
      outputs.forEach((o, i) => (o.name = names[i]));
      return {
        outputs,
        files: outputs.map((o) => ({ name: o.name, blob: o.blob, width: o.stats.width, height: o.stats.height })),
      };
    });
  }, [active, loading, anyFailed, options, items, run, preview]);

  // The outputs' object URLs live as long as the result.
  const result = run.result;
  useEffect(() => {
    if (!result) return;
    return () => {
      for (const o of result.outputs) URL.revokeObjectURL(o.url);
    };
  }, [result]);

  const resultFiles = result?.files ?? NO_FILES;
  const downloads = useMultiFileDownload({
    files: resultFiles,
    zipName: 'converted-images.zip',
    noun: { one: 'image', other: 'images' },
    folderStartIn: 'pictures',
  });

  const output = done ? result!.outputs.find((o) => o.itemId === item?.id) ?? null : null;

  /* ── Stage ────────────────────────────────────────────────────────────── */

  const as = lossy ? `${label} at quality ${quality}` : `a lossless ${label}`;
  let source: 'original' | 'preview' | 'output' = 'original';
  let stageStatus: string;
  if (!item) stageStatus = '';
  else if (item.failed) stageStatus = `${item.file.name} could not be read as an image.`;
  else if (!item.info) stageStatus = 'Reading the image…';
  else if (running) stageStatus = batch ? `Converting ${step.index + 1} of ${step.count}…` : 'Converting…';
  else if (output) {
    source = 'output';
    stageStatus = `${output.name}: ${output.facts.outcome} · ${px(output.stats.width, output.stats.height)} · ${formatBytes(output.blob.size)}`;
  } else if (preview.status === 'ready' && previewFacts) {
    source = 'preview';
    stageStatus = `Preview as ${as}: ${formatBytes(item.file.size)} → ${formatBytes(preview.shown!.blob.size)}`;
  } else if (preview.status === 'working') {
    source = preview.shown ? 'preview' : 'original';
    stageStatus = `Making the preview as ${as}…`;
  } else if (preview.status === 'error') stageStatus = `The preview could not be made: ${preview.error}`;
  else
    stageStatus = `Your original${item.mime ? ` (${formatName(item.mime)})` : ''}. Press Preview to see it as ${as}${
      format === 'avif' ? ' (AVIF is slow to encode, so it waits to be asked)' : pixels > 12_000_000 ? ' (a large image, so it waits to be asked)' : ''
    }.`;

  const showPreviewButton = !!item?.info && !done && !running && !live;
  const afterSrc = output ? output.url : source === 'preview' ? (preview.shown?.url ?? null) : null;
  const afterMime = output ? output.stats.mime : preview.shown?.stats.mime;

  const stage = item ? (
    <ImageStage
      src={item.info?.url ?? null}
      alt={`Original: ${item.file.name}`}
      naturalWidth={item.info?.width ?? 0}
      naturalHeight={item.info?.height ?? 0}
      resultSrc={afterSrc}
      resultAlt={`Converted: ${item.file.name}`}
      beforeLabel={item.mime ? `Original (${formatName(item.mime)})` : 'Original'}
      afterLabel={afterMime ? `Converted (${formatName(afterMime)})` : 'Converted'}
      busy={!done && preview.status === 'working'}
      placeholder={item.failed ? 'This file could not be read as an image' : 'Reading the image…'}
      items={items.map((it) => ({ id: it.id, name: it.file.name, thumbSrc: it.info?.url ?? null }))}
      selected={index}
      onSelect={setSelected}
      footer={
        <div className="flex items-center gap-2">
          <p
            data-testid="stage-status"
            data-source={source}
            data-live={live ? 'true' : 'false'}
            data-preview={preview.status}
            aria-live="polite"
            className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]"
          >
            {stageStatus}
          </p>
          {showPreviewButton && (
            <button
              type="button"
              onClick={preview.request}
              disabled={preview.status === 'working' || preview.current}
              data-testid="preview-convert"
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {preview.status === 'working' ? 'Making preview…' : 'Preview'}
            </button>
          )}
        </div>
      }
    />
  ) : null;

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
  const note = 'text-xs leading-5 text-[var(--color-text-secondary)]';

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={running}>
      <section className="flex flex-col gap-2" aria-labelledby="cv-format-heading">
        <h3 id="cv-format-heading" className={heading}>
          Convert to
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Output format">
          {CONVERT_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={format === f}
              data-testid={`format-${f}`}
              onClick={() => change(setFormat)(f)}
              className={choice(format === f)}
            >
              {CONVERT_LABEL[f]}
            </button>
          ))}
        </div>
        <p data-testid="format-note" className={note}>
          {FORMAT_NOTE[format]}
        </p>
      </section>

      {lossy && (
        <section className="flex flex-col gap-1">
          <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
            <label htmlFor="cv-quality" className="text-sm font-semibold text-[var(--color-text-primary)]">
              Quality
            </label>
            <output htmlFor="cv-quality" className="tabular-nums" data-testid="quality-value">
              {quality}
            </output>
          </div>
          <input
            id="cv-quality"
            type="range"
            min={1}
            max={100}
            value={quality}
            onChange={(e) => change(setQuality)(Number(e.target.value))}
            className="w-full accent-[var(--color-primary)]"
          />
          <p className={note}>
            {live
              ? 'Lower is smaller with more visible loss. The comparison updates as you move it.'
              : 'Lower is smaller with more visible loss. Press Preview under the image to see it.'}
          </p>
        </section>
      )}

      {previewFacts && !done && (
        <section data-testid="preview-facts-section" aria-labelledby="cv-preview-heading" className="flex flex-col gap-1.5">
          <h3 id="cv-preview-heading" className={heading}>
            Preview{preview.current ? '' : ' (updating…)'}
          </h3>
          <FactList facts={previewFacts} testId="preview-facts" />
        </section>
      )}

      {batch && (
        <section className="flex flex-col gap-2" aria-labelledby="cv-files-heading">
          <h3 id="cv-files-heading" className={heading}>
            Images ({items.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {items.map((it, i) => (
              <li key={it.id} data-testid="file-row" className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-current={i === index ? 'true' : undefined}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded px-1 py-1 text-left',
                    i === index ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]',
                  )}
                >
                  {it.file.name}
                </button>
                <span className="shrink-0 tabular-nums text-[var(--color-text-secondary)]">
                  {it.mime ? `${formatName(it.mime)} · ` : ''}
                  {formatBytes(it.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeOne(it.id)}
                  aria-label={`Remove ${it.file.name}`}
                  data-testid="file-remove"
                  className="flex size-7 shrink-0 items-center justify-center rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DropZone accept={ACCEPTED} multiple onFiles={addFiles} compact compactLabel="Add images" hint={INPUTS} />

      <p className={note}>
        The pixel size is not changed. A GIF is converted as a still image (its first frame). Only the pixels are saved:
        EXIF and other metadata (camera, location, date) are not copied, and a photo is kept the way up it is shown.
      </p>
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const totalBefore = result ? result.outputs.reduce((s, o) => s + o.originalBytes, 0) : 0;
  const totalAfter = result ? result.outputs.reduce((s, o) => s + o.blob.size, 0) : 0;

  const resultPanel =
    done && result ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="result-panel">
        {output && (
          <section aria-labelledby="cv-facts-heading" className="flex flex-col gap-1.5">
            <h3 id="cv-facts-heading" className={heading} data-testid="facts-heading">
              {output.name}
            </h3>
            <FactList facts={output.facts} testId="image-facts" />
          </section>
        )}

        {batch && (
          <section aria-labelledby="cv-batch-heading" className="flex flex-col gap-1.5">
            <h3 id="cv-batch-heading" className={heading}>
              {plural(result.outputs.length, 'image')}: {formatBytes(totalBefore)} → {formatBytes(totalAfter)}
            </h3>
            <ul data-testid="batch-facts" className="flex flex-col gap-0.5 text-xs">
              {result.outputs.map((o, i) => (
                <li key={o.itemId}>
                  <button
                    type="button"
                    data-testid="batch-fact"
                    onClick={() => setSelected(i)}
                    aria-current={i === index ? 'true' : undefined}
                    className={cn(
                      'w-full rounded px-1 py-1 text-left',
                      i === index ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]',
                    )}
                  >
                    {o.name} · {formatBytes(o.originalBytes)} → {formatBytes(o.blob.size)}
                  </button>
                </li>
              ))}
            </ul>
            <MultiFileDownload
              files={resultFiles}
              zipName="converted-images.zip"
              noun={{ one: 'image', other: 'images' }}
              listLabel="Your converted images"
              folderStartIn="pictures"
              controller={downloads}
              hidePrimary
            />
          </section>
        )}

        <NextStep href="/compress-image/" label="Compress Image">
          Want a smaller file?
        </NextStep>
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const actionLabel = batch ? `Convert ${items.length} images to ${label}` : `Convert to ${label}`;
  const beside = wide ? 'on the right' : 'below';

  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (loading) prompt = batch ? 'Reading your images…' : 'Reading your image…';
  else if (anyFailed) {
    prompt = `${anyFailed.file.name} could not be read as an image. Remove it or choose another file.`;
    promptTone = 'error';
  } else if (running) prompt = batch ? 'Converting your images…' : 'Converting your image…';
  else if (run.phase === 'error') {
    prompt = 'The image could not be converted. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = batch
      ? 'Choose an image above to compare it with its original, then download them.'
      : 'Compare the converted image with your original, then download it.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) {
    prompt = `Open Options to choose the format${lossy ? ' and quality' : ''}, then press ${actionLabel}.`;
  } else if (live) {
    prompt = `Choose the format${lossy ? ' and quality' : ''} ${beside}; the comparison updates as you go. Then press ${actionLabel}.`;
  } else {
    prompt = `Choose the format ${beside}, press Preview to see the result, then press ${actionLabel}.`;
  }

  const hint = lossy
    ? `Saves ${batch ? 'each image as ' : 'a '}${label} at quality ${quality}, same pixel size.${format === 'jpeg' ? ' Transparent areas become white.' : ''}`
    : `Saves ${batch ? 'each image as ' : 'a '}lossless PNG, same pixel size.`;

  const disabledReason = loading
    ? 'Reading the image…'
    : anyFailed
      ? `${anyFailed.file.name} could not be read as an image`
      : null;

  const progress = Math.round(((step.index + run.progress / 100) / Math.max(1, step.count)) * 100);

  let summary: string | undefined;
  if (result && !batch && result.outputs[0]) {
    const o = result.outputs[0];
    summary = `${o.name} · ${formatBytes(o.blob.size)}`;
  } else if (result) {
    summary = `${plural(result.outputs.length, 'image')} · ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)}`;
  }

  const single = result && result.outputs.length === 1 ? result.outputs[0] : null;
  const download = single
    ? {
        label: 'Download',
        onDownload: () => downloadBlob(single.blob, single.name),
        ariaLabel: `Download ${single.name}`,
      }
    : {
        label: downloads.primaryLabel,
        onDownload: downloads.handlePrimary,
        ariaLabel: downloads.primaryAriaLabel,
        busyLabel: downloads.primaryBusyLabel,
        doneLabel: downloads.primaryDoneLabel,
      };

  return (
    <ToolWorkspace
      toolId="convert-image"
      active={active}
      empty={<DropZone accept={ACCEPTED} multiple onFiles={addFiles} hint={`${INPUTS} · single or batch`} />}
      title={batch ? 'Convert these images' : 'Convert this image'}
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        batch ? (
          <WorkspaceFileBar
            files={items.map((it) => it.file)}
            noun="image"
            onAdd={addFiles}
            onRemove={removeAll}
            accept={ACCEPTED}
            disabled={running}
          />
        ) : item ? (
          <WorkspaceFileBar
            file={item.file}
            extra={item.info ? `${item.mime ? `${formatName(item.mime)} · ` : ''}${px(item.info.width, item.info.height)}` : undefined}
            onRemove={removeAll}
            onReplace={replaceFile}
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
          label={actionLabel}
          runningLabel="Converting…"
          onRun={convert}
          disabledReason={disabledReason}
          hint={hint}
          progress={progress}
          progressLabel={batch ? `Converting ${step.index + 1} of ${step.count}` : run.progressLabel}
          onCancel={run.cancel}
          download={download}
          summary={summary}
          onEditAgain={invalidate}
          error={run.error}
        />
      }
    />
  );
}
