import { toast } from 'sonner';

/**
 * Consistent, actionable error for when a PDF fails to load — overwhelmingly
 * because it's password-protected. Instead of a dead-end "failed" toast, offer a
 * one-click deep-link to the Unlock tool. The drop zone stays in place, so the
 * user can retry after unlocking. Kept in one place so every PDF tool surfaces
 * the same wording and action.
 */
export function notifyPdfLoadError(): void {
  toast.error("Couldn't open this PDF. If it's password-protected, unlock it first.", {
    action: {
      label: 'Unlock PDF',
      onClick: () => {
        window.location.href = '/unlock-pdf';
      },
    },
    duration: 8000,
  });
}
