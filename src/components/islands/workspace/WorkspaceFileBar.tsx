import { useRef } from 'react';
import { FileText, X } from 'lucide-react';
import { useFileDrop } from '@/hooks/use-file-drop';
import { formatBytes, isLargeFile } from '@/lib/utils';

interface WorkspaceFileBarProps {
  file: File;
  /** Extra facts after the size: "3 pages". */
  extra?: string;
  /** Leave the workspace and go back to the dropzone. */
  onRemove?: () => void;
  /**
   * Offer "Change file". Called with the new file once it has passed the same
   * type and size checks as the dropzone.
   */
  onReplace?: (files: File[]) => void;
  /** MIME types "Change file" accepts. Required with `onReplace`. */
  accept?: string[];
  disabled?: boolean;
}

/**
 * The file the workspace is working on: name, size, and the two ways out —
 * choose a different file, or remove this one. One slim row, so the document
 * keeps the height.
 *
 * Test ids: `file-info` (with `data-filename`), `change-file`, `remove-file`,
 * `large-file-warning`.
 */
export default function WorkspaceFileBar({
  file,
  extra,
  onRemove,
  onReplace,
  accept = [],
  disabled = false,
}: WorkspaceFileBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { onInputChange } = useFileDrop({
    accept,
    multiple: false,
    onFiles: (files) => onReplace?.(files),
  });
  const large = isLargeFile(file.size);

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
