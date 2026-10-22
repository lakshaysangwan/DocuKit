import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { EncryptionInfo } from '@/lib/pdf-encryption-info';

/**
 * Pieces Protect PDF and Unlock PDF share: the show/hide toggle on a password
 * field, the stage shown in place of pages that cannot be drawn without a
 * password, a one-line caption under the page, and the "Original encryption"
 * details read from a file's own /Encrypt dictionary.
 */

export const PASSWORD_INPUT_CLASS =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 pr-10 text-sm outline-none focus:border-[var(--color-primary)]';

/** An outlined button: never one of the workspace's filled buttons. */
export const SECONDARY_BUTTON_CLASS =
  'inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50';

export function EyeToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} tabIndex={-1}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      aria-label={show ? 'Hide password' : 'Show password'}>
      {show ? (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-5 0-9.27-3.11-11-7.5a11.72 11.72 0 013.168-4.477M6.343 6.343A9.97 9.97 0 0112 5c5 0 9.27 3.11 11 7.5a11.7 11.7 0 01-4.373 5.157M6.343 6.343L3 3m3.343 3.343l2.829 2.829M17.657 17.657L21 21m-3.343-3.343l-2.829-2.829M9.172 9.172a3 3 0 004.243 4.243" />
        </svg>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      )}
    </button>
  );
}

/**
 * Fills the stage where pages would be when they cannot be drawn: a file that
 * asks for a password, or one that is not a readable PDF.
 */
export function LockedStage({
  title,
  children,
  testId = 'locked-stage',
  icon = true,
}: {
  title: string;
  children?: ReactNode;
  testId?: string;
  icon?: boolean;
}) {
  return (
    <div data-testid={testId} className="absolute inset-0 overflow-auto bg-[var(--color-background)]">
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
        {icon && (
          <span className="flex size-14 items-center justify-center rounded-full bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
            <Lock className="size-6 text-[var(--color-text-secondary)]" aria-hidden="true" />
          </span>
        )}
        <p className="text-base font-semibold text-[var(--color-text-primary)]" data-testid={`${testId}-title`}>{title}</p>
        {children}
      </div>
    </div>
  );
}

/** A fixed-height row under the page saying what the page is. */
export function StageCaption({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="flex h-14 items-center px-2 sm:h-12 sm:px-3">
      <p data-testid={testId} aria-live="polite" className="line-clamp-2 min-w-0 text-xs font-medium text-[var(--color-text-primary)] sm:text-sm">
        {children}
      </p>
    </div>
  );
}

const PERMISSION_NAMES: Record<string, string> = {
  print: 'print',
  printHighQuality: 'print high quality',
  copy: 'copy',
  modify: 'modify',
  annotate: 'annotate',
  fillForms: 'fill forms',
  assemble: 'assemble',
};

/** The file's encryption as its /Encrypt dictionary records it. */
export function EncryptionDetails({ encryption }: { encryption: EncryptionInfo }) {
  return (
    <div data-testid="encryption-details">
      <p className="mb-2 text-xs font-medium text-[var(--color-text-primary)]">Original encryption</p>
      {encryption.encrypted ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            <dt className="text-[var(--color-text-muted)]">Algorithm</dt>
            <dd data-testid="encryption-algorithm">{encryption.algorithm}</dd>
            {encryption.keyLength !== undefined && (
              <>
                <dt className="text-[var(--color-text-muted)]">Key length</dt>
                <dd>{encryption.keyLength}-bit</dd>
              </>
            )}
            {encryption.revision !== undefined && (
              <>
                <dt className="text-[var(--color-text-muted)]">Handler</dt>
                <dd>
                  Standard
                  {encryption.version !== undefined ? ` V${encryption.version}` : ''}
                  {` R${encryption.revision}`}
                </dd>
              </>
            )}
          </dl>
          {encryption.permissions && (
            <p className="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="encryption-allowed">
              Allowed: {Object.entries(encryption.permissions)
                .filter(([, allowed]) => allowed)
                .map(([name]) => PERMISSION_NAMES[name] ?? name)
                .join(', ') || 'nothing beyond opening the file'}
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]" data-testid="encryption-algorithm">
          This PDF is not encrypted — there is nothing to unlock.
        </p>
      )}
    </div>
  );
}
