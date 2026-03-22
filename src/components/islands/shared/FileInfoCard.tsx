import { formatBytes } from '@/lib/utils';

interface FileInfoCardProps {
  file: File;
  extra?: string;
  onRemove?: () => void;
}

export default function FileInfoCard({ file, extra, onRemove }: FileInfoCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
      <svg className="h-6 w-6 shrink-0 text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
      <span className="truncate font-medium text-[var(--color-text-primary)]">{file.name}</span>
      <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">
        {formatBytes(file.size)}{extra ? ` · ${extra}` : ''}
      </span>
      {onRemove && (
        <button onClick={onRemove} type="button"
          className="shrink-0 rounded-lg p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-primary)]"
          aria-label="Remove file">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
