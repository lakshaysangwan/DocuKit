import { useRef } from 'react';
import { FileText, Files, X } from 'lucide-react';
import { useFileDrop } from '@/hooks/use-file-drop';
import { formatBytes, isLargeFile } from '@/lib/utils';

interface WorkspaceFileBarProps {
  /** The one file the tool works on. Give this or `files`. */
  file?: File;
  /**
   * Several files that become one document. The bar then shows how many there
   * are and their total size instead of a name.
   */
  files?: File[];
  /** With `files`: what one of them is called — "image". Defaults to "file". */
  noun?: string;
  /**
   * With `files`: offer "Add images". The button is shown on phones, where the
   * options (and the dropzone in them) are closed; the input is always there
   * and is the first file input in the workspace.
   */
  onAdd?: (files: File[]) => void;
  /** Extra facts after the size: "3 pages". */
  extra?: string;
  /** Leave the workspace and go back to the dropzone. */
  onRemove?: () => void;
  /**
   * Offer "Change file". Called with the new file once it has passed the same
   * type and size checks as the dropzone.
   */
  onReplace?: (files: File[]) => void;
  /** MIME types "Change file" / "Add" accepts. Required with `onReplace` or `onAdd`. */
  accept?: string[];
  disabled?: boolean;
}

/**
 * The file the workspace is working on: name, size, and the two ways out —
 * choose a different file, or remove this one. One slim row, so the document
 * keeps the height.
 *
 * With `files` it is the same row for a document made of many: "4 images ·
 * 2.3 MB", add more, remove them all.
 *
 * Test ids: `file-info` (with `data-filename`, or `data-count` for many),
 * `change-file`, `add-files`, `remove-file`, `large-file-warning`.
 */
export default function WorkspaceFileBar({
  file,
  files,
  noun = 'file',
  onAdd,
  extra,
  onRemove,
  onReplace,
  accept = [],
  disabled = false,
}: WorkspaceFileBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { onInputChange } = useFileDrop({
    accept,
    multiple: files !== undefined,
    onFiles: (chosen) => (files !== undefined ? onAdd?.(chosen) : onReplace?.(chosen)),
  });
  const size = files ? files.reduce((sum, f) => sum + f.size, 0) : (file?.size ?? 0);
  const large = isLargeFile(size);

  if (files) {
    const nouns = `${noun}s`;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <div data-testid="file-info" data-count={files.length} className="flex min-w-0 items-center gap-2">
            <Files className="size-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
            <span className="shrink-0 font-medium text-[var(--color-text-primary)]">
              {files.length} {files.length === 1 ? noun : nouns}
            </span>
            <span className="truncate text-[var(--color-text-secondary)] max-sm:hidden">
              {formatBytes(size)}
              {extra ? ` · ${extra}` : ''}
            </span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onAdd && (
              <>
                {/* The first file input in the workspace: adds to the document. */}
                <input
                  ref={inputRef}
                  type="file"
                  accept={accept.join(',')}
                  multiple
                  className="sr-only"
                  onChange={onInputChange}
                  aria-hidden="true"
                  tabIndex={-1}
                  data-testid="add-files-input"
                />
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={disabled}
                  data-testid="add-files"
                  className="h-8 rounded-lg border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:opacity-50 md:hidden"
                >
                  Add {nouns}
                </button>
              </>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                disabled={disabled}
                aria-label={`Remove all ${nouns}`}
                data-testid="remove-file"
                className="h-8 rounded-lg border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:opacity-50"
              >
                Remove all
              </button>
            )}
          </div>
        </div>
        {large && (
          <p data-testid="large-file-warning" role="status" className="text-xs text-[var(--color-text-secondary)]">
            Large files ({formatBytes(size)} in all). Everything runs in your browser, so this may take a while and use
            significant memory — keep this tab open.
          </p>
        )}
      </div>
    );
  }
  if (!file) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <div data-testid="file-info" data-filename={file.name} className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
          <span className="truncate font-medium text-[var(--color-text-primary)]">{file.name}</span>
          <span className="shrink-0 text-[var(--color-text-muted)] max-sm:hidden">
            {formatBytes(file.size)}
            {extra ? ` · ${extra}` : ''}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onReplace && (
            <>
              {/* The first file input in the workspace is always the document's. */}
              <input
                ref={inputRef}
                type="file"
                accept={accept.join(',')}
                className="sr-only"
                onChange={onInputChange}
                aria-hidden="true"
                tabIndex={-1}
                data-testid="change-file-input"
              />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
                data-testid="change-file"
                className="h-8 rounded-lg border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:opacity-50"
              >
                Change file
              </button>
            </>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              aria-label="Remove file"
              data-testid="remove-file"
              className="flex size-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {large && (
        <p data-testid="large-file-warning" role="status" className="text-xs text-[var(--color-text-secondary)]">
          Large file ({formatBytes(file.size)}). Everything runs in your browser, so this may take a while and use
          significant memory — keep this tab open.
        </p>
      )}
    </div>
  );
}
